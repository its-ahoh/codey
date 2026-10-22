import { createComputerCapture } from './computer-capture'
import { createComputerBridge } from './computer-bridge'
import { computerCommands } from './computer-commands'
import { loadComputerDriverSdk } from './computer-driver-sdk'
import { app, dialog, ipcMain, systemPreferences, desktopCapturer } from 'electron'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { ComputerControl, computerManifest, validateComputerApps, type ComputerControlState, type ComputerDriver, type ComputerCommand } from './computer-control'

const exec = promisify(execFile)
const binaryPath = () => app.isPackaged
  ? join(process.resourcesPath, 'cua-driver', 'cua-driver')
  : join(app.getAppPath(), 'build', 'cua-driver', 'cua-driver')
const permissions = () => ({
  accessibility: process.platform === 'darwin' && systemPreferences.isTrustedAccessibilityClient(false),
  screenRecording: process.platform === 'darwin' && systemPreferences.getMediaAccessStatus('screen') === 'granted',
})

function createDriver(onExit: () => void): ComputerDriver {
  let host: import('@trycua/cua-driver').EmbeddedCuaDriverHostLike | undefined
  let execute: ReturnType<typeof computerCommands> | undefined
  let directory: string | undefined
  let stopped = false
  let stopping: Promise<void> | undefined
  return {
    async start(apps) {
      const sdk = await loadComputerDriverSdk()
      if (stopped) throw new Error('Computer control was stopped')
      const root = join(app.getPath('userData'), 'computer-control-runs')
      mkdirSync(root, { recursive: true, mode: 0o700 })
      directory = mkdtempSync(join(root, 'run-'))
      const manifest = join(directory, 'capabilities.json')
      writeFileSync(manifest, JSON.stringify(computerManifest(apps)), { mode: 0o600 })
      host = sdk.EmbeddedCuaDriverHost.withOptions({
        binaryPath: binaryPath(), hostBundleId: 'com.codey.mac',
        permissionMode: sdk.EmbeddedPermissionMode.Bounded,
        capabilityManifestPath: manifest, approveCapabilityManifest: true,
        approveSessionPolicy: false, dangerouslyBypassApprovals: false,
        environment: [], inheritStderr: true, noOverlay: false,
      })
      const connection = await host.start()
      if (stopped) throw new Error('Computer control was stopped')
      void host.waitForExit(connection.generation).then(() => { if (!stopped) onExit() }, () => { if (!stopped) onExit() })
      execute = computerCommands(sdk.CuaDriver.connect(connection.socketPath), apps)
    },
    async execute(command, validate) {
      if (stopped || !execute) throw new Error('Computer driver is unavailable')
      return execute(command, validate)
    },
    stop() {
      stopped = true
      return stopping ??= (async () => {
        try { await host?.stop() } finally {
          if (host && 'uniffiDestroy' in host && typeof host.uniffiDestroy === 'function') host.uniffiDestroy()
          if (directory) rmSync(directory, { recursive: true, force: true })
        }
      })()
    },
  }
}

export function createComputerControlHost(changed: (state: ComputerControlState) => void, trustedRenderer: () => Electron.WebContents | undefined) {
  const file = join(app.getPath('userData'), 'computer-control.json')
  const state = (): ComputerControlState => ({
    enabled: control.enabled, apps: control.apps, available: process.platform === 'darwin' && existsSync(binaryPath()),
    ...permissions(), active: control.active, queued: control.queued, desktop: bridge.desktop(),
  })
  const control = new ComputerControl({
    ready: () => { const p = permissions(); return existsSync(binaryPath()) && p.accessibility && p.screenRecording },
    changed: () => changed(state()),
    driver: createDriver,
    approve: async (agent, apps, signal, chatId) => {
      const result = await dialog.showMessageBox({
        type: 'question', title: 'Allow computer control?',
        message: `Allow ${agent} to read and control these apps for this task?`,
        detail: apps.map(item => `${item.name} (${item.bundleId})`).join('\n') +
          `\n\n${chatId ? `Chat: ${chatId}\n` : ''}Window content and screenshots may be sent to your selected model. Access ends with this task.`,
        buttons: ['Deny', 'Allow this task'], defaultId: 0, cancelId: 0, noLink: true, signal,
      })
      return !signal.aborted && result.response === 1
    },
  })
  const bridge = createComputerBridge(control, app.isPackaged
    ? join(process.resourcesPath, 'computer-agent-cli.cjs')
    : join(app.getAppPath(), 'electron', 'computer-agent-cli.cjs'), process.execPath, () => {
    capture?.sync(bridge.desktop())
    changed(state())
  })
  const capture = createComputerCapture({
    renderer: trustedRenderer, permitted: () => control.enabled && permissions().screenRecording,
    inspect: bridge.inspectDesktop,
    sources: () => desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: false }),
  })
  // Remember the app selection, but never enable desktop tools across restarts.
  try { control.apps = validateComputerApps(JSON.parse(readFileSync(file, 'utf8')).apps) } catch { /* first run */ }
  const wrap = (fn: (...args: any[]) => unknown) => async (event: Electron.IpcMainInvokeEvent, ...args: any[]) => {
    // Only Codey's local renderer may grant desktop access.
    if (event.sender !== trustedRenderer() || event.senderFrame !== event.sender.mainFrame) return { ok: false, error: 'Untrusted computer control request' }
    const url = event.senderFrame?.url ?? ''
    if (!url.startsWith('file://') && !( !app.isPackaged && /^http:\/\/localhost:\d+\//.test(url))) {
      return { ok: false, error: 'Untrusted computer control request' }
    }
    try { return { ok: true, data: await fn(...args) } }
    catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
  }
  ipcMain.handle('computer:status', wrap(state))
  ipcMain.handle('computer:configure', wrap(async (enabled: boolean, apps: unknown) => {
    if (typeof enabled !== 'boolean') throw new Error('Invalid computer control setting')
    await bridge.stop()
    await control.configure(enabled, apps)
    writeFileSync(file, JSON.stringify({ apps: control.apps }), { mode: 0o600 })
    return state()
  }))
  ipcMain.handle('computer:permissions', wrap(async () => {
    const sdk = await loadComputerDriverSdk()
    const p = sdk.requestMacOsPermissions()
    if (!p.screenRecording) await sdk.openMacOsScreenRecordingSettings()
    return state()
  }))
  ipcMain.handle('computer:pickApp', wrap(async () => {
    const result = await dialog.showOpenDialog({ title: 'Choose an application', defaultPath: '/Applications',
      properties: ['openFile'], filters: [{ name: 'Applications', extensions: ['app'] }] })
    if (result.canceled || !result.filePaths[0]) return null
    const path = result.filePaths[0]
    if (!path.endsWith('.app')) throw new Error('Choose an application bundle')
    const { stdout } = await exec('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', join(path, 'Contents', 'Info.plist')],
      { timeout: 5000, maxBuffer: 4096 })
    return validateComputerApps([{ bundleId: stdout.trim(), name: basename(path, '.app') }])[0]
  }))
  ipcMain.handle('computer:armStream', wrap((sessionId: string, window: string) => capture.arm(sessionId, window)))
  ipcMain.handle('computer:streamStopped', wrap((streamId: string) => capture.release(streamId)))
  ipcMain.handle('computer:handoff', wrap((sessionId: string, window: string, human: boolean, streamId: string) => {
    if (human && !capture.isActive(streamId, sessionId, window)) throw new Error('Start live view before taking control')
    if (typeof human !== 'boolean') throw new Error('Invalid control owner')
    return bridge.handoff(sessionId, window, human)
  }))
  ipcMain.handle('computer:input', wrap((sessionId: string, window: string, args: Record<string, unknown>, streamId: string, controlVersion: number) => {
    if (!capture.isActive(streamId, sessionId, window)) throw new Error('The live view has ended')
    if (!args || typeof args !== 'object' || JSON.stringify(args).length > 16384) throw new Error('Invalid input')
    const { frameAt, ...input } = args
    if (typeof frameAt !== 'number' || !Number.isFinite(frameAt)) throw new Error('A fresh video frame is required')
    return bridge.humanInput(sessionId, window, input, controlVersion, () =>
      capture.isActive(streamId, sessionId, window) && Date.now() - frameAt >= -100 && Date.now() - frameAt < 1500)
  }))
  ipcMain.handle('computer:preview', wrap(() => bridge.preview()))
  ipcMain.handle('computer:view', wrap((command: ComputerCommand) => {
    if (!command || !['windows', 'observe'].includes(command.action)) throw new Error('Invalid viewer command')
    return bridge.view(command)
  }))
  ipcMain.handle('computer:stop', wrap(async () => { await bridge.stop(); return state() }))
  let checking = false
  const monitor = setInterval(() => {
    if (checking || !control.active) return
    checking = true
    void (async () => {
      const p = permissions()
      const current = bridge.desktop()
      if (!p.accessibility || !p.screenRecording) { await bridge.stop(); return }
      if (current) {
        try { await bridge.inspectDesktop(current.sessionId, current.window) }
        catch {
          const next = bridge.desktop()
          if (next?.sessionId === current.sessionId && next.window === current.window) await bridge.stop()
        }
      }
    })().catch(() => {}).finally(() => { checking = false })
  }, 2000)
  monitor.unref()
  return { control, state, prepare: bridge.prepare,
    attachRenderer(contents: Electron.WebContents) {
      contents.session.setDisplayMediaRequestHandler((request, callback) => {
        void capture.handle(request, callback)
      }, { useSystemPicker: false })
      const revoke = () => { capture.revoke(); void bridge.stop().catch(() => {}) }
      contents.on('render-process-gone', revoke)
      contents.once('destroyed', revoke)
      contents.on('did-start-navigation', (_event, _url, _inPlace, isMainFrame) => { if (isMainFrame) revoke() })
    },
    shutdown: async () => {
      clearInterval(monitor); capture.revoke()
      await bridge.shutdown(); await control.shutdown()
    },
  }
}
