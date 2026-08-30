import { app, BrowserWindow, Menu, ipcMain, Tray, nativeImage, shell, dialog, protocol, net, globalShortcut, clipboard, Notification, systemPreferences, screen, session } from 'electron'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { captureAccelerator, screenshotAccelerator, resolveCaptureSubmit, normalizeAccelerator } from './capture'
import { hudStateCommand, hudLevelCommand, conversationToggleCommand } from './voice-hud'
import { pathToFileURL } from 'url'
import { findAvailablePort } from './portUtils'
import { clampZoom, formatZoom, zoomIn, zoomOut, DEFAULT_ZOOM } from './zoom'
import { initAutoUpdater, registerUpdaterIpc } from './updater'
import { createCoreStateStore } from './core-state'
import { decideNotification, createTurnTracker } from './chat-notifications'
import { decideAutomationNotification, findUnseenRuns, findUnnotifiedRuns } from './automation-notifications'
import { validateAutomationChatPatch, validateAutomationDraft, validateAutomationPatch } from './automation-validate'
import { applyEvent, clearAttention, summarize } from './tray-state'
import { AGENT_BINARIES, createInstalledAgentsCache, detectInstalledAgents } from './agent-detect'
import { runAgentUpdate, updatePlanFor } from './agent-update'
import { availability, createLatestVersionsCache, fetchAllLatestVersions } from './agent-latest'
import { SKILL_FILE, markSkillManagedBy, removeLegacyManagedSkills, resolveUserPath, samePath, scanClaudePluginSkills, scanSkillsDir, setSkillEnabled, uniqueSkills } from './skills'
import { isKnownPlugin, listPlugins } from './plugins'
import { validateExternalMcp, type ExternalMcpDraft } from './external-mcp'
import { scanAgentMcpServers, type AgentMcpServer, type McpAgentKey } from './agent-mcp-scan'
import { deriveDeliveryState, shouldRediscoverPr } from './delivery-status'
import type { ScannedSkill } from './skills'
import { AGENT_MEMORY, scanProjectMemory, scanUserMemory } from './memory'
import { legacySharedFilePath, renderSharedBody, sharedMemoryTargets, syncSharedMemory } from './shared-memory'
import { isMemoryType, labelFor, listStore, toMemoryItem, validateContent } from './codey-memory'
import type { MemoryStoreScope } from './codey-memory'
import { scanSkillUsage } from './skill-usage'
import type { SkillUsageMap, UsageCacheEntry } from './skill-usage'
import { BROWSER_PARTITION, BrowserController, type BrowserBounds } from './browser-controller'
import { BrowserAgentBridge, type BrowserLoginWaitEvent } from './browser-agent-bridge'
import { assertProfileName, deriveProfileNameFromFile } from './browser-profiles'
import { BrowserControlPermissionGate } from './browser-control-permission'
import { BrowserSitePermissionManager } from './browser-site-permissions'
import { canConfigureBrowserWebAuthn, configureBrowserWebAuthn, passkeyAccountLabel, type BrowserPasskeyPickerRequest } from './browser-webauthn'
import { BrowserExtensionManager } from './browser-extensions'
import { ChromeCompanionBridge } from './chrome-companion'
import { deriveEntries, parseGitFileList, walkDirectory, MAX_ENTRIES, type FileEntry } from './workspace-files'
import * as pty from 'node-pty'

protocol.registerSchemesAsPrivileged([
  { scheme: 'codey-asset', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
])
import { browserSkillStatus, checkBrowserSkillUpdate, chromeCompanionSkillStatus, checkChromeCompanionSkillUpdate, CODEY_GLOBAL_SKILLS_SUBDIR, CODEY_SKILL_DISCOVERY_SUBDIRS, CODEY_SKILLS_SUBDIR, installBrowserSkill, installChromeCompanionSkill, setChromeCompanionSkillEnabled, syncCodeyGlobalSkills, syncCodeyProjectSkills, uninstallBrowserSkill, uninstallChromeCompanionSkill, WorkerManager, WorkspaceManager } from '@codey/core'
import { listPlaybooks, playbookDetail, playbookHistory, archivePlaybook, deletePlaybook, restorePlaybook, rollbackPlaybook, promotePlaybook } from './playbooks'
import { Codey } from '@codey/gateway/dist/gateway'
import { ConfigManager } from '@codey/gateway/dist/config'
import { ApiServer } from '@codey/gateway/dist/health'
// Pure logic, no DOM and no Node builtins — shared with the Settings editor
// that renders the same dictionary, so both sides agree on what a valid entry
// is and the learner can't write a shape the editor would drop.
import { learnCorrections, mergeLearnedTerms, normalizeVocabulary, normalizePending, recordCorrections, forgetCorrection } from '../src/components/voiceVocabulary'

let mainWindow: BrowserWindow | null = null
let captureWindow: BrowserWindow | null = null
// True while a native file-picker spawned from the capture window is open.
// The picker steals focus, which would otherwise trip the blur→hide handler
// and discard the user's in-progress capture (text + chosen workspace).
let capturePickingFiles = false
let tray: Tray | null = null
let trayState: import('./tray-state').TrayStateMap = {}
let trayRebuildTimer: NodeJS.Timeout | null = null
let isQuitting = false
let inProcessGateway: Codey | null = null
const coreStateStore = createCoreStateStore((s) => sendToRenderer('core:state', s))
const turnTracker = createTurnTracker()
let workerManager: WorkerManager | null = null
let workspaceManager: WorkspaceManager | null = null
let coreConfigManager: ConfigManager | null = null
let apiServer: ApiServer | null = null
let activeApiPort: number | null = null
const browserController = new BrowserController(
  () => mainWindow,
  state => sendToRenderer('browser:state', state),
  download => sendToRenderer('browser:download', download),
  () => join(app.getPath('downloads'), 'Codey'),
  undefined,
  // Named browser profiles (saved/imported sessions) live in the app's own
  // data directory, next to the browser-control permission store.
  { getProfilesDir: () => join(app.getPath('userData'), 'browser-profiles') },
)
let browserAgentBridge: BrowserAgentBridge | null = null
let browserControlPermission: BrowserControlPermissionGate | null = null
let browserSitePermissions: BrowserSitePermissionManager | null = null
let browserExtensionManager: BrowserExtensionManager | null = null
let chromeCompanion: ChromeCompanionBridge | null = null

type TerminalSession = {
  id: string
  chatId: string
  cwd: string
  process: pty.IPty
  output: string
  alive: boolean
}

const terminalSessions = new Map<string, TerminalSession>()
const TERMINAL_REPLAY_LIMIT = 200_000

function disposeTerminalSession(sessionId: string): void {
  const session = terminalSessions.get(sessionId)
  if (!session) return
  terminalSessions.delete(sessionId)
  session.alive = false
  try { session.process.kill() } catch { /* already exited */ }
}

function runPs(args: string[]): Promise<string> {
  return new Promise(resolve => {
    void import('child_process').then(({ execFile }) => {
      execFile('/bin/ps', args, { timeout: 1500 }, (error, stdout) => resolve(error ? '' : stdout.trim()))
    }).catch(() => resolve(''))
  })
}

async function terminalSessionTitle(session: TerminalSession): Promise<string> {
  if (!session.alive) return 'Exited'
  let foregroundPid = session.process.pid
  if (process.platform !== 'win32') {
    const group = Number.parseInt(await runPs(['-o', 'tpgid=', '-p', String(session.process.pid)]), 10)
    if (Number.isInteger(group) && group > 0) foregroundPid = group
  }
  const command = process.platform === 'win32'
    ? ''
    : await runPs(['-o', 'comm=', '-p', String(foregroundPid)])
  const leaf = command.replace(/^-/, '').split('/').filter(Boolean).pop()?.trim()
  return leaf || (process.env.SHELL?.split('/').pop() ?? 'Shell')
}

async function openTerminalSession(chatId: string, cwd: string, cols: number, rows: number, requestedId?: string): Promise<{
  sessionId: string
  chatId: string
  cwd: string
  pid: number
  output: string
  alive: boolean
}> {
  if (!chatId || typeof chatId !== 'string') throw new Error('A chat is required to open a terminal')
  if (!cwd || typeof cwd !== 'string') throw new Error('A workspace directory is required to open a terminal')

  const fsMod = await import('fs')
  const stat = await fsMod.promises.stat(cwd)
  if (!stat.isDirectory()) throw new Error('Terminal working directory is not a directory')

  const sessionId = requestedId || randomUUID()
  const existing = terminalSessions.get(sessionId)
  if (existing?.alive && existing.chatId === chatId && existing.cwd === cwd) {
    try { existing.process.resize(Math.max(2, cols), Math.max(1, rows)) } catch { /* resize is best effort */ }
    return {
      sessionId,
      chatId,
      cwd: existing.cwd,
      pid: existing.process.pid,
      output: existing.output,
      alive: true,
    }
  }
  if (existing) disposeTerminalSession(sessionId)

  const shellPath = process.env.SHELL || '/bin/zsh'
  const env = Object.fromEntries(
    Object.entries({ ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' })
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  )
  const terminalProcess = pty.spawn(shellPath, ['-l'], {
    name: 'xterm-256color',
    cols: Math.max(2, cols),
    rows: Math.max(1, rows),
    cwd,
    env,
  })
  const session: TerminalSession = { id: sessionId, chatId, cwd, process: terminalProcess, output: '', alive: true }
  terminalSessions.set(sessionId, session)

  terminalProcess.onData(data => {
    if (terminalSessions.get(sessionId) !== session) return
    session.output = (session.output + data).slice(-TERMINAL_REPLAY_LIMIT)
    sendToRenderer('terminal:data', { sessionId, chatId, data })
  })
  terminalProcess.onExit(({ exitCode, signal }) => {
    if (terminalSessions.get(sessionId) !== session) return
    session.alive = false
    sendToRenderer('terminal:exit', { sessionId, chatId, exitCode, signal })
  })

  return { sessionId, chatId, cwd, pid: terminalProcess.pid, output: '', alive: true }
}

function handleBrowserLoginWait(event: BrowserLoginWaitEvent): void {
  sendToRenderer('browser:loginWait', event)
  if (event.status !== 'changed') return

  const gateway = inProcessGateway
  if (!gateway?.getChatManager().get(event.chatId)) {
    sendToRenderer('gateway-log', `[browser] cannot resume missing chat ${event.chatId}`)
    return
  }
  const continuation = 'The Codey Browser login status changed. Re-check the current page, retry the website step that was blocked by authentication, and continue the previous task. Do not repeat actions that already succeeded.'
  // sendToChat uses the normal chat semaphore. If the original agent is still
  // finishing its "waiting for login" response, this continuation queues and
  // begins only after that turn has released the chat.
  void gateway.sendToChat(event.chatId, continuation, () => { /* global listener mirrors events */ }).catch((error: any) => {
    sendToRenderer('gateway-log', `[browser] login retry failed for chat ${event.chatId}: ${error?.message ?? error}`)
  })
}

const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged
const isDistributionSmokeTest = process.argv.includes('--codey-distribution-smoke')

function browserAgentCliPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'browser-agent-cli.cjs')
    : join(app.getAppPath(), 'electron', 'browser-agent-cli.cjs')
}

function chromeCompanionExtensionPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'chrome-extension')
    : join(app.getAppPath(), '..', 'chrome-extension')
}

// Single-instance guard: a second launch (vite restart leaving a stale main
// process alive, double `npm run dev`, app.relaunch races) must not boot a
// second in-process core — the stale one already holds the API port and the
// chat-platform connections. The loser quits; the winner gets told to come
// to the foreground.
const gotInstanceLock = app.requestSingleInstanceLock()
if (!gotInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })
}

process.on('uncaughtException', (err) => {
  try { sendToRenderer('gateway-log', `[main] uncaughtException: ${err?.stack || err?.message || err}`) } catch { /* renderer gone */ }
  console.error('[main] uncaughtException:', err)
})
process.on('unhandledRejection', (reason: any) => {
  try { sendToRenderer('gateway-log', `[main] unhandledRejection: ${reason?.stack || reason?.message || reason}`) } catch { /* renderer gone */ }
  console.error('[main] unhandledRejection:', reason)
})

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 600,
    minHeight: 400,
    show: false,
    backgroundColor: '#141414',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 14 },
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Global Conversation recording lives in this renderer even when Codey
      // is behind another app. Throttling can stall MediaRecorder chunks and
      // make the stop hotkey close the capsule without producing audio.
      backgroundThrottling: false,
      // Chromium's built-in PDF viewer is a "plugin"; without this an attached
      // PDF previews as a blank frame instead of its pages.
      plugins: true,
    }
  })

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show()
    mainWindow?.focus()
  })

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173')
    mainWindow.webContents.openDevTools()
  } else {
    mainWindow.loadFile(join(__dirname, '../dist/index.html'))
  }

  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault()
      mainWindow?.hide()
    }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
    rendererReady = false
  })

  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    console.error('[main] render-process-gone:', details)
    try { sendToRenderer('gateway-log', `[main] render-process-gone: reason=${details.reason} exitCode=${details.exitCode}`) } catch { /* gone */ }
  })
  mainWindow.webContents.on('unresponsive', () => {
    console.error('[main] renderer unresponsive')
  })

  mainWindow.webContents.on('did-finish-load', () => {
    // Chromium resets the zoom factor on every navigation/reload, so re-apply
    // the saved zoom here rather than only when the config changes.
    mainWindow?.webContents.setZoomFactor(currentZoom)
    flushPendingRendererMessages()
  })
}

// ── Quick capture window ─────────────────────────────────────────────
// Best-effort MIME from a filename extension. Native file pickers hand back
// paths (no browser File.type), so the capture flow infers it here to fill the
// FileAttachment.mimeType the agent pipeline expects. Covers the common image /
// document types; anything else falls back to a generic binary type.
const CAPTURE_MIME_BY_EXT: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', svg: 'image/svg+xml', heic: 'image/heic',
  pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown',
  json: 'application/json', csv: 'text/csv',
}
function inferCaptureMimeType(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  return CAPTURE_MIME_BY_EXT[ext] ?? 'application/octet-stream'
}

// ── Voice conversation capsule ──────────────────────────────────────
// The capsule is drawn by the CodeyVoice helper (HudOverlay.swift), the same
// AppKit panel that shows dictation status. It used to be a second, Electron
// BrowserWindow; that window had to call setVisibleOnAllWorkspaces to float
// over other Spaces, which transforms the process type between UIElement and
// Foreground and knocked the user's focus out of whatever app they were in on
// the first converse hotkey press of each launch.
//
// Electron still decides *whether* a capsule appears — it is the only side that
// knows a turn came from the hotkey rather than the composer button, and the
// only side that sees the speaking phase.
let nativeConverseActive = false
let nativeDictationActive = false
// Direct Fn events originate in the Helper and are hotkey turns. Composer
// clicks override this before sending their stdin command.
let nativeConverseFromHotkey = true

function showVoiceHud(state: string) {
  sendVoiceHudCommand(hudStateCommand(state))
}

function hideVoiceHud() {
  sendVoiceHudCommand(hudStateCommand('idle'))
}

function sendVoiceHudCommand(command: string | null) {
  if (!command) return
  if (!sendVoiceHelperCommand(command)) {
    // No helper means no capsule, but it also means capture is already broken;
    // one log line beats a dialog the user cannot act on.
    sendToRenderer('gateway-log', `[voice] helper unavailable, capsule skipped: ${command}`)
  }
}

function createCaptureWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 560,
    // Initial height; the renderer reports its real content height via
    // capture:setHeight (bottom-anchored resize) so the window hugs its
    // contents — short when empty, taller only when attachments are staged.
    height: 104,
    show: false,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    fullscreenable: false,
    backgroundColor: '#141414',
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  if (isDev) {
    win.loadURL('http://localhost:5173/#/capture')
  } else {
    win.loadFile(join(__dirname, '../dist/index.html'), { hash: '/capture' })
  }
  win.on('blur', () => { if (!capturePickingFiles) win.hide() })
  win.on('closed', () => { captureWindow = null })
  return win
}

type CapturePrefillFile = { path: string; name: string; size: number }

// Show (or re-show) the capture window, anchored near the bottom-center of the
// display under the cursor, and notify the renderer via capture:shown. An
// optional prefill (e.g. a just-taken screenshot) arrives in the same event so
// the renderer can attach it as a chip. The screenshot flow always shows —
// never toggles-to-hide — which is why this is split out from toggle.
function showCaptureWindow(prefillFiles?: CapturePrefillFile[]) {
  if (!captureWindow || captureWindow.isDestroyed()) captureWindow = createCaptureWindow()
  // workArea already excludes the Dock/menu bar, so a small margin keeps the
  // window clear of the screen edge.
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  const { x, y, width, height } = display.workArea
  const [w, h] = captureWindow.getSize()
  const bottomMargin = 24
  captureWindow.setPosition(
    Math.round(x + (width - w) / 2),
    Math.round(y + height - h - bottomMargin),
  )
  captureWindow.show()
  captureWindow.focus()
  sendCaptureShown(prefillFiles)
}

// capture:shown carries the prefill payload. A freshly-created window may still
// be loading its bundle (renderer not yet subscribed), so defer the send until
// did-finish-load — plus a tick for React to mount and attach the listener —
// otherwise the prefill would be dropped on the very first hotkey press.
function sendCaptureShown(prefillFiles?: CapturePrefillFile[]) {
  const wc = captureWindow?.webContents
  if (!wc) return
  const payload = prefillFiles && prefillFiles.length > 0 ? { files: prefillFiles } : undefined
  if (wc.isLoading()) {
    wc.once('did-finish-load', () => setTimeout(() => wc.send('capture:shown', payload), 60))
  } else {
    wc.send('capture:shown', payload)
  }
}

function toggleCaptureWindow() {
  if (!captureWindow || captureWindow.isDestroyed()) captureWindow = createCaptureWindow()
  if (captureWindow.isVisible()) { captureWindow.hide(); return }
  showCaptureWindow()
}

// Grab a full-screen PNG (main display, silently) into a temp file. Returns the
// attachment descriptor, or null if the file is missing/empty — which on macOS
// usually means Screen Recording permission has not been granted.
async function captureScreenshotToTemp(): Promise<CapturePrefillFile | null> {
  const os = await import('os')
  const pathMod = await import('path')
  const fsMod = await import('fs')
  const { execFile } = await import('child_process')
  const name = `codey-screenshot-${Date.now()}.png`
  const dest = pathMod.join(os.tmpdir(), name)
  await new Promise<void>((resolve, reject) => {
    // -x: no capture sound. Captures the main display to `dest`.
    execFile('screencapture', ['-x', dest], err => (err ? reject(err) : resolve()))
  })
  let size = 0
  try { size = fsMod.statSync(dest).size } catch { return null }
  if (size === 0) return null
  return { path: dest, name, size }
}

async function triggerScreenshotCapture() {
  try {
    const shot = await captureScreenshotToTemp()
    if (!shot) {
      sendToRenderer('gateway-log', '[capture] screenshot produced no image — check Screen Recording permission')
      try {
        new Notification({
          title: 'Screenshot failed',
          body: 'Codey may need Screen Recording permission (System Settings → Privacy & Security → Screen Recording).',
          silent: true,
        }).show()
      } catch { /* best-effort */ }
      return
    }
    showCaptureWindow([shot])
  } catch (err: any) {
    sendToRenderer('gateway-log', `[capture] screenshot failed: ${err?.message ?? err}`)
  }
}

function applyUiPreferences(rawCfg: any) {
  try {
    app.setLoginItemSettings({ openAtLogin: !!rawCfg?.ui?.launchAtLogin })
  } catch (err: any) {
    sendToRenderer('gateway-log', `[ui] setLoginItemSettings failed: ${err?.message ?? err}`)
  }
  if (rawCfg?.ui?.dockless) app.dock?.hide()
  else app.dock?.show()
  applyZoom(clampZoom(rawCfg?.ui?.zoom))
}

// Zoom. Scales the main window only: Quick Capture is a fixed-width
// floater that reports its own content height in CSS px, so zooming it would
// desync that bottom-anchored resize.
let currentZoom = DEFAULT_ZOOM
function applyZoom(factor: number) {
  const changed = factor !== currentZoom
  currentZoom = factor
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.setZoomFactor(factor)
  }
  // The browser is a native view positioned from renderer CSS px, so it needs
  // the new scale to stay inside its slot.
  browserController.setZoomFactor(factor)
  if (!changed) return
  // Refresh the View menu's "Zoom: N%" readout, and keep the Settings
  // stepper in sync when the change came from the menu.
  createAppMenu()
  sendToRenderer('ui:zoom', factor)
}

/** Persist a new zoom level; applyUiPreferences pushes it to the window. */
function setZoom(factor: number) {
  const next = clampZoom(factor)
  if (!coreConfigManager) {
    applyZoom(next)
    return
  }
  coreConfigManager.update({ ui: { zoom: next } } as any)
}

let currentCaptureAccelerator: string | null = null
function applyCaptureHotkey(rawCfg: any) {
  const desired = captureAccelerator(rawCfg?.capture?.hotkey)
  if (currentCaptureAccelerator && currentCaptureAccelerator !== desired) {
    try { globalShortcut.unregister(currentCaptureAccelerator) } catch { /* not registered */ }
    currentCaptureAccelerator = null
  }
  if (!desired || currentCaptureAccelerator === desired) return
  const ok = globalShortcut.register(desired, toggleCaptureWindow)
  if (ok) {
    currentCaptureAccelerator = desired
  } else {
    sendToRenderer('gateway-log', `[capture] hotkey registration failed (in use by another app?): ${desired}`)
  }
}

let currentScreenshotAccelerator: string | null = null
function applyScreenshotHotkey(rawCfg: any) {
  const desired = screenshotAccelerator(rawCfg?.capture?.screenshotHotkey)
  if (currentScreenshotAccelerator && currentScreenshotAccelerator !== desired) {
    try { globalShortcut.unregister(currentScreenshotAccelerator) } catch { /* not registered */ }
    currentScreenshotAccelerator = null
  }
  if (!desired || currentScreenshotAccelerator === desired) return
  const ok = globalShortcut.register(desired, () => { void triggerScreenshotCapture() })
  if (ok) {
    currentScreenshotAccelerator = desired
  } else {
    sendToRenderer('gateway-log', `[capture] screenshot hotkey registration failed (in use by another app?): ${desired}`)
  }
}

// Buffer messages emitted before the renderer has finished loading so early
// boot logs (gateway-log especially) aren't silently dropped. Flushed in
// createWindow() on did-finish-load.
const pendingRendererMessages: Array<{ channel: string; args: any[] }> = []
// Also keep a separate ring buffer of recent gateway-log strings so the
// renderer can request them on mount — `did-finish-load` fires before React
// mounts and subscribes to `onLog`, so flushed events would otherwise be lost.
const recentGatewayLogs: string[] = []
let rendererReady = false
function sendToRenderer(channel: string, ...args: any[]) {
  if (channel === 'gateway-log' && typeof args[0] === 'string') {
    recentGatewayLogs.push(args[0])
    if (recentGatewayLogs.length > 500) recentGatewayLogs.shift()
  }
  if (rendererReady && mainWindow && !mainWindow.webContents.isLoading()) {
    mainWindow.webContents.send(channel, ...args)
  } else {
    pendingRendererMessages.push({ channel, args })
    if (pendingRendererMessages.length > 500) pendingRendererMessages.shift()
  }
}
// Gate for automation-run notifications: only the global notifications toggle.
// Deliberately NOT focus-gated, unlike the chat path (decideNotification via
// maybeNotify's ctx). Automations run in the background, so a finished/parked
// run is news even while the user is in the app — and a suppressed one is not
// marked seen, so it used to resurface only via the launch scan on next start,
// which read as "notifications are delayed until I restart".
function automationNotificationsAllowed(): boolean {
  return ((coreConfigManager?.get() as any)?.notifications?.enabled ?? true) as boolean
}
// Native macOS notifications for background chats. Decisions are pure
// (chat-notifications.ts); this is the impure shell: focus check, config
// read, Notification construction, click/action routing.
function maybeNotify(ev: any) {
  try {
    if (!ev || typeof ev.chatId !== 'string') return
    const enabled = ((coreConfigManager?.get() as any)?.notifications?.enabled ?? true) as boolean
    const focused = mainWindow?.isFocused() ?? false
    const chatTitle = inProcessGateway?.getChatManager().get(ev.chatId)?.title
    const decision = decideNotification(ev, { focused, enabled, chatTitle })
    const isDuplicate = turnTracker.alreadyNotified(ev.chatId)
    turnTracker.observe(ev)
    if (!decision || isDuplicate) return
    turnTracker.markNotified(decision.chatId)

    const openChat = () => {
      mainWindow?.show()
      sendToRenderer('notify:openChat', { chatId: decision.chatId })
    }
    const notif = new Notification({
      title: decision.title,
      body: decision.body,
      actions: decision.actions?.map(a => ({ type: 'button' as const, text: a.label })),
    })
    notif.on('click', openChat)
    if (decision.actions?.length) {
      notif.on('action', (_e, index) => {
        const label = decision.actions?.[index]?.label
        // Stale button (a new turn already started) or missing gateway:
        // fall back to focusing the chat instead of sending.
        if (!label || !inProcessGateway || turnTracker.isInFlight(decision.chatId)) { openChat(); return }
        const sink = () => { /* no-op: global chatEventListener mirrors to renderer */ }
        void inProcessGateway.sendToChat(decision.chatId, label, sink).catch((err: any) => {
          sendToRenderer('gateway-log', `[notify] answer send failed: ${err?.message ?? err}`)
          openChat()
        })
      })
    }
    notif.show()
  } catch (err: any) {
    try { sendToRenderer('gateway-log', `[notify] notification failed: ${err?.message ?? err}`) } catch { /* renderer gone */ }
  }
}

function flushPendingRendererMessages() {
  rendererReady = true
  if (!mainWindow) return
  for (const m of pendingRendererMessages) {
    try { mainWindow.webContents.send(m.channel, ...m.args) } catch { /* ignore */ }
  }
  pendingRendererMessages.length = 0
}

function scheduleTrayRebuild() {
  if (trayRebuildTimer) return
  trayRebuildTimer = setTimeout(() => {
    trayRebuildTimer = null
    rebuildTrayMenu()
  }, 250)
}

function openChatFromTray(chatId: string) {
  mainWindow?.show()
  mainWindow?.focus()
  trayState = clearAttention(trayState, chatId)
  sendToRenderer('notify:openChat', { chatId })
  scheduleTrayRebuild()
}

function chatLabel(chatId: string): string | null {
  try {
    const c = inProcessGateway?.getChatManager().get(chatId)
    if (!c) return null
    return `${c.title || 'Untitled'} — ${c.workspaceName}`
  } catch { return null }
}

function rebuildTrayMenu() {
  if (!tray) return
  try {
    const summary = summarize(trayState)
    const items: Electron.MenuItemConstructorOptions[] = [
      { label: summary.header, enabled: false },
    ]
    const shown = new Set<string>()
    const addChat = (id: string, prefix = '') => {
      const label = chatLabel(id)
      if (!label) return
      shown.add(id)
      items.push({ label: prefix + label, click: () => openChatFromTray(id) })
    }
    if (summary.needsAttention.length) {
      items.push({ type: 'separator' }, { label: 'Needs attention', enabled: false })
      summary.needsAttention.forEach(id => addChat(id, '● '))
    }
    if (summary.running.length) {
      items.push({ type: 'separator' }, { label: 'Running', enabled: false })
      summary.running.forEach(id => addChat(id))
    }
    try {
      const recent = (inProcessGateway?.getChatManager().list() ?? [])
        .filter((c: any) => !shown.has(c.id))
        .slice(0, 5)
      if (recent.length) {
        items.push({ type: 'separator' }, { label: 'Recent', enabled: false })
        recent.forEach((c: any) => items.push({
          label: `${c.title || 'Untitled'} — ${c.workspaceName}`,
          click: () => openChatFromTray(c.id),
        }))
      }
    } catch { /* list unavailable — skip recent section */ }
    items.push(
      { type: 'separator' },
      { label: 'Open Codey', click: () => { mainWindow?.show(); mainWindow?.focus() } },
      { label: 'Quick Capture', click: () => toggleCaptureWindow() },
      { label: 'Settings', click: () => { mainWindow?.show(); mainWindow?.focus(); sendToRenderer('notify:openSettings') } },
      { type: 'separator' },
      { label: 'Quit', click: () => { isQuitting = true; app.quit() } },
    )
    tray.setContextMenu(Menu.buildFromTemplate(items))
    tray.setToolTip(`Codey — ${summary.header}`)
  } catch (err: any) {
    sendToRenderer('gateway-log', `[tray] menu rebuild failed: ${err?.message ?? err}`)
  }
}

function createTray() {
  const trayIconPath = app.isPackaged
    ? join(process.resourcesPath, 'trayIconTemplate.png')
    : join(__dirname, '..', 'build', 'trayIconTemplate.png')
  const icon = nativeImage.createFromPath(trayIconPath)
  icon.setTemplateImage(true)
  tray = new Tray(icon)

  rebuildTrayMenu()

  tray.on('click', () => {
    mainWindow?.show()
    mainWindow?.focus()
  })
}

function resolveDataRoot(): string {
  // Dev (unpacked): use the monorepo root so the app picks up existing
  // gateway.json, workers/, and workspaces/ from the repo.
  // Packaged: use ~/.codey/ so a real gateway.json / workers / workspaces
  // directory can be edited in place.
  if (isDev) return join(__dirname, '..', '..')
  const home = app.getPath('home')
  const root = join(home, '.codey')
  try {
    const fs = require('fs')
    if (!fs.existsSync(root)) fs.mkdirSync(root, { recursive: true })
    if (!fs.existsSync(join(root, 'workers'))) fs.mkdirSync(join(root, 'workers'), { recursive: true })
    if (!fs.existsSync(join(root, 'workspaces'))) fs.mkdirSync(join(root, 'workspaces'), { recursive: true })
    // Seed bundled workers into ~/.codey/workers/ on first run
    const bundledDir = join(process.resourcesPath, 'bundled-workers')
    if (fs.existsSync(bundledDir)) {
      for (const name of fs.readdirSync(bundledDir)) {
        const dest = join(root, 'workers', name)
        if (!fs.existsSync(dest)) {
          fs.cpSync(join(bundledDir, name), dest, { recursive: true })
        }
      }
    }
  } catch { /* best-effort */ }
  return root
}

// Probing sources the user's dotfiles, which costs seconds, so the result is
// cached for the app's lifetime; the Agents tab's "Recheck" button forces a
// fresh probe. Only conclusive probes are cached — see agent-detect.ts.
const getInstalledAgents = createInstalledAgentsCache(async () =>
  detectInstalledAgents({
    spawn: (await import('child_process')).spawn,
    shell: process.env.SHELL || '/bin/zsh',
  })
)

const getLatestAgentVersions = createLatestVersionsCache(() =>
  fetchAllLatestVersions(globalThis.fetch as any)
)

/** What is installed, what is published, and whether that is an update. */
async function agentUpdateStatus(force = false) {
  const [probed, latest] = await Promise.all([
    getInstalledAgents(force),
    // The registry lookup must never take the install probe down with it: a
    // laptop offline still deserves to be told what it has installed.
    getLatestAgentVersions(force).catch(() => ({} as Record<string, string | null>)),
  ])
  const updates: Record<string, ReturnType<typeof availability>> = {}
  for (const [agent, status] of Object.entries(probed.status)) {
    if (!status?.installed) continue
    updates[agent] = availability(status.version, latest[agent])
  }
  return { status: probed.status, conclusive: probed.conclusive, updates }
}

interface SlashCommand {
  name: string
  description: string
  source: 'agent' | 'gateway' | 'skill'
}

const BUILTIN_SLASH: Record<string, SlashCommand[]> = {
  'claude-code': [
    { name: 'help', description: 'Get help with using Claude Code', source: 'agent' },
    { name: 'clear', description: 'Clear conversation history', source: 'agent' },
    { name: 'compact', description: 'Compact conversation to save context', source: 'agent' },
    { name: 'config', description: 'Configure settings', source: 'agent' },
    { name: 'cost', description: 'Show token usage and cost for this session', source: 'agent' },
    { name: 'doctor', description: 'Check the health of your Claude Code setup', source: 'agent' },
    { name: 'init', description: 'Initialize a new CLAUDE.md file', source: 'agent' },
    { name: 'login', description: 'Switch Anthropic accounts', source: 'agent' },
    { name: 'logout', description: 'Sign out from your Anthropic account', source: 'agent' },
    { name: 'model', description: 'Switch or view the current AI model', source: 'agent' },
    { name: 'resume', description: 'Resume a previous conversation', source: 'agent' },
    { name: 'review', description: 'Review a pull request', source: 'agent' },
    { name: 'run', description: 'Launch the app to see a change working', source: 'agent' },
    { name: 'security-review', description: 'Security review of pending changes', source: 'agent' },
    { name: 'code-review', description: 'Review current diff for correctness bugs', source: 'agent' },
    { name: 'verify', description: 'Verify a code change works by running the app', source: 'agent' },
    { name: 'fast', description: 'Toggle fast mode', source: 'agent' },
  ],
  'opencode': [
    { name: 'run', description: 'Run opencode with a message', source: 'agent' },
    { name: 'attach', description: 'Attach to a running opencode server', source: 'agent' },
    { name: 'serve', description: 'Start a headless opencode server', source: 'agent' },
    { name: 'web', description: 'Start opencode server and open web interface', source: 'agent' },
    { name: 'models', description: 'List all available models', source: 'agent' },
    { name: 'stats', description: 'Show token usage and cost statistics', source: 'agent' },
    { name: 'providers', description: 'Manage AI providers and credentials', source: 'agent' },
    { name: 'agent', description: 'Manage agents', source: 'agent' },
    { name: 'session', description: 'Manage sessions', source: 'agent' },
    { name: 'mcp', description: 'Manage MCP servers', source: 'agent' },
    { name: 'plugin', description: 'Install plugin and update config', source: 'agent' },
    { name: 'export', description: 'Export session data as JSON', source: 'agent' },
    { name: 'import', description: 'Import session data from JSON file or URL', source: 'agent' },
    { name: 'pr', description: 'Fetch and checkout a GitHub PR branch', source: 'agent' },
    { name: 'upgrade', description: 'Upgrade opencode to the latest version', source: 'agent' },
    { name: 'debug', description: 'Debugging and troubleshooting tools', source: 'agent' },
  ],
  'pi': [
    { name: 'model', description: 'Switch models', source: 'agent' },
    { name: 'resume', description: 'Pick from previous sessions', source: 'agent' },
    { name: 'new', description: 'Start a new session', source: 'agent' },
    { name: 'session', description: 'Show session file, id, tokens, and cost', source: 'agent' },
    { name: 'tree', description: 'Jump to any point in the session', source: 'agent' },
    { name: 'fork', description: 'Create a new session from an earlier message', source: 'agent' },
    { name: 'compact', description: 'Compact context, optionally with instructions', source: 'agent' },
    { name: 'export', description: 'Export session to HTML or JSONL', source: 'agent' },
    { name: 'share', description: 'Upload as a private gist with a shareable link', source: 'agent' },
    { name: 'settings', description: 'Thinking level, theme, message delivery', source: 'agent' },
    { name: 'trust', description: 'Save the project trust decision', source: 'agent' },
    { name: 'login', description: 'Manage OAuth or API-key credentials', source: 'agent' },
  ],
  'codex': [
    { name: 'exec', description: 'Run Codex non-interactively', source: 'agent' },
    { name: 'review', description: 'Run a code review non-interactively', source: 'agent' },
    { name: 'resume', description: 'Resume a previous interactive session', source: 'agent' },
    { name: 'fork', description: 'Fork a previous interactive session', source: 'agent' },
    { name: 'login', description: 'Manage login', source: 'agent' },
    { name: 'logout', description: 'Remove stored authentication credentials', source: 'agent' },
    { name: 'mcp', description: 'Manage external MCP servers', source: 'agent' },
    { name: 'plugin', description: 'Manage Codex plugins', source: 'agent' },
    { name: 'sandbox', description: 'Run commands within a Codex-provided sandbox', source: 'agent' },
    { name: 'apply', description: 'Apply the latest diff produced by Codex agent', source: 'agent' },
    { name: 'cloud', description: 'Browse tasks from Codex Cloud', source: 'agent' },
    { name: 'debug', description: 'Debugging tools', source: 'agent' },
    { name: 'features', description: 'Inspect feature flags', source: 'agent' },
  ],
}

const SLASH_CACHE_TTL = 60 * 60_000 // 1 hour
const slashRefreshing = new Set<string>()

function slashCachePath(agent: string): string {
  const os = require('os') as typeof import('os')
  const path = require('path') as typeof import('path')
  return path.join(os.homedir(), '.codey', `slash-commands-${agent}.json`)
}

function readSlashCache(agent: string): { commands: SlashCommand[]; ts: number } | null {
  const fs = require('fs') as typeof import('fs')
  try {
    const raw = fs.readFileSync(slashCachePath(agent), 'utf-8')
    const data = JSON.parse(raw)
    if (Array.isArray(data.commands) && typeof data.ts === 'number') return data
  } catch { /* missing or corrupt */ }
  return null
}

function writeSlashCache(agent: string, commands: SlashCommand[]): void {
  const fs = require('fs') as typeof import('fs')
  const path = require('path') as typeof import('path')
  const p = slashCachePath(agent)
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, JSON.stringify({ commands, ts: Date.now() }, null, 2))
  } catch { /* best-effort */ }
}

async function fetchSlashCommands(agent: string): Promise<SlashCommand[]> {
  const { spawn } = await import('child_process')
  const shell = process.env.SHELL || '/bin/zsh'
  const bin = AGENT_BINARIES[agent]
  if (!bin) return []

  const commands: SlashCommand[] = []

  const run = (cmd: string) => new Promise<string>(resolve => {
    const p = spawn(shell, ['-i', '-c', cmd], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    })
    let out = ''
    p.stdout.on('data', (d: Buffer) => { out += d.toString() })
    const timer = setTimeout(() => { try { p.kill() } catch {} resolve('') }, 15_000)
    p.on('close', () => { clearTimeout(timer); resolve(out) })
    p.on('error', () => { clearTimeout(timer); resolve('') })
  })

  if (agent === 'claude-code') {
    const raw = await run(`${bin} -p "List every slash command available to you. Output ONLY lines in this exact format, one per line: /name — description. No headers, no grouping, no extra text." --output-format json --max-budget-usd 0.05 2>/dev/null`)
    try {
      const parsed = JSON.parse(raw)
      const text: string = parsed.result || ''
      for (const line of text.split('\n')) {
        const m = line.match(/^\s*[-*]?\s*`?\/?(\w[\w-]*)(?:\s+<[^>]*>)?`?\s*[—–-]+\s*(.+)/)
        if (m) commands.push({ name: m[1], description: m[2].trim(), source: 'agent' })
      }
    } catch { /* parse failed */ }
  } else if (agent === 'opencode') {
    const raw = await run(`${bin} --help 2>&1`)
    for (const line of raw.split('\n')) {
      const m = line.match(/^\s+opencode\s+(\w[\w-]*)\s+(.+)/)
      if (m) commands.push({ name: m[1], description: m[2].trim(), source: 'agent' })
    }
  } else if (agent === 'codex') {
    const raw = await run(`${bin} --help 2>&1`)
    for (const line of raw.split('\n')) {
      const m = line.match(/^\s+(\w[\w-]*)\s{2,}(.+)/)
      if (m && !['help', 'Options:'].includes(m[1])) {
        commands.push({ name: m[1], description: m[2].trim(), source: 'agent' })
      }
    }
  }

  return commands
}

async function discoverSlashCommands(agent: string): Promise<SlashCommand[]> {
  // 1. Try disk cache first (instant)
  const cached = readSlashCache(agent)
  if (cached && cached.commands.length > 0) {
    if (Date.now() - cached.ts > SLASH_CACHE_TTL && !slashRefreshing.has(agent)) {
      slashRefreshing.add(agent)
      fetchSlashCommands(agent).then(cmds => {
        if (cmds.length > 0) writeSlashCache(agent, cmds)
      }).finally(() => slashRefreshing.delete(agent))
    }
    return cached.commands
  }

  // 2. Return built-in static list immediately; kick off background fetch
  const builtin = BUILTIN_SLASH[agent] ?? []
  if (!slashRefreshing.has(agent)) {
    slashRefreshing.add(agent)
    fetchSlashCommands(agent).then(cmds => {
      if (cmds.length > 0) writeSlashCache(agent, cmds)
    }).finally(() => slashRefreshing.delete(agent))
  }
  return builtin
}

function buildRuntimeConfig(json: any): any {
  // Flatten the on-disk GatewayConfigJson into the runtime GatewayConfig
  // the Codey class expects. Default agent + per-agent default model now
  // live in `fallback.order`, so we plumb `fallback` and `models` through
  // — without them, Codey's runtime view would be missing the priority
  // list entirely and `runWithFallback` would silently fall back to
  // every-enabled-agent regardless of user configuration.
  return {
    port: json?.gateway?.port,
    defaultAgent: json?.fallback?.order?.[0]?.agent ?? 'claude-code',
    agents: json?.agents,
    models: json?.models,
    fallback: json?.fallback,
    channels: {
      telegram: json?.channels?.telegram?.enabled
        ? { botToken: json.channels.telegram.botToken }
        : undefined,
      discord: json?.channels?.discord?.enabled
        ? { botToken: json.channels.discord.botToken }
        : undefined,
      imessage: json?.channels?.imessage?.enabled ? { enabled: true } : undefined,
    },
    context: json?.context,
    memory: json?.memory,
    sharedMemory: json?.sharedMemory,
    // Back-compat: old `dispatcher` block becomes `advisor`.
    advisor: json?.advisor ?? json?.dispatcher,
    aide: json?.aide,
    // The Mac app is a secondary surface: a standalone `codey-gateway` daemon
    // (if running) owns the scheduler lease. Embedded yields to it instead of
    // racing for "who fires this automation".
    automationRole: 'embedded',
  }
}

async function bootInProcessCore() {
  coreStateStore.setBooting()
  const root = resolveDataRoot()
  try {
    coreConfigManager = new ConfigManager(join(root, 'gateway.json'))
    // Carry over an opt-in made before plugins were installed as skills: the
    // user had the Browser plugin on, so install it once rather than let the
    // capability disappear under them. From then on the skill on disk answers
    // the question and this flag is never read again.
    try {
      const [fsMod, osMod, pathMod] = await Promise.all([import('fs'), import('os'), import('path')])
      removeLegacyManagedSkills(fsMod, pathMod, osMod.homedir(), CODEY_SKILL_DISCOVERY_SUBDIRS)
      if (coreConfigManager.isPluginEnabled('browser') && browserSkillStatus().state === 'absent') {
        await installBrowserSkill()
        await syncCodeyGlobalSkills()
      }

    } catch { /* best-effort: the Plugins tab can install it by hand */ }
    workerManager = new WorkerManager(join(root, 'workers'))
    await workerManager.loadWorkers()
    // Teams are defined globally in gateway.json; the workspace just stores
    // the names it has enabled. Inject a live provider so workspace.json edits
    // never need to know about the global library shape.
    workspaceManager = new WorkspaceManager(
      workerManager,
      join(root, 'workspaces'),
      undefined,
      () => coreConfigManager?.getTeams() ?? {},
    )
    let existing = workspaceManager.listWorkspaces()
    if (existing.length === 0) {
      // Cold start (or user deleted every workspace): seed a "default"
      // workspace pointing at the user's home directory so chats can be
      // created without first picking a folder.
      const fsMod = await import('fs')
      const defaultDir = join(root, 'workspaces', 'default')
      fsMod.mkdirSync(defaultDir, { recursive: true })
      fsMod.writeFileSync(
        join(defaultDir, 'workspace.json'),
        JSON.stringify({ workingDir: app.getPath('home'), createdAt: new Date().toISOString(), teams: [] }, null, 2)
      )
      fsMod.writeFileSync(join(defaultDir, 'memory.md'), '# default — Project Memory\n')
      existing = workspaceManager.listWorkspaces()
    }
    if (existing.length > 0) {
      await workspaceManager.switchWorkspace(existing[0])
    }
    const runtimeCfg = buildRuntimeConfig(coreConfigManager.get())
    inProcessGateway = new Codey(runtimeCfg, undefined, join(root, 'workspaces'), coreConfigManager, workerManager)
    // Apply config changes to the running gateway when the renderer edits them.
    // applyConfig is async so a missing await would swallow channel-start errors.
    coreConfigManager.on('change', (updated: any) => {
      inProcessGateway?.applyConfig(buildRuntimeConfig(updated)).catch((err: any) => {
        sendToRenderer('gateway-log', `[core] applyConfig failed: ${err?.message ?? err}`)
      })
      applyVoiceHotkey(updated)
      applyVoiceConverseHotkey(updated)
      applyCaptureHotkey(updated)
      applyScreenshotHotkey(updated)
      applyUiPreferences(updated)
    })
    {
      const v = (coreConfigManager.get() as any)?.voice
      sendToRenderer('gateway-log', `[voice] config on boot: enabled=${!!v?.enabled} hotkey=${v?.hotkey ?? '(unset)'}`)
    }
    applyVoiceHotkey(coreConfigManager.get())
    applyVoiceConverseHotkey(coreConfigManager.get())
    applyCaptureHotkey(coreConfigManager.get())
    applyScreenshotHotkey(coreConfigManager.get())
    applyUiPreferences(coreConfigManager.get())
    sendToRenderer('gateway-log', `[core] In-process core booted (root: ${root}, workers: ${workerManager.getAllWorkers().length}, agent: ${runtimeCfg.defaultAgent})`)
    // Boot the gateway in the background so configured channels (telegram,
    // discord, imessage) connect. Done after returning so IPC handler
    // registration in app.whenReady() isn't blocked by network I/O
    // (e.g. Telegram setMyCommands hanging).
    void inProcessGateway.start().then(() => {
      // Launch scan: surface results fired by the daemon while the app was closed.
      // Runs only after start() resolves — automations aren't initialized until
      // the end of Codey.start(), so listAutomations()/listAutomationRuns()
      // would see nothing beforehand. Its own try/catch keeps a scan failure
      // from being mislabeled as a gateway.start failure below.
      try {
        for (const a of inProcessGateway!.listAutomations()) {
          const runs = inProcessGateway!.listAutomationRuns(a.id, 20) as any
          const unseen = findUnseenRuns(runs, Date.now())
          if (unseen.length === 0) continue
          sendToRenderer('automation-unseen', { automationId: a.id, runIds: unseen.map((r: any) => r.runId) })
          if (!automationNotificationsAllowed()) continue
          // Notify only about runs that were never announced live (e.g. fired by
          // the daemon while the app was closed) — not every unseen one.
          const fresh = findUnnotifiedRuns(runs, Date.now())
          if (fresh.length === 0) continue
          const d = decideAutomationNotification(a as any, fresh[0] as any)
          if (d) {
            new Notification({
              title: d.title,
              body: fresh.length > 1 ? `${d.body} (+${fresh.length - 1} more)` : d.body,
            }).show()
            for (const r of fresh) inProcessGateway!.markAutomationRunNotified(a.id, (r as any).runId)
          }
        }
      } catch (err: any) {
        sendToRenderer('gateway-log', `[core] automation launch scan failed: ${err?.message ?? err}`)
      }
    }).catch((err: any) => {
      sendToRenderer('gateway-log', `[core] gateway.start failed: ${err?.message ?? err}`)
    })
    // The voice helper (and any other localhost client) polls /voice/config via
    // the ApiServer. Without it, the helper falls back to the compiled-in
    // VoiceConfig defaults (provider=api, apiKey="") and ignores every change
    // made through the UI or on disk.
    try {
      const preferredPort = (coreConfigManager.get() as any)?.gateway?.port ?? 3000
      let apiPort = preferredPort
      try {
        apiPort = await findAvailablePort(preferredPort, 4000)
        if (apiPort !== preferredPort) {
          sendToRenderer('gateway-log', `[core] port ${preferredPort} in use, using ${apiPort}`)
        }
      } catch (scanErr: any) {
        sendToRenderer('gateway-log', `[core] port scan failed: ${scanErr?.message ?? scanErr}; falling back to ${preferredPort}`)
      }
      activeApiPort = apiPort
      apiServer = new ApiServer(
        apiPort,
        (): any => inProcessGateway!.getHealthStatus(),
        coreConfigManager,
        (transcript, conversationId, emit) => inProcessGateway!.runVoiceConverse(transcript, conversationId, emit),
        (text, emit, conversationId) => inProcessGateway!.runVoiceSpeak(text, emit, conversationId),
        // Fn-based converse bindings are pressed in the Swift helper, which
        // reports them over HTTP; hand them to the chat like a local press.
        forwardConverseHotkey,
        // The helper's Settings menu item used to open /config in a browser.
        // That endpoint now needs a bearer token (and always leaked every key),
        // so it asks the app to open its own settings window instead.
        () => { mainWindow?.show(); mainWindow?.focus(); sendToRenderer('notify:openSettings') },
      )
      apiServer.setVoicePolishRunner((text: string) => inProcessGateway!.runVoicePolish(text))
      void apiServer.start().then(() => {
        sendToRenderer('gateway-log', `[core] API server listening on ${apiPort}`)
      }).catch((err: any) => {
        sendToRenderer('gateway-log', `[core] ApiServer.start failed: ${err?.message ?? err}`)
      })
    } catch (err: any) {
      sendToRenderer('gateway-log', `[core] ApiServer init failed: ${err?.message ?? err}`)
    }
    // Forward all chat stream events (including those triggered by channel
    // messages on paired surfaces) to the renderer so the Mac UI stays in sync.
    inProcessGateway.setChatEventListener((ev: any) => {
      sendToRenderer('chats:event', ev)
      maybeNotify(ev)
      trayState = applyEvent(trayState, ev)
      scheduleTrayRebuild()
    })
    inProcessGateway.setPairingEventListener((ev: any) => {
      sendToRenderer('pairing:event', ev)
    })
    // Forward automation lifecycle events to the renderer, and fire an OS
    // notification for finished/parked runs whose automation opted in via
    // report.notify (decision logic lives in automation-notifications.ts).
    inProcessGateway.setAutomationEventListener((ev: any) => {
      sendToRenderer('automation-event', ev)
      if ((ev.type === 'run-finished' || ev.type === 'run-parked') && ev.run && automationNotificationsAllowed()) {
        const a = inProcessGateway?.getAutomation(ev.automationId)
        if (a) {
          const d = decideAutomationNotification(a as any, ev.run)
          if (d) {
            new Notification({ title: d.title, body: d.body }).show()
            inProcessGateway?.markAutomationRunNotified(ev.automationId, ev.runId)
          }
        }
      }
    })
    coreStateStore.setReady()
  } catch (err: any) {
    sendToRenderer('gateway-log', `[core] Boot failed: ${err?.message ?? err}`)
    coreStateStore.setFailed(err?.message ?? String(err))
  }
}

// ── Voice global hotkey ──────────────────────────────────────────────
// Converts the WhisperTab-stored format ("Meta+Shift+V", "F5") to an Electron
// accelerator string. Returns null if the binding is empty/disabled.
function toElectronAccelerator(hotkey: string | undefined): string | null {
  if (!hotkey) return null
  // Delegate to the shared, pure normalizer in capture.ts. Its `low === ''`
  // check handles Space recorded as ' ' (which trim() collapses to ''); the
  // old inline copy checked `low === ' '` *after* trim and so dropped the part,
  // producing invalid accelerators like "CommandOrControl+".
  return normalizeAccelerator(hotkey)
}

let currentConverseAccelerator: string | null = null
let voiceHotkeyCaptureActive = false
let lastConverseHotkeyForwardedAt = 0

/** Coalesce duplicate native notifications for one physical chord. */
function forwardConverseHotkey() {
  const now = Date.now()
  if (now - lastConverseHotkeyForwardedAt < 250) return
  lastConverseHotkeyForwardedAt = now
  mainWindow?.webContents.send('voice:converseHotkey')
}
/**
 * Second voice hotkey: starts (or stops) a spoken conversation in the
 * focused chat, as opposed to `voice.hotkey`, which dictates at the cursor.
 * Separate binding rather than a modifier on the first one, because the two
 * do different things with what you say and guessing wrong is annoying.
 *
 * Fn is unavailable here — the Swift helper owns it for dictation, and
 * Electron can't bind it anyway.
 */
function applyVoiceConverseHotkey(rawCfg: any) {
  const voice = rawCfg?.voice
  const hk = voice?.converseHotkey
  // Anything ending in Fn belongs to the Swift helper: globalShortcut can't
  // bind Fn with or without modifiers.
  const isFn = typeof hk === 'string' && hk.trim().toLowerCase().endsWith('fn')
  const enabled = voice?.conversationEnabled ?? voice?.enabled ?? false
  const desired = !voiceHotkeyCaptureActive && enabled && hk && !isFn ? toElectronAccelerator(hk) : null

  if (currentConverseAccelerator && currentConverseAccelerator !== desired) {
    try { globalShortcut.unregister(currentConverseAccelerator) } catch { /* not registered */ }
    currentConverseAccelerator = null
  }
  if (!desired || currentConverseAccelerator === desired) return

  const ok = globalShortcut.register(desired, () => {
    // Deliberately does NOT raise or focus the window. The feature exists for
    // times you're away from Codey; yanking it in front of whatever you're
    // doing defeats that. The floating capsule reports state instead, and the
    // user opens Codey when they actually want to read the thread.
    forwardConverseHotkey()
  })
  if (ok) {
    currentConverseAccelerator = desired
    sendToRenderer('gateway-log', `[voice] converse hotkey registered: ${desired}`)
  } else {
    sendToRenderer('gateway-log', `[voice] converse hotkey registration failed: ${desired} (likely in use by another app)`)
  }
}

let currentVoiceAccelerator: string | null = null
function applyVoiceHotkey(rawCfg: any) {
  const voice = rawCfg?.voice
  // Fn is handled exclusively by the bundled Swift helper (Electron's
  // globalShortcut can't bind Fn at all). When the user picks Fn, we don't
  // register any in-process accelerator — the helper monitors it directly.
  const hk = voice?.hotkey
  const isFn = typeof hk === 'string' && hk.trim().toLowerCase() === 'fn'
  const enabled = voice?.dictationEnabled ?? voice?.enabled ?? false
  const desired = !voiceHotkeyCaptureActive && enabled && !isFn ? toElectronAccelerator(hk) : null

  if (currentVoiceAccelerator && currentVoiceAccelerator !== desired) {
    try { globalShortcut.unregister(currentVoiceAccelerator) } catch { /* not registered */ }
    currentVoiceAccelerator = null
  }

  if (!desired || currentVoiceAccelerator === desired) {
    // Still need to (re)start the Swift helper so the renderer's
    // electron-side hotkey isn't the only path.
    void applyVoiceHelper(rawCfg)
    return
  }

  const ok = globalShortcut.register(desired, () => {
    mainWindow?.webContents.send('voice:hotkey')
  })
  if (ok) {
    currentVoiceAccelerator = desired
    sendToRenderer('gateway-log', `[voice] hotkey registered: ${desired}`)
  } else {
    sendToRenderer('gateway-log', `[voice] hotkey registration failed: ${desired} (likely in use by another app)`)
  }
  void applyVoiceHelper(rawCfg)
}

// ── Bundled Swift voice helper lifecycle ────────────────────────────
// The DMG ships CodeyVoice.app under Resources/. We spawn it whenever
// either voice action is enabled so the user gets its system-wide hotkey
// (including Fn bindings handled outside Electron)
// without any extra install steps. It runs as an LSUIElement, communicates
// with the gateway over HTTP, and is killed on app quit.
let voiceHelperProc: import('child_process').ChildProcess | null = null
let voiceHelperStarted = false
let voicePermissionPrompted = false
let voiceHelperStdoutBuffer = ''

function sendVoiceHelperCommand(command: string): boolean {
  const stdin = voiceHelperProc?.stdin
  if (!stdin || stdin.destroyed || !stdin.writable) return false
  stdin.write(`${command}\n`)
  return true
}

/**
 * The resident helper's own model load, if one is running.
 *
 * Separate from `activeVoiceWarm` (the one-shot `--warm-model` process) but
 * indistinguishable to the user: both are "the model isn't usable yet", and
 * they routinely overlap. The UI reads them merged, through
 * `currentVoiceWarm()` and the `voice:prepareChange` push below, so the
 * indicator stays up until *both* are done rather than disappearing when the
 * first one finishes.
 */
let helperModelLoad: { model: string; startedAt: number } | null = null

/** Last value pushed to the renderer, so we only emit on real transitions —
 *  re-sending "started" would restart the elapsed counter every time. */
let voicePreparingPushed = false

function syncVoicePreparing() {
  const active = activeVoiceWarm ?? helperModelLoad
  if (active && !voicePreparingPushed) {
    voicePreparingPushed = true
    sendToRenderer('voice:prepareChange', { model: active.model, startedAt: active.startedAt })
  } else if (!active && voicePreparingPushed) {
    voicePreparingPushed = false
    sendToRenderer('voice:prepareChange', null)
  }
}

function handleVoiceHelperLine(line: string) {
  // Machine-readable load markers from WhisperKitEngine.loadPipeline.
  if (line.startsWith('model:loading ')) {
    helperModelLoad = { model: line.slice('model:loading '.length).trim(), startedAt: Date.now() }
    syncVoicePreparing()
  } else if (line.startsWith('model:ready ') || line.startsWith('model:failed ')) {
    helperModelLoad = null
    syncVoicePreparing()
  }
  const marker = 'CODEY_CONVERSATION_EVENT '
  if (!line.startsWith(marker)) {
    if (line) sendToRenderer('gateway-log', `[voice-helper] ${line}`)
    return
  }
  try {
    const event = JSON.parse(line.slice(marker.length)) as { type: string; mode?: 'dictate' | 'converse'; state?: string; level?: number; text?: string; message?: string; fromHotkey?: boolean }
    const dictate = event.mode === 'dictate'
    // The helper owns this now and stamps it on every conversation event, so
    // Electron mirrors rather than tracks it. A toggle the helper declines
    // (one arriving mid-transcription) used to leave our copy stuck at false,
    // suppressing the capsule on every later hotkey turn.
    if (typeof event.fromHotkey === 'boolean') nativeConverseFromHotkey = event.fromHotkey
    if (event.type === 'state' && event.state) {
      if (dictate) {
        nativeDictationActive = event.state !== 'idle'
        mainWindow?.webContents.send('voice:nativeDictationState', event.state)
      } else {
        nativeConverseActive = event.state !== 'idle'
        // Redundant with the helper's own assertion for recording/transcribing
        // — kept so a turn started before this build's helper still gets a
        // capsule, and so idle always tears one down.
        if (nativeConverseActive && nativeConverseFromHotkey) showVoiceHud(event.state)
        else hideVoiceHud()
        mainWindow?.webContents.send('voice:nativeConverseState', event.state, nativeConverseFromHotkey)
      }
    } else if (event.type === 'level' && typeof event.level === 'number') {
      if (dictate) {
        mainWindow?.webContents.send('voice:nativeDictationLevel', event.level)
      } else {
        // Round trip: the helper reported this level, and we hand it straight
        // back for the capsule. Worth it to keep one control point for the
        // meter across both the native and browser capture paths.
        if (nativeConverseFromHotkey) sendVoiceHudCommand(hudLevelCommand(event.level))
        mainWindow?.webContents.send('voice:nativeConverseLevel', event.level)
      }
    } else if (event.type === 'transcript' && event.text) {
      // Native input is complete; playback/cancellation belongs to the
      // renderer from this point onward.
      if (dictate) {
        nativeDictationActive = false
        mainWindow?.webContents.send('voice:nativeDictationTranscript', event.text)
      } else {
        // The capsule stays up on `thinking`: the helper is done, but the turn
        // isn't — the renderer carries it through the agent run and the reply.
        nativeConverseActive = false
        mainWindow?.webContents.send('voice:nativeConverseTranscript', event.text)
      }
    } else if (event.type === 'cancel') {
      // Esc reached the helper's global monitor while the turn was in
      // Electron's half — the window is usually not focused for a hotkey turn,
      // so its own key handler never sees the press. The helper has already
      // taken the capsule down; the renderer drops the playback.
      nativeConverseActive = false
      hideVoiceHud()
      mainWindow?.webContents.send('voice:cancelConverse')
    } else if (event.type === 'error') {
      const message = event.message || 'On-device transcription failed'
      sendToRenderer('gateway-log', `[voice] ${message}`)
      mainWindow?.webContents.send(dictate ? 'voice:nativeDictationError' : 'voice:nativeConverseError', message)
    }
  } catch (error: any) {
    sendToRenderer('gateway-log', `[voice] invalid helper event: ${error?.message ?? error}`)
  }
}

function promptForAccessibilityPermission(reason: string) {
  if (voicePermissionPrompted) return
  voicePermissionPrompted = true
  // isTrustedAccessibilityClient(true) shows the system "add app to Accessibility" prompt
  // automatically. We also pop our own dialog with a direct link in case the user dismissed
  // it or wants to know why.
  const trusted = systemPreferences.isTrustedAccessibilityClient(true)
  if (trusted) return
  dialog.showMessageBox({
    type: 'warning',
    buttons: ['Open System Settings', 'Later'],
    defaultId: 0,
    cancelId: 1,
    title: 'Accessibility permission required',
    message: 'Codey needs Accessibility access to use the voice hotkey.',
    detail: `${reason}\n\nIn System Settings → Privacy & Security → Accessibility, enable Codey (or Electron in dev mode). Then restart Codey for the change to take effect.`,
  }).then(res => {
    if (res.response === 0) {
      shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility')
    }
  }).catch(() => { /* ignore */ })
}

function resolveVoiceHelperBinary(): string | null {
  const path = require('path') as typeof import('path')
  const fs = require('fs') as typeof import('fs')
  // Helper is shipped as a sibling Mach-O binary (not a nested .app). TCC
  // attributes permission prompts to the parent Codey.app, so the user only
  // ever has to grant Microphone + Accessibility to "Codey" once.
  const candidates = app.isPackaged
    ? [path.join(process.resourcesPath, 'CodeyVoice')]
    : [
        path.join(__dirname, '..', '..', 'voice', 'CodeyVoice'),
        path.join(__dirname, '..', '..', 'voice', '.build', 'release', 'CodeyVoice'),
      ]
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c } catch { /* ignore */ }
  }
  return null
}

async function transcribeChromeVoiceLocally(data: Buffer, voice: any): Promise<string> {
  const bin = resolveVoiceHelperBinary()
  if (!bin) throw new Error('CodeyVoice helper binary was not found')
  const fs = require('fs') as typeof import('fs')
  const os = require('os') as typeof import('os')
  const path = require('path') as typeof import('path')
  const { spawn } = require('child_process') as typeof import('child_process')
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-chrome-voice-'))
  const audioPath = path.join(tempDir, 'recording.wav')
  fs.writeFileSync(audioPath, data)
  try {
    const args = ['--transcribe-file', audioPath]
    if (voice.language && voice.language !== 'auto') args.push('--lang', voice.language)
    if (voice.localModel) args.push('--model', voice.localModel)
    const vocabulary = normalizeVocabulary(voice.vocabulary)
    if (vocabulary.length) args.push('--vocab', vocabulary.join(','))
    return await new Promise<string>((resolve, reject) => {
      const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = ''
      let stderr = ''
      const timeout = setTimeout(() => {
        proc.kill()
        reject(new Error('Local transcription timed out'))
      }, 5 * 60_000)
      proc.stdout?.on('data', chunk => { stdout += String(chunk) })
      proc.stderr?.on('data', chunk => { stderr += String(chunk) })
      proc.on('error', error => {
        clearTimeout(timeout)
        reject(error)
      })
      proc.on('close', code => {
        clearTimeout(timeout)
        const match = stdout.match(/transcribe-file:result \[([\s\S]*?)\](?:\r?\n|$)/)
        if (code === 0 && match) resolve(match[1].trim())
        else {
          const detail = stdout.match(/transcribe-file:error (.+)/)?.[1] || stderr.trim() || `CodeyVoice exited with status ${code}`
          reject(new Error(detail.slice(0, 500)))
        }
      })
    })
  } finally {
    try { fs.rmSync(tempDir, { recursive: true, force: true }) } catch { /* temporary recording is best-effort cleanup */ }
  }
}

// Warm marker file: records which WhisperKit variants have already gone through
// the one-time CoreML per-machine compile. Lets the UI distinguish "downloaded"
// (✓, first Fn press takes 30-90s) from "warmed" (⚡, instant).
function warmMarkerPath(): string {
  const path = require('path') as typeof import('path')
  return path.join(app.getPath('userData'), 'voice-warm.json')
}

// The macOS build (e.g. "23F79") the warm marker was stamped under. CoreML
// rebuilds its per-machine compiled model cache on an OS update, so a marker
// written before the bump is stale: the model is still on disk but the next
// load recompiles from scratch (30-90s, and trips the helper's 10s load
// timeout). Keying markers on the build lets us downgrade ⚡→✓ after an OS
// change instead of lying about "instant".
let _osBuildCache: string | null = null
function currentOsBuild(): string {
  if (_osBuildCache !== null) return _osBuildCache
  try {
    const cp = require('child_process') as typeof import('child_process')
    _osBuildCache = cp.execSync('sw_vers -buildVersion', { encoding: 'utf8' }).trim()
  } catch {
    // Non-macOS or sw_vers missing — fall back to the Darwin kernel string,
    // which also bumps on OS updates.
    const os = require('os') as typeof import('os')
    _osBuildCache = os.release()
  }
  return _osBuildCache || ''
}

// WhisperKit model folders currently on disk. WhisperKit stores downloaded
// variants under ~/Documents/huggingface/models/argmaxinc/whisperkit-coreml/.
// Raw folder names are returned so callers can match either the bare variant
// or the full openai_whisper-<variant> form used in the UI dropdown.
function listDownloadedVoiceModels(): string[] {
  const fsMod = require('fs') as typeof import('fs')
  const pathMod = require('path') as typeof import('path')
  const home = app.getPath('home')
  const candidates = [
    pathMod.join(home, 'Documents', 'huggingface', 'models', 'argmaxinc', 'whisperkit-coreml'),
    pathMod.join(home, 'Library', 'Application Support', 'huggingface', 'models', 'argmaxinc', 'whisperkit-coreml'),
  ]
  const found = new Set<string>()
  for (const dir of candidates) {
    if (!fsMod.existsSync(dir)) continue
    for (const entry of fsMod.readdirSync(dir)) {
      const full = pathMod.join(dir, entry)
      try {
        const st = fsMod.statSync(full)
        // Only count variants that actually contain .mlmodelc payloads AND
        // each .mlmodelc has a non-empty weights/weight.bin. CoreML partial
        // downloads leave the folder + model.mil present but the weight file
        // missing or zero-byte, which causes runtime "Could not open
        // weights/weight.bin" errors and an endless warm-failure flicker in
        // the UI. Checking weights here surfaces incomplete downloads as "not
        // downloaded" so the user gets a Download button instead of a
        // confusing warm error.
        if (!st.isDirectory()) continue
        const mlmodelcs = fsMod.readdirSync(full).filter(f => f.endsWith('.mlmodelc'))
        if (mlmodelcs.length === 0) continue
        const allWeightsOK = mlmodelcs.every(mc => {
          const w = pathMod.join(full, mc, 'weights', 'weight.bin')
          try {
            const ws = fsMod.statSync(w)
            return ws.isFile() && ws.size > 1024  // any real Whisper weight blob is MBs
          } catch { return false }
        })
        if (allWeightsOK) found.add(entry)
      } catch { /* skip */ }
    }
  }
  return Array.from(found)
}

/** Match a UI model value against a folder list, tolerating either name form. */
function voiceModelInList(list: string[], modelValue: string): boolean {
  if (list.length === 0) return false
  const bare = modelValue.startsWith('openai_whisper-')
    ? modelValue.slice('openai_whisper-'.length)
    : modelValue
  return list.some(d => d === modelValue || d === bare || d === `openai_whisper-${bare}`)
}

/**
 * Force a WhisperKit variant through CoreML's one-time per-machine compile by
 * spawning the helper in `--warm-model` mode. Afterwards the model loads in
 * ~200ms on an Fn press instead of 30-90s (which would blow past the helper's
 * 10s load timeout and leave the UI stuck on "transcribing").
 */
async function runVoiceModelWarm(modelName: string): Promise<{ model: string; loadSeconds: number }> {
  if (process.platform !== 'darwin') throw new Error('Voice helper is macOS-only')
  if (typeof modelName !== 'string' || !modelName.trim()) throw new Error('Model name required')
  const bin = resolveVoiceHelperBinary()
  if (!bin) throw new Error('Voice helper binary not found')

  const { spawn } = require('child_process') as typeof import('child_process')
  const proc = spawn(bin, ['--warm-model', modelName], { stdio: ['ignore', 'pipe', 'pipe'] })

  let lastErr = ''
  let loadSeconds = 0
  activeVoiceWarm = { model: modelName, startedAt: Date.now() }
  syncVoicePreparing()
  sendToRenderer('voice:warmStart', { model: modelName })

  const onLine = (line: string) => {
    const s = line.trim()
    if (!s) return
    sendToRenderer('gateway-log', `[voice-warm] ${s}`)
    if (s.startsWith('warm:done ')) {
      loadSeconds = parseFloat(s.slice('warm:done '.length)) || 0
    } else if (s.startsWith('warm:error ')) {
      lastErr = s.slice('warm:error '.length)
    }
  }
  const wireLines = (stream: NodeJS.ReadableStream | null) => {
    if (!stream) return
    let buf = ''
    stream.on('data', (chunk: Buffer) => {
      buf += chunk.toString()
      let idx: number
      while ((idx = buf.indexOf('\n')) >= 0) {
        onLine(buf.slice(0, idx))
        buf = buf.slice(idx + 1)
      }
    })
    stream.on('end', () => { if (buf) onLine(buf) })
  }
  wireLines(proc.stdout)
  wireLines(proc.stderr)

  const code: number = await new Promise(resolve => proc.on('exit', c => resolve(c ?? 1)))
  activeVoiceWarm = null
  syncVoicePreparing()
  if (code !== 0) {
    sendToRenderer('voice:warmError', { model: modelName, error: lastErr || `Warm failed (exit ${code})` })
    throw new Error(lastErr || `Warm failed (exit ${code})`)
  }
  writeWarmMarker(modelName, loadSeconds)
  sendToRenderer('voice:warmDone', { model: modelName, loadSeconds })
  return { model: modelName, loadSeconds }
}

/** Guards against a second startup warm while the first is still running. */
let startupWarmInFlight = false

/**
 * The warm currently running, if any.
 *
 * Pushed to the renderer as events, but also held here so a window that mounts
 * *during* a warm can ask. The startup warm begins before the renderer is
 * ready and runs for minutes, so "I missed the start event" is the normal
 * case, not the edge case.
 */
let activeVoiceWarm: { model: string; startedAt: number } | null = null

export function currentVoiceWarm(): { model: string; startedAt: number } | null {
  // Whichever started first is the one the elapsed counter should reflect: it
  // is the wait the user has actually been sitting through.
  if (activeVoiceWarm && helperModelLoad) {
    return activeVoiceWarm.startedAt <= helperModelLoad.startedAt ? activeVoiceWarm : helperModelLoad
  }
  return activeVoiceWarm ?? helperModelLoad
}

/**
 * On launch, make sure the selected on-device model is actually ready.
 *
 * Warming used to happen only from the Whisper settings tab, so a user who
 * never opened it — or who updated macOS, which invalidates CoreML's compiled
 * cache — paid a 30-90s compile on their first Fn press. That exceeds the
 * helper's 10s load timeout, and the failure looks like a hung "transcribing"
 * with every further press ignored. Checking here means the cost is paid in
 * the background at launch, when nobody is waiting on it.
 *
 * Best-effort throughout: a failure here must never block startup, and the
 * first press still works (just slowly), so errors are logged and swallowed.
 */
async function warmSelectedVoiceModelOnStartup(): Promise<void> {
  if (process.platform !== 'darwin') return
  if (startupWarmInFlight) return
  try {
    const voice = (coreConfigManager?.get() as any)?.voice
    if (!voice?.enabled) return
    if (voice.provider !== 'local') return
    const model = String(voice.localModel ?? '')
    if (!model) return

    // Nothing to warm if the weights aren't on disk — that is a Download
    // button in Settings, not something to kick off unasked at launch.
    if (!voiceModelInList(listDownloadedVoiceModels(), model)) {
      sendToRenderer('gateway-log', `[voice-warm] ${model} not downloaded, skipping startup warm`)
      return
    }
    // Both the OS build and the helper binary are part of the key, so an OS
    // update or an app update correctly reads as "not warmed" and we recompile
    // here rather than trusting a stale marker and ambushing the first press.
    if (voiceModelInList(warmedVoiceModels(), model)) return

    startupWarmInFlight = true
    sendToRenderer('gateway-log', `[voice-warm] warming ${model} at startup`)
    await runVoiceModelWarm(model)
  } catch (e: any) {
    sendToRenderer('gateway-log', `[voice-warm] startup warm failed: ${e?.message ?? e}`)
  } finally {
    startupWarmInFlight = false
  }
}

/**
 * Identity of the helper binary the warm was performed with.
 *
 * CoreML's compiled Neural Engine cache is keyed on the client binary, so a
 * new build of the helper invalidates it and the next load pays a full
 * recompile (measured at ~320s). The warm marker used to record only the OS
 * build, which meant an app update looked "already warmed", the startup warm
 * skipped, and the recompile landed on the user's first Fn press instead —
 * exactly the case this whole mechanism exists to prevent.
 *
 * Size + mtime rather than a content hash: the binary is tens of MB, this runs
 * on every launch, and being conservative (re-warming after a reinstall that
 * happened to produce identical bytes) is far cheaper than being wrong.
 */
function currentHelperId(): string {
  try {
    const fs = require('fs') as typeof import('fs')
    const bin = resolveVoiceHelperBinary()
    if (!bin) return ''
    const st = fs.statSync(bin)
    return `${st.size}-${Math.floor(st.mtimeMs)}`
  } catch { return '' }
}

type WarmMarkers = Record<string, { warmedAt: string; loadSeconds: number; osBuild?: string; helperId?: string }>

/**
 * Variants whose warm still applies: same OS build *and* same helper binary.
 * A marker missing either field predates that key and is treated as stale,
 * which costs one re-warm and then settles.
 */
function warmedVoiceModels(): string[] {
  const build = currentOsBuild()
  const helperId = currentHelperId()
  const markers = readWarmMarkers()
  return Object.keys(markers).filter(k => {
    const m = markers[k]
    return m?.osBuild === build && m?.helperId === helperId
  })
}

function readWarmMarkers(): WarmMarkers {
  try {
    const fs = require('fs') as typeof import('fs')
    const p = warmMarkerPath()
    if (!fs.existsSync(p)) return {}
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'))
    return (raw && typeof raw === 'object') ? raw : {}
  } catch { return {} }
}

function writeWarmMarker(model: string, loadSeconds: number) {
  try {
    const fs = require('fs') as typeof import('fs')
    const cur = readWarmMarkers()
    // Store under both forms so lookups work whether UI sends the prefixed
    // (`openai_whisper-...`) or bare (`large-v3...`) variant string.
    const bare = model.startsWith('openai_whisper-') ? model.slice('openai_whisper-'.length) : model
    const entry = { warmedAt: new Date().toISOString(), loadSeconds, osBuild: currentOsBuild(), helperId: currentHelperId() }
    cur[model] = entry
    cur[bare] = entry
    cur[`openai_whisper-${bare}`] = entry
    fs.writeFileSync(warmMarkerPath(), JSON.stringify(cur, null, 2))
  } catch (e) {
    console.warn('writeWarmMarker failed:', e)
  }
}

function stopVoiceHelper() {
  if (voiceHelperProc && !voiceHelperProc.killed) {
    try { voiceHelperProc.kill() } catch { /* already gone */ }
  }
  voiceHelperProc = null
  voiceHelperStarted = false
  voiceHelperStdoutBuffer = ''
  nativeConverseActive = false
  nativeDictationActive = false
  hideVoiceHud()
}

/**
 * Request microphone access from the parent Codey.app bundle. The voice
 * helper is a sibling Mach-O without a bundle identity, so AVCaptureDevice
 * calls from inside it get silently denied by TCC (peak=0.0000 audio). Asking
 * here, in the Electron main process (which IS Codey.app), pops the real
 * system dialog with the bundle's NSMicrophoneUsageDescription. Once granted,
 * spawned children inherit access via the TCC responsible-process chain.
 */
async function ensureMicrophoneAccess(): Promise<boolean> {
  if (process.platform !== 'darwin') return true
  const status = systemPreferences.getMediaAccessStatus('microphone')
  if (status === 'granted') return true
  if (status === 'denied' || status === 'restricted') {
    sendToRenderer('gateway-log', `[voice] microphone access ${status} — open System Settings → Privacy & Security → Microphone and enable Codey`)
    dialog.showMessageBox({
      type: 'warning',
      buttons: ['Open System Settings', 'Later'],
      defaultId: 0,
      cancelId: 1,
      title: 'Microphone permission required',
      message: 'Codey needs microphone access to transcribe voice input.',
      detail: 'Open System Settings → Privacy & Security → Microphone, enable Codey, then toggle voice off and on again.',
    }).then(res => {
      if (res.response === 0) {
        shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone')
      }
    }).catch(() => { /* ignore */ })
    return false
  }
  // not-determined → triggers the system prompt attributed to Codey.app
  const granted = await systemPreferences.askForMediaAccess('microphone')
  sendToRenderer('gateway-log', `[voice] microphone access request: ${granted ? 'granted' : 'denied'}`)
  return granted
}

async function applyVoiceHelper(rawCfg: any) {
  if (process.platform !== 'darwin') return
  const voice = rawCfg?.voice
  const dictationEnabled = voice?.dictationEnabled ?? voice?.enabled ?? false
  const conversationEnabled = voice?.conversationEnabled ?? voice?.enabled ?? false
  // Hotkey switches do not disable the composer buttons. Keep the Helper
  // available for their shared on-device WhisperKit path even when both
  // global bindings are turned off.
  const enabled = !voiceHotkeyCaptureActive
    && (dictationEnabled || conversationEnabled || voice?.provider === 'local')
  if (!enabled) {
    if (voiceHelperStarted) sendToRenderer('gateway-log', `[voice] disabled — stopping helper`)
    stopVoiceHelper()
    return
  }
  if (voiceHelperStarted && voiceHelperProc && !voiceHelperProc.killed) return

  const micOk = await ensureMicrophoneAccess()
  if (!micOk) {
    sendToRenderer('gateway-log', `[voice] aborting helper spawn — microphone access not granted`)
    return
  }

  const bin = resolveVoiceHelperBinary()
  if (!bin) {
    const expected = app.isPackaged
      ? `${process.resourcesPath}/CodeyVoice`
      : `voice/CodeyVoice or voice/.build/release/CodeyVoice (run: cd voice && make helper)`
    sendToRenderer('gateway-log', `[voice] helper binary not found — expected at ${expected}`)
    dialog.showMessageBox({
      type: 'warning',
      buttons: ['OK'],
      title: 'Voice helper missing',
      message: 'The CodeyVoice helper binary was not found.',
      detail: app.isPackaged
        ? `Expected at: ${expected}\n\nThis usually means the DMG was built without the bundled helper. Reinstall Codey.`
        : `Expected at: ${expected}\n\nIn dev mode, run:\n  cd voice && make download-model && make helper\n\nThen restart Codey.`,
    }).catch(() => { /* ignore */ })
    return
  }

  // Helper binary needs Accessibility to monitor Fn / inject text. Surface
  // the system prompt now rather than silently failing on hotkey press.
  const isFn = (rawCfg?.voice?.hotkey ?? '').toString().trim().toLowerCase() === 'fn'
  if (isFn) {
    promptForAccessibilityPermission('The Fn key can only be monitored by the helper after Accessibility access is granted.')
  }
  try {
    const { spawn } = require('child_process') as typeof import('child_process')
    const port = activeApiPort ?? (coreConfigManager?.get() as any)?.gateway?.port ?? 3000
    voiceHelperProc = spawn(bin, ['--gateway-port', String(port)], {
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: false,
    })
    voiceHelperStarted = true
    voiceHelperProc.stdout?.on('data', d => {
      voiceHelperStdoutBuffer += d.toString()
      const lines = voiceHelperStdoutBuffer.split(/\r?\n/)
      voiceHelperStdoutBuffer = lines.pop() ?? ''
      lines.forEach(handleVoiceHelperLine)
    })
    voiceHelperProc.stderr?.on('data', d => sendToRenderer('gateway-log', `[voice-helper] ${d.toString().trimEnd()}`))
    voiceHelperProc.on('exit', code => {
      sendToRenderer('gateway-log', `[voice-helper] exited (code ${code})`)
      helperModelLoad = null
      syncVoicePreparing()
      voiceHelperProc = null
      voiceHelperStarted = false
      nativeConverseActive = false
      nativeDictationActive = false
      hideVoiceHud()
    })
    sendToRenderer('gateway-log', `[voice] helper started: ${bin}`)
  } catch (err: any) {
    sendToRenderer('gateway-log', `[voice] helper spawn failed: ${err?.message ?? err}`)
    voiceHelperProc = null
    voiceHelperStarted = false
  }
}

type IpcResult<T> = { ok: true; data: T } | { ok: false; error: string }

async function wrap<T>(fn: () => Promise<T>): Promise<IpcResult<T>> {
  try { return { ok: true, data: await fn() } }
  catch (e: any) { return { ok: false, error: e?.message ?? String(e) } }
}

const supportedEditors = [
  { id: 'vscode', name: 'Visual Studio Code', app: 'Visual Studio Code.app' },
  { id: 'cursor', name: 'Cursor', app: 'Cursor.app' },
  { id: 'windsurf', name: 'Windsurf', app: 'Windsurf.app' },
  { id: 'zed', name: 'Zed', app: 'Zed.app' },
  { id: 'sublime', name: 'Sublime Text', app: 'Sublime Text.app' },
  { id: 'nova', name: 'Nova', app: 'Nova.app' },
  { id: 'xcode', name: 'Xcode', app: 'Xcode.app' },
] as const

async function findEditorApp(editor: typeof supportedEditors[number]): Promise<string | null> {
  const fsMod = await import('fs')
  const candidates = [join('/Applications', editor.app), join(app.getPath('home'), 'Applications', editor.app)]
  return candidates.find(candidate => fsMod.existsSync(candidate)) ?? null
}

function createAppMenu() {
  // Minimal Mac menu so Cmd+Q, Cmd+W, Cmd+R, Cmd+Option+I etc. work.
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { label: 'Quit Codey', accelerator: 'Cmd+Q', click: () => { isQuitting = true; app.quit() } },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { label: `Zoom: ${formatZoom(currentZoom)}`, enabled: false },
        { label: 'Zoom In', accelerator: 'CommandOrControl+Plus', click: () => setZoom(zoomIn(currentZoom)) },
        // Same action on the unshifted key, so ⌘= works like it does elsewhere
        // on macOS. Hidden because one accelerator per menu item is displayable.
        { label: 'Zoom In', accelerator: 'CommandOrControl+=', visible: false, click: () => setZoom(zoomIn(currentZoom)) },
        { label: 'Zoom Out', accelerator: 'CommandOrControl+-', click: () => setZoom(zoomOut(currentZoom)) },
        { label: 'Actual Size', accelerator: 'CommandOrControl+0', click: () => setZoom(DEFAULT_ZOOM) },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

async function pickBrowserPasskey(request: BrowserPasskeyPickerRequest): Promise<string | null> {
  const buttons = request.accounts.map((account, index) => passkeyAccountLabel(account, index).slice(0, 100))
  const cancelId = buttons.length
  const options: Electron.MessageBoxOptions = {
    type: 'question',
    title: 'Choose a passkey',
    message: `Choose a passkey for ${request.relyingPartyId}`,
    detail: 'Codey will ask macOS to confirm your identity with Touch ID.',
    buttons: [...buttons, 'Cancel'],
    defaultId: 0,
    cancelId,
    noLink: true,
  }
  const result = mainWindow && !mainWindow.isDestroyed()
    ? await dialog.showMessageBox(mainWindow, options)
    : await dialog.showMessageBox(options)
  return result.response >= 0 && result.response < request.accounts.length
    ? request.accounts[result.response].credentialId
    : null
}

app.whenReady().then(async () => {
  if (isDistributionSmokeTest) {
    console.log('CODEY_DIST_SMOKE_OK')
    app.quit()
    return
  }

  // Global Codey skills live in ~/.codey/skills regardless of where the rest
  // of the data root sits, so the folder exists (and is linked into every
  // agent's discovery path) before the first agent run.
  try {
    const fsMod = await import('fs')
    const osMod = await import('os')
    const pathMod = await import('path')
    await fsMod.promises.mkdir(pathMod.join(osMod.homedir(), CODEY_GLOBAL_SKILLS_SUBDIR), { recursive: true })
    await syncCodeyGlobalSkills()
  } catch { /* best-effort: skills stay listed even if linking fails */ }

  const browserSession = session.fromPartition(BROWSER_PARTITION, { cache: true })
  browserSitePermissions = new BrowserSitePermissionManager(
    join(app.getPath('userData'), 'browser-site-permissions.json'),
    state => sendToRenderer('browser:sitePermission', state),
  )
  browserController.setSitePermissionManager(browserSitePermissions)
  browserExtensionManager = new BrowserExtensionManager(
    browserSession,
    join(app.getPath('userData'), 'browser-extensions.json'),
  )
  try {
    await browserExtensionManager.initialize()
  } catch (error) {
    console.warn(`[browser] extensions unavailable: ${error instanceof Error ? error.message : String(error)}`)
  }
  const chromeWorkspaceName = () => {
    if (!workspaceManager) throw new Error('Codey is still starting — try again in a moment')
    const name = workspaceManager.getCurrentWorkspace() || workspaceManager.listWorkspaces()[0]
    if (!name) throw new Error('Create a Codey workspace before chatting from Chrome')
    return name
  }
  const chromeChat = async (chatId: string) => {
    if (!inProcessGateway) throw new Error('Codey is still starting — try again in a moment')
    const chat = await inProcessGateway.getChat(chatId)
    if (chat.workspaceName !== chromeWorkspaceName() || chat.kind === 'automation') {
      throw new Error('This chat is not available in the current workspace')
    }
    return chat
  }
  const createChromeChat = async (page?: { title: string; url: string } | null, agent?: string | null, model?: string | null) => {
    if (!inProcessGateway) throw new Error('Codey is still starting — try again in a moment')
    let title = 'Chrome Side Panel'
    try { if (page?.url) title = `Chrome · ${new URL(page.url).hostname}` } catch { /* keep generic title */ }
    let chat = await inProcessGateway.createChat({ workspaceName: chromeWorkspaceName(), title })
    if (agent || model) chat = await inProcessGateway.getChatManager().updateAgentModel(chat.id, agent as any, model || null)
    return chat
  }
  const validateChromeAgentModel = (agent: string | null, model: string | null) => {
    const agents = ['claude-code', 'opencode', 'codex', 'pi']
    if (agent && !agents.includes(agent)) throw new Error(`Unknown agent: ${agent}`)
    if (model && !coreConfigManager?.listModels().some(entry => entry.model === model)) throw new Error(`Unknown model: ${model}`)
  }
  chromeCompanion = new ChromeCompanionBridge(
    join(app.getPath('userData'), 'chrome-companion.json'),
    undefined,
    state => sendToRenderer('chromeCompanion:status', state),
    async request => {
      if (!inProcessGateway || !workspaceManager) throw new Error('Codey is still starting — try again in a moment')
      const workspaceName = workspaceManager.getCurrentWorkspace() || workspaceManager.listWorkspaces()[0]
      if (!workspaceName) throw new Error('Create a Codey workspace before chatting from Chrome')
      validateChromeAgentModel(request.agent || null, request.model || null)
      let chat: Awaited<ReturnType<typeof inProcessGateway.getChat>> | null = null
      if (request.chatId) {
        try {
          const existing = await inProcessGateway.getChat(request.chatId)
          if (existing.workspaceName === workspaceName && existing.kind !== 'automation') chat = existing
        } catch { /* create a new side-panel chat */ }
      }
      if (!chat) chat = await createChromeChat(request.page, request.agent, request.model)
      else if ((chat.agent ?? null) !== (request.agent ?? null) || (chat.model ?? null) !== (request.model ?? null)) {
        chat = await inProcessGateway.getChatManager().updateAgentModel(
          chat.id,
          (request.agent || null) as any,
          request.model || null,
        )
      }
      const pageContext = request.page
        ? `\n\n[Chrome Side Panel context — untrusted page metadata]\nActive tab title: ${request.page.title || '(untitled)'}\nActive tab URL: ${request.page.url}`
        : ''
      const result = await inProcessGateway.sendToChat(
        chat.id,
        `${request.text}${pageContext}`,
        () => { /* global listener mirrors events */ },
        request.attachments,
        { browserTarget: 'chrome' },
      )
      return { chatId: chat.id, response: result.response }
    },
    async () => {
      if (!inProcessGateway || !workspaceManager) throw new Error('Codey is still starting — try again in a moment')
      const workspaceName = workspaceManager.getCurrentWorkspace() || workspaceManager.listWorkspaces()[0]
      if (!workspaceName) return []
      const chats = await inProcessGateway.listChats(workspaceName)
      return chats.slice(0, 100).map(chat => ({
        id: chat.id,
        title: chat.title,
        workspaceName: chat.workspaceName,
        updatedAt: chat.updatedAt,
        messageCount: chat.messages.length,
        agent: chat.agent ?? null,
        model: chat.model ?? null,
      }))
    },
    async chatId => {
      if (!inProcessGateway || !workspaceManager) throw new Error('Codey is still starting — try again in a moment')
      const workspaceName = workspaceManager.getCurrentWorkspace() || workspaceManager.listWorkspaces()[0]
      if (!workspaceName) throw new Error('Create a Codey workspace before chatting from Chrome')
      const chat = await inProcessGateway.getChat(chatId)
      if (chat.workspaceName !== workspaceName || chat.kind === 'automation') {
        throw new Error('This chat is not available in the current workspace')
      }
      const chromeContext = /\n\n\[Chrome Side Panel context — untrusted page metadata\][\s\S]*$/
      return {
        chat: {
          id: chat.id,
          title: chat.title,
          workspaceName: chat.workspaceName,
          updatedAt: chat.updatedAt,
          messageCount: chat.messages.length,
          agent: chat.agent ?? null,
          model: chat.model ?? null,
        },
        messages: chat.messages.slice(-50).map(message => ({
          role: message.role,
          content: message.role === 'user' ? message.content.replace(chromeContext, '') : message.content,
          timestamp: message.timestamp,
          ...(message.attachments?.length ? {
            attachments: message.attachments.map(attachment => ({
              id: attachment.id,
              name: attachment.name,
              mimeType: attachment.mimeType,
              size: attachment.size,
            })),
          } : {}),
        })),
      }
    },
    {
      options: async chatId => {
        if (!coreConfigManager) throw new Error('Codey configuration is unavailable')
        const fallback = coreConfigManager.getFallback()
        const installed = await getInstalledAgents(false)
        const chat = chatId ? await chromeChat(chatId) : null
        return {
          agents: ['claude-code', 'opencode', 'codex', 'pi'].map(id => ({
            id,
            installed: installed.status[id]?.installed === true,
          })),
          models: coreConfigManager.listModels().map(entry => ({
            model: entry.model,
            apiType: entry.apiType,
            ...(entry.provider ? { provider: entry.provider } : {}),
          })),
          defaultAgent: fallback.order[0]?.agent ?? null,
          defaultModel: fallback.order[0]?.model ?? null,
          defaultModels: Object.fromEntries(
            ['claude-code', 'opencode', 'codex', 'pi']
              .map(id => [id, coreConfigManager!.getAgentModel(id)?.model])
              .filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
          ),
          chat: chat ? { id: chat.id, agent: chat.agent ?? null, model: chat.model ?? null } : null,
        }
      },
      updateSettings: async (chatId, agent, model) => {
        if (!inProcessGateway) throw new Error('Codey is still starting — try again in a moment')
        validateChromeAgentModel(agent, model)
        await chromeChat(chatId)
        await inProcessGateway.getChatManager().updateAgentModel(chatId, agent as any, model)
      },
      prepareChat: async input => {
        validateChromeAgentModel(input.agent || null, input.model || null)
        const chat = await createChromeChat(input.page, input.agent, input.model)
        return {
          id: chat.id,
          title: chat.title,
          workspaceName: chat.workspaceName,
          updatedAt: chat.updatedAt,
          messageCount: chat.messages.length,
          agent: chat.agent ?? null,
          model: chat.model ?? null,
        }
      },
      upload: async (chatId, name, mimeType, data) => {
        const chat = await chromeChat(chatId)
        if (!workspaceManager) throw new Error('Codey is still starting — try again in a moment')
        const fsMod = await import('fs')
        const pathMod = await import('path')
        const cryptoMod = await import('crypto')
        const wsConfigPath = pathMod.join(workspaceManager.getWorkspacesRoot(), chat.workspaceName, 'workspace.json')
        let workingDir = (inProcessGateway as any).workingDir
        if (fsMod.existsSync(wsConfigPath)) {
          try {
            const wsConfig = JSON.parse(fsMod.readFileSync(wsConfigPath, 'utf8'))
            if (wsConfig.workingDir) workingDir = wsConfig.workingDir
          } catch { /* use gateway working directory */ }
        }
        const uploadsDir = pathMod.join(pathMod.resolve(workingDir || process.cwd()), '.codey', 'uploads')
        fsMod.mkdirSync(uploadsDir, { recursive: true })
        const safeName = name.replace(/[^a-zA-Z0-9._-]/g, '_') || 'attachment'
        const filePath = pathMod.join(uploadsDir, `${Date.now()}-${cryptoMod.randomBytes(4).toString('hex')}-${safeName}`)
        fsMod.writeFileSync(filePath, data)
        return { id: cryptoMod.randomUUID(), name, path: filePath, mimeType, size: data.length }
      },
      transcribe: async (mimeType, data) => {
        if (!coreConfigManager) throw new Error('Codey configuration is unavailable')
        const voice = coreConfigManager.getResolvedVoiceConfig()
        if (!voice) throw new Error('Configure Voice in Codey Settings first')
        if (voice.provider === 'local') {
          if (mimeType !== 'audio/wav') throw new Error('Reload the Codey Chrome extension to enable local voice transcription')
          return { text: await transcribeChromeVoiceLocally(data, voice) }
        }
        if (!voice.apiKey) throw new Error('Select a transcription key in Codey Voice settings')
        const base = (voice.apiUrl || 'https://api.openai.com/v1').replace(/\/+$/, '')
        const form = new FormData()
        const audioBytes = Uint8Array.from(data)
        const fileName = mimeType.includes('wav') ? 'audio.wav' : mimeType.includes('webm') ? 'audio.webm' : 'audio.mp4'
        form.append('file', new Blob([audioBytes], { type: mimeType }), fileName)
        form.append('model', voice.apiModel || 'gpt-4o-mini-transcribe')
        if (voice.language && voice.language !== 'auto') form.append('language', voice.language)
        const response = await fetch(`${base}/audio/transcriptions`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${voice.apiKey}` },
          body: form,
        })
        if (!response.ok) {
          const detail = (await response.text().catch(() => '')).trim()
          throw new Error(`Transcription failed (${response.status})${detail ? `: ${detail.slice(0, 240)}` : ''}`)
        }
        const body = await response.json() as any
        return { text: typeof body?.text === 'string' ? body.text.trim() : '' }
      },
    },
  )
  try {
    await chromeCompanion.start()
  } catch (error) {
    console.warn(`[browser] Chrome companion unavailable: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (canConfigureBrowserWebAuthn()) {
    configureBrowserWebAuthn(app, browserSession, pickBrowserPasskey, error => {
      const message = error instanceof Error ? error.message : String(error)
      console.warn(`[browser] WebAuthn unavailable: ${message}`)
      sendToRenderer('gateway-log', `[browser] WebAuthn unavailable: ${message}`)
    })
  } else {
    console.warn('[browser] Native Touch ID disabled: Codey is not signed with the required keychain entitlement')
  }

  protocol.handle('codey-asset', async (request) => {
    try {
      const url = new URL(request.url)
      const encoded = url.pathname.replace(/^\/+/, '')
      const decoded = decodeURIComponent(encoded)
      const path = await import('path')
      const absPath = path.resolve(decoded)
      // Only serve files inside a workspace's .codey/uploads/ directory.
      if (!absPath.includes(`${path.sep}.codey${path.sep}uploads${path.sep}`)) {
        return new Response('Forbidden', { status: 403 })
      }
      return await net.fetch(pathToFileURL(absPath).toString())
    } catch (err) {
      return new Response(`Error: ${(err as Error).message}`, { status: 500 })
    }
  })

  createAppMenu()
  createWindow()
  createTray()
  registerUpdaterIpc(ipcMain, wrap, () => { isQuitting = true })
  initAutoUpdater(
    (payload) => sendToRenderer('updater:state', payload),
    app.isPackaged,
    (m) => sendToRenderer('gateway-log', m),
  )
  // Must be registered before the boot await: the renderer can mount and
  // query core state while bootInProcessCore() is still running.
  ipcMain.handle('core:state', async () =>
    wrap(async () => coreStateStore.get())
  )
  ipcMain.handle('app:relaunch', async () =>
    wrap(async () => { app.relaunch(); app.quit() })
  )
  // Browser content lives in a native WebContentsView rather than in the React
  // renderer. Keeping this API narrow prevents remote pages from gaining any
  // Node or Codey privileges while still allowing the trusted app shell to
  // position and control the view.
  const fromMainRenderer = (event: Electron.IpcMainInvokeEvent) =>
    !!mainWindow && !mainWindow.isDestroyed() && event.sender === mainWindow.webContents
  const browserCall = <T>(event: Electron.IpcMainInvokeEvent, fn: () => Promise<T> | T) =>
    wrap(async () => {
      if (!fromMainRenderer(event)) throw new Error('Browser controls are only available to the Codey window')
      return await fn()
    })
  const terminalCall = <T>(event: Electron.IpcMainInvokeEvent, fn: () => Promise<T> | T) =>
    wrap(async () => {
      if (!fromMainRenderer(event)) throw new Error('Terminal controls are only available to the Codey window')
      return await fn()
    })
  ipcMain.handle('terminal:list', (event, chatId: string) =>
    terminalCall(event, () => [...terminalSessions.values()]
      .filter(session => session.chatId === chatId)
      .map(session => ({ sessionId: session.id, chatId, cwd: session.cwd, pid: session.process.pid, alive: session.alive }))))
  ipcMain.handle('terminal:open', (event, input: { sessionId?: string; chatId: string; cwd: string; cols: number; rows: number }) =>
    terminalCall(event, () => openTerminalSession(input.chatId, input.cwd, input.cols, input.rows, input.sessionId)))
  ipcMain.handle('terminal:write', (event, sessionId: string, data: string) =>
    terminalCall(event, () => {
      const terminal = terminalSessions.get(sessionId)
      if (!terminal?.alive) throw new Error('Terminal session is not running')
      if (typeof data !== 'string' || data.length > 65_536) throw new Error('Invalid terminal input')
      terminal.process.write(data)
    }))
  ipcMain.handle('terminal:resize', (event, sessionId: string, cols: number, rows: number) =>
    terminalCall(event, () => {
      const terminal = terminalSessions.get(sessionId)
      if (!terminal?.alive) return
      terminal.process.resize(Math.max(2, Math.min(500, cols)), Math.max(1, Math.min(300, rows)))
    }))
  ipcMain.handle('terminal:status', (event, sessionId: string) =>
    terminalCall(event, async () => {
      const terminal = terminalSessions.get(sessionId)
      if (!terminal) throw new Error('Terminal session was not found')
      return { sessionId, title: await terminalSessionTitle(terminal), pid: terminal.process.pid, alive: terminal.alive }
    }))
  ipcMain.handle('terminal:restart', (event, input: { sessionId: string; chatId: string; cwd: string; cols: number; rows: number }) =>
    terminalCall(event, async () => {
      disposeTerminalSession(input.sessionId)
      return openTerminalSession(input.chatId, input.cwd, input.cols, input.rows, input.sessionId)
    }))
  ipcMain.handle('terminal:close', (event, sessionId: string) =>
    terminalCall(event, () => disposeTerminalSession(sessionId)))
  ipcMain.handle('browser:getState', event => browserCall(event, () => browserController.getState()))
  ipcMain.handle('browser:show', (event, bounds: BrowserBounds) => browserCall(event, () => browserController.show(bounds)))
  ipcMain.handle('browser:hide', event => browserCall(event, () => browserController.hide()))
  ipcMain.handle('browser:setBounds', (event, bounds: BrowserBounds) => browserCall(event, () => browserController.setBounds(bounds)))
  ipcMain.handle('browser:navigate', (event, url: string) => browserCall(event, () => browserController.navigate(url)))
  ipcMain.handle('browser:back', event => browserCall(event, () => browserController.back()))
  ipcMain.handle('browser:forward', event => browserCall(event, () => browserController.forward()))
  ipcMain.handle('browser:reload', event => browserCall(event, () => browserController.reload()))
  ipcMain.handle('browser:stop', event => browserCall(event, () => browserController.stop()))
  ipcMain.handle('browser:getPageContext', event => browserCall(event, () => browserController.getPageContext()))
  ipcMain.handle('browser:downloads', event => browserCall(event, () => browserController.listDownloads()))
  ipcMain.handle('browser:tabs', event => browserCall(event, () => browserController.listTabs()))
  ipcMain.handle('browser:newTab', (event, url?: string) => browserCall(event, () => browserController.newTab(url)))
  ipcMain.handle('browser:switchTab', (event, id: string) => browserCall(event, () => browserController.switchTab(id)))
  ipcMain.handle('browser:closeTab', (event, id: string) => browserCall(event, () => browserController.closeTab(id)))
  ipcMain.handle('browser:resetSession', event => browserCall(event, async () => {
    const state = await browserController.resetSession()
    browserSitePermissions?.clear()
    browserControlPermission?.revoke()
    return state
  }))
  // Browser profiles: saved/imported sessions the renderer (browser toolbar
  // and Settings) manages through the same controller the agents use.
  ipcMain.handle('browser:profiles:list', event => browserCall(event, () => ({
    active: browserController.activeProfileName(),
    profiles: browserController.listProfiles(),
  })))
  ipcMain.handle('browser:profiles:save', (event, name: string) =>
    browserCall(event, () => browserController.saveProfile(String(name || ''))))
  ipcMain.handle('browser:profiles:activate', (event, name: string) =>
    browserCall(event, () => browserController.activateProfile(String(name || ''))))
  ipcMain.handle('browser:profiles:setAvatar', (event, name: string, avatar: string) =>
    browserCall(event, () => browserController.setProfileAvatar(String(name || ''), String(avatar || ''))))
  ipcMain.handle('browser:profiles:delete', (event, name: string) =>
    browserCall(event, () => browserController.deleteProfile(String(name || ''))))
  ipcMain.handle('browser:profiles:import', event => browserCall(event, async () => {
    const result = await dialog.showOpenDialog(mainWindow ?? (undefined as any), {
      title: 'Import browser profile',
      buttonLabel: 'Import',
      properties: ['openFile'],
      filters: [
        { name: 'Browser profile (JSON)', extensions: ['json'] },
        { name: 'All files', extensions: ['*'] },
      ],
    })
    if (result.canceled || result.filePaths.length === 0) return { imported: false, profile: null }
    const filePath = result.filePaths[0]
    const name = deriveProfileNameFromFile(filePath)
    // Importing activates by default — "import then enable" in one step — and
    // the identity switch prompts the user like any mutating browser command.
    const profile = await browserController.importProfile(name, { path: filePath })
    return { imported: true, profile }
  }))
  ipcMain.handle('browser:profiles:export', (event, name: string) => browserCall(event, async () => {
    const requested = String(name || '')
    const result = await dialog.showSaveDialog(mainWindow ?? (undefined as any), {
      title: 'Export browser profile',
      buttonLabel: 'Export',
      defaultPath: requested ? `${requested}.json` : 'profile.json',
      filters: [{ name: 'Browser profile (JSON)', extensions: ['json'] }],
    })
    if (result.canceled || !result.filePath) return { exported: false, path: null }
    const out = await browserController.exportProfile(requested, result.filePath)
    return { exported: true, path: out.path }
  }))
  ipcMain.handle('browser:extensions:list', event => browserCall(event, () => {
    if (!browserExtensionManager) throw new Error('Browser extensions are unavailable')
    return browserExtensionManager.list()
  }))
  ipcMain.handle('browser:extensions:discoverChrome', event => browserCall(event, () => {
    if (!browserExtensionManager) throw new Error('Browser extensions are unavailable')
    return browserExtensionManager.discoverChrome()
  }))
  ipcMain.handle('browser:extensions:pick', event => browserCall(event, async () => {
    if (!browserExtensionManager) throw new Error('Browser extensions are unavailable')
    const result = await dialog.showOpenDialog(mainWindow ?? (undefined as any), {
      title: 'Load unpacked browser extension',
      buttonLabel: 'Review Extension',
      properties: ['openDirectory'],
    })
    if (result.canceled || !result.filePaths[0]) return null
    return browserExtensionManager.inspect(result.filePaths[0])
  }))
  ipcMain.handle('browser:extensions:install', (event, extensionPath: string) => browserCall(event, () => {
    if (!browserExtensionManager) throw new Error('Browser extensions are unavailable')
    return browserExtensionManager.install(extensionPath)
  }))
  ipcMain.handle('browser:extensions:importFromChrome', (event, extensionPath: string) => browserCall(event, () => {
    if (!browserExtensionManager) throw new Error('Browser extensions are unavailable')
    return browserExtensionManager.importFromChrome(extensionPath)
  }))
  ipcMain.handle('browser:extensions:setEnabled', (event, key: string, enabled: boolean) => browserCall(event, () => {
    if (!browserExtensionManager) throw new Error('Browser extensions are unavailable')
    return browserExtensionManager.setEnabled(String(key || ''), !!enabled)
  }))
  ipcMain.handle('browser:extensions:reload', (event, key: string) => browserCall(event, () => {
    if (!browserExtensionManager) throw new Error('Browser extensions are unavailable')
    return browserExtensionManager.reload(String(key || ''))
  }))
  ipcMain.handle('browser:extensions:remove', (event, key: string) => browserCall(event, () => {
    if (!browserExtensionManager) throw new Error('Browser extensions are unavailable')
    return browserExtensionManager.remove(String(key || ''))
  }))
  ipcMain.handle('chromeCompanion:status', event => browserCall(event, () => {
    if (!chromeCompanion) throw new Error('Chrome companion is unavailable')
    return chromeCompanion.status()
  }))
  ipcMain.handle('chromeCompanion:disconnect', event => browserCall(event, () => {
    if (!chromeCompanion) throw new Error('Chrome companion is unavailable')
    return chromeCompanion.disconnect()
  }))
  ipcMain.handle('chromeCompanion:activeTab', event => browserCall(event, () => {
    if (!chromeCompanion) throw new Error('Chrome companion is unavailable')
    return chromeCompanion.activeTab()
  }))
  ipcMain.handle('chromeCompanion:snapshot', event => browserCall(event, () => {
    if (!chromeCompanion) throw new Error('Chrome companion is unavailable')
    return chromeCompanion.snapshot()
  }))
  ipcMain.handle('chromeCompanion:exportSession', (event, name: string) => browserCall(event, async () => {
    if (!chromeCompanion) throw new Error('Chrome companion is unavailable')
    const requested = String(name || '').trim()
    assertProfileName(requested)
    if (browserController.listProfiles().some(profile => profile.name === requested)) {
      throw new Error(`A Codey Browser profile named "${requested}" already exists — choose another name`)
    }
    const sessionState = await chromeCompanion.exportSession()
    await browserController.importProfile(requested, {
      json: JSON.stringify({ cookies: sessionState.cookies, origins: sessionState.origins }),
    }, true, sessionState.tab.url)
    const profile = browserController.listProfiles().find(item => item.name === requested)
    if (!profile) throw new Error('Chrome session was imported but its Codey Browser profile could not be found')
    return { profile, tab: sessionState.tab }
  }))
  ipcMain.handle('chromeCompanion:navigate', (event, url: string) => browserCall(event, () => {
    if (!chromeCompanion) throw new Error('Chrome companion is unavailable')
    return chromeCompanion.navigate(String(url || ''))
  }))
  ipcMain.handle('chromeCompanion:setAccent', (event, hex: string) => browserCall(event, () => {
    chromeCompanion?.setAccent(String(hex || ''))
    return { ok: true }
  }))
  ipcMain.handle('chromeCompanion:showExtensionFolder', event => browserCall(event, async () => {
    const extensionPath = chromeCompanionExtensionPath()
    const fsMod = await import('fs')
    if (!fsMod.existsSync(extensionPath)) throw new Error('The Chrome companion extension is missing from this build')
    shell.showItemInFolder(join(extensionPath, 'manifest.json'))
    return extensionPath
  }))
  ipcMain.handle('browser:controlPermission:get', event => browserCall(event, () =>
    browserControlPermission?.getState() ?? { approved: false, pending: null }
  ))
  ipcMain.handle('browser:controlPermission:approve', event => browserCall(event, () => {
    if (!browserControlPermission) throw new Error('Browser control permission is unavailable')
    return browserControlPermission.approve()
  }))
  ipcMain.handle('browser:controlPermission:deny', event => browserCall(event, () => {
    if (!browserControlPermission) throw new Error('Browser control permission is unavailable')
    return browserControlPermission.deny()
  }))
  ipcMain.handle('browser:controlPermission:revoke', event => browserCall(event, () => {
    if (!browserControlPermission) throw new Error('Browser control permission is unavailable')
    return browserControlPermission.revoke()
  }))
  ipcMain.handle('browser:sitePermission:get', event => browserCall(event, () =>
    browserSitePermissions?.getState() ?? { pending: null, savedSiteCount: 0 }
  ))
  ipcMain.handle('browser:sitePermission:allowForSession', (event, id: string) => browserCall(event, () => {
    if (!browserSitePermissions) throw new Error('Website permissions are unavailable')
    return browserSitePermissions.allowForSession(String(id || ''))
  }))
  ipcMain.handle('browser:sitePermission:alwaysAllow', (event, id: string) => browserCall(event, () => {
    if (!browserSitePermissions) throw new Error('Website permissions are unavailable')
    return browserSitePermissions.alwaysAllow(String(id || ''))
  }))
  ipcMain.handle('browser:sitePermission:block', (event, id: string) => browserCall(event, () => {
    if (!browserSitePermissions) throw new Error('Website permissions are unavailable')
    return browserSitePermissions.block(String(id || ''))
  }))

  // Coding agents run as separate CLI processes. Give their shell tools a
  // private Unix-socket command bridge to the same persistent WebContentsView.
  // The bearer token is inherited only by agent subprocesses; it is never
  // exposed to remote page content or the renderer.
  browserControlPermission = new BrowserControlPermissionGate(
    join(app.getPath('userData'), 'browser-control-permission.json'),
    state => sendToRenderer('browser:controlPermission', state),
  )
  browserAgentBridge = new BrowserAgentBridge(browserController, url => {
    mainWindow?.show()
    sendToRenderer('browser:agentOpen', { url })
  }, request => {
    mainWindow?.show()
    sendToRenderer('browser:agentOpen', { url: request.url })
    return browserControlPermission!.request(request)
  }, handleBrowserLoginWait, 2000, chromeCompanion ?? undefined)
  try {
    const bridge = await browserAgentBridge.start()
    process.env.CODEY_BROWSER_SOCKET = bridge.socketPath
    process.env.CODEY_BROWSER_TOKEN = bridge.token
    process.env.CODEY_CHROME_COMPANION_TOKEN = bridge.chromeToken
    // How agents reach the browser: the managed `browser` skill tells them to
    // run this CLI through their own shell tool, so every agent Codey supports
    // gets the plugin, MCP surface or not.
    process.env.CODEY_BROWSER_CLI = browserAgentCliPath()
    process.env.CODEY_BROWSER_RUNTIME = process.execPath
  } catch (error: any) {
    sendToRenderer('gateway-log', `[browser] agent bridge failed to start: ${error?.message ?? error}`)
    browserAgentBridge = null
  }
  ipcMain.handle('capture:pickFiles', async () =>
    wrap(async () => {
      capturePickingFiles = true
      try {
        const result = await dialog.showOpenDialog(captureWindow ?? (undefined as any), {
          properties: ['openFile', 'multiSelections'],
        })
        if (result.canceled) return { files: [] as Array<{ path: string; name: string; size: number }> }
        const fsMod = await import('fs')
        const pathMod = await import('path')
        const files = result.filePaths.map(p => {
          let size = 0
          try { size = fsMod.statSync(p).size } catch { /* unreadable — size 0 */ }
          return { path: p, name: pathMod.basename(p), size }
        })
        return { files }
      } finally {
        capturePickingFiles = false
        // Closing the native dialog leaves the capture window unfocused; restore
        // focus so typing and Escape keep working.
        captureWindow?.focus()
      }
    })
  )
  // Preview helper for the capture window: read-only base64 data URL for an
  // image at any path. Screenshots live in os.tmpdir() and picked files at
  // their original location — both outside .codey/uploads/, so the codey-asset
  // protocol can't serve them. Restricted to image extensions and capped so a
  // stray huge file can't be slurped into the renderer.
  ipcMain.handle('capture:thumbnail', async (_e, filePath: string) =>
    wrap(async () => {
      const pathMod = await import('path')
      const fsMod = await import('fs')
      const ext = pathMod.extname(String(filePath || '')).toLowerCase()
      const mime: Record<string, string> = {
        '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
        '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
        '.heic': 'image/heic', '.heif': 'image/heif', '.svg': 'image/svg+xml',
      }
      if (!mime[ext]) throw new Error('not an image')
      const stat = await fsMod.promises.stat(filePath)
      if (stat.size > 25 * 1024 * 1024) throw new Error('image too large to preview')
      const buf = await fsMod.promises.readFile(filePath)
      return { dataUrl: `data:${mime[ext]};base64,${buf.toString('base64')}` }
    })
  )
  ipcMain.handle('capture:submit', async (_e, payload: { workspaceName?: string; text: string; filePaths?: string[] }) =>
    wrap(async () => {
      if (!inProcessGateway || !workspaceManager) throw new Error('Core not ready — open Codey to check its status')
      const known = workspaceManager.listWorkspaces()
      const resolved = resolveCaptureSubmit(payload?.text ?? '', payload?.workspaceName, known)
      if (!resolved.ok) throw new Error(resolved.error)
      const chat = await inProcessGateway.createChat({ workspaceName: resolved.workspaceName })

      // Copy any picked files into the target workspace's .codey/uploads/ and
      // build FileAttachments — mirrors the chats:upload handler so the agent
      // sees attachments identically to a normal chat send.
      const attachments: Array<{ id: string; name: string; path: string; mimeType: string; size: number }> = []
      const filePaths = payload?.filePaths ?? []
      if (filePaths.length > 0) {
        const fsMod = await import('fs')
        const pathMod = await import('path')
        const cryptoMod = await import('crypto')
        const workspacesRoot = (inProcessGateway as any).workspaceManager.getWorkspacesRoot()
        const wsConfigPath = pathMod.join(workspacesRoot, resolved.workspaceName, 'workspace.json')
        let workingDir = (inProcessGateway as any).workingDir
        if (fsMod.existsSync(wsConfigPath)) {
          try {
            const wsConfig = JSON.parse(fsMod.readFileSync(wsConfigPath, 'utf-8'))
            if (wsConfig.workingDir) workingDir = wsConfig.workingDir
          } catch { /* use default */ }
        }
        const uploadsDir = pathMod.join(pathMod.resolve(workingDir || process.cwd()), '.codey', 'uploads')
        fsMod.mkdirSync(uploadsDir, { recursive: true })
        for (const src of filePaths) {
          try {
            const name = pathMod.basename(src)
            const safeName = name.replace(/[^a-zA-Z0-9._-]/g, '_')
            const uniqueName = `${Date.now()}-${cryptoMod.randomBytes(4).toString('hex')}-${safeName}`
            const dest = pathMod.join(uploadsDir, uniqueName)
            fsMod.copyFileSync(src, dest)
            attachments.push({
              id: cryptoMod.randomUUID(),
              name,
              path: dest,
              mimeType: inferCaptureMimeType(name),
              size: fsMod.statSync(dest).size,
            })
          } catch (err: any) {
            sendToRenderer('gateway-log', `[capture] attachment copy failed for ${src}: ${err?.message ?? err}`)
          }
        }
      }

      // Fire and forget: the global chatEventListener mirrors events to the
      // main window, Aide auto-titles, and the notification pipeline reports
      // completion/errors.
      inProcessGateway.sendToChat(chat.id, resolved.text, () => { /* no-op sink */ }, attachments.length > 0 ? attachments : undefined).catch((err: any) => {
        // The sink tee already emitted the error event to the notification
        // pipeline; this just keeps the rejection out of unhandledRejection.
        sendToRenderer('gateway-log', `[capture] dispatch failed: ${err?.message ?? err}`)
      })
      captureWindow?.hide()
      try {
        const notif = new Notification({
          title: `Task sent to ${resolved.workspaceName}`,
          body: resolved.text.slice(0, 120),
          silent: true,
        })
        notif.on('click', () => {
          mainWindow?.show()
          sendToRenderer('notify:openChat', { chatId: chat.id })
        })
        notif.show()
      } catch { /* notification is best-effort */ }
      return { chatId: chat.id }
    })
  )
  ipcMain.handle('capture:hide', async () =>
    wrap(async () => { captureWindow?.hide() })
  )
  // Renderer-driven height: keep the window pinned to its bottom edge (it is
  // bottom-anchored on screen) while it grows/shrinks to fit content.
  ipcMain.handle('capture:setHeight', async (_e, height: number) =>
    wrap(async () => {
      if (!captureWindow || captureWindow.isDestroyed()) return
      const h = Math.max(60, Math.min(Math.round(height) || 0, 600))
      const b = captureWindow.getBounds()
      if (h === b.height) return
      const bottom = b.y + b.height
      captureWindow.setBounds({ x: b.x, y: bottom - h, width: b.width, height: h })
    })
  )
  await bootInProcessCore()

  // Config is loaded now, so the selected on-device model is known. Not
  // awaited: warming is a 30-90s CoreML compile in the worst case and nothing
  // downstream depends on it, so startup continues while it runs.
  void warmSelectedVoiceModelOnStartup()

  // Check Full Disk Access by probing the iMessage database. This reminder is
  // intentionally one-time: it is guidance for the optional iMessage channel,
  // not a blocking prompt that should interrupt every app launch.
  {
    const fsMod = await import('fs')
    const osMod = await import('os')
    const pathMod = await import('path')
    const chatDbPath = pathMod.join(osMod.homedir(), 'Library', 'Messages', 'chat.db')
    try {
      fsMod.accessSync(chatDbPath, fsMod.constants.R_OK)
    } catch {
      const marker = pathMod.join(app.getPath('userData'), 'full-disk-access-prompt-seen')
      if (!fsMod.existsSync(marker)) {
        try { fsMod.writeFileSync(marker, String(Date.now()), 'utf8') } catch { /* best effort */ }
        const { dialog: dlg } = await import('electron')
        void dlg.showMessageBox({
          type: 'info',
          title: 'Full Disk Access recommended',
          message: 'Codey needs Full Disk Access to read iMessage conversations.',
          detail: 'Go to System Settings → Privacy & Security → Full Disk Access and add Codey.',
          buttons: ['OK'],
        })
      }
    }
  }

  // ── Gateway status IPC ────────────────────────────────────────────
  ipcMain.handle('gateway:status', async () =>
    wrap(async () => inProcessGateway?.getHealthStatus() ?? null)
  )

  // Renderer mounts after did-finish-load fires, so any logs sent during
  // boot would be lost. Expose the ring buffer so the renderer can backfill.
  ipcMain.handle('gateway:recentLogs', async () =>
    wrap(async () => recentGatewayLogs.slice())
  )

  // ── Workspace file index IPC (composer "@" mentions) ──────────────
  // Indexing a large repo costs a fork + a walk, and the composer asks on every
  // "@". Cache per working dir for a few seconds so a burst of keystrokes only
  // pays once, while still picking up new files during a normal session.
  const fileIndexCache = new Map<string, { at: number; entries: FileEntry[] }>()
  const FILE_INDEX_TTL_MS = 5000

  ipcMain.handle('workspace:files', async (_e, workingDir: string) =>
    wrap(async () => {
      if (!workingDir || typeof workingDir !== 'string') return []
      const cached = fileIndexCache.get(workingDir)
      if (cached && Date.now() - cached.at < FILE_INDEX_TTL_MS) return cached.entries

      const { execFile } = await import('child_process')
      const fsMod = await import('fs')
      let paths: string[]
      try {
        // -z keeps paths with spaces/unicode intact (git quotes them otherwise).
        // No --exclude-standard: .gitignore'd files (.env, build output) should
        // still be mentionable; parseGitFileList drops the heavy dirs instead.
        const stdout = await new Promise<string>((resolve, reject) => {
          execFile(
            'git', ['ls-files', '-z', '--cached', '--others'],
            { cwd: workingDir, timeout: 4000, maxBuffer: 32 * 1024 * 1024 },
            (err, out) => (err ? reject(err) : resolve(out)),
          )
        })
        paths = parseGitFileList(stdout)
      } catch {
        // Not a repo (or git unavailable) — fall back to a bounded walk.
        paths = walkDirectory(workingDir, fsMod as never)
      }
      const entries = deriveEntries(paths)
      // Truncation is invisible in the menu — a missing file just looks like a
      // typo — so say so at least once per index build.
      if (entries.length >= MAX_ENTRIES) {
        console.warn(`[workspace:files] ${workingDir}: index hit the ${MAX_ENTRIES}-entry cap; deepest paths were dropped`)
      }
      fileIndexCache.set(workingDir, { at: Date.now(), entries })
      return entries
    })
  )

  // ── Git status IPC ────────────────────────────────────────────────
  // Live git branch watching: one fs.watch per workingDir, ref-counted by renderer subscriptions.
  const gitWatchers = new Map<string, { watchers: import('fs').FSWatcher[]; count: number; timer: NodeJS.Timeout | null }>()

  ipcMain.handle('git:status', async (_e, workingDir: string) =>
    wrap(async () => {
      if (!workingDir || typeof workingDir !== 'string') return null
      const { execFile } = await import('child_process')
      const run = (args: string[]) => new Promise<string>((resolve, reject) => {
        execFile('git', args, { cwd: workingDir, timeout: 1500 }, (err, stdout) => {
          if (err) reject(err)
          else resolve(stdout)
        })
      })
      try {
        const [branchOut, statusOut] = await Promise.all([
          run(['rev-parse', '--abbrev-ref', 'HEAD']),
          run(['status', '--porcelain']),
        ])
        const branch = branchOut.trim() || 'HEAD'
        const dirty = statusOut.split('\n').filter(l => l.trim()).length
        // Repo default branch (for Create PR gating) — origin/HEAD when set, else 'main'.
        let defaultBranch = 'main'
        try {
          const sym = await run(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
          defaultBranch = sym.trim().replace(/^[^/]+\//, '') || 'main'
        } catch { /* no origin/HEAD ref; keep 'main' */ }
        // Commits on this branch that aren't on the default branch; null when unknowable.
        let ahead: number | null = null
        try {
          const cnt = await run(['rev-list', '--count', `origin/${defaultBranch}..HEAD`])
          const n = parseInt(cnt.trim(), 10)
          if (!Number.isNaN(n)) ahead = n
        } catch { /* no remote default ref; leave null */ }
        return { branch, dirty, defaultBranch, ahead }
      } catch {
        return null
      }
    })
  )

  ipcMain.handle('git:branches', async (_e, workingDir: string) =>
    wrap(async () => {
      if (!workingDir || typeof workingDir !== 'string') return { current: '', local: [], remote: [] }
      const { execFile } = await import('child_process')
      const run = (args: string[]) => new Promise<string>((resolve, reject) => {
        execFile('git', args, { cwd: workingDir, timeout: 2000 }, (err, stdout) => {
          if (err) reject(err); else resolve(stdout)
        })
      })
      try {
        const [curOut, localOut, remoteOut] = await Promise.all([
          run(['rev-parse', '--abbrev-ref', 'HEAD']),
          run(['for-each-ref', '--format=%(refname:short)', 'refs/heads']),
          run(['for-each-ref', '--format=%(refname:short)%09%(symref)', 'refs/remotes']),
        ])
        const current = curOut.trim() || 'HEAD'
        const local = localOut.split('\n').map(l => l.trim()).filter(Boolean)
        // %(refname:short) renders refs/remotes/origin/HEAD as the misleading
        // bare label "origin" on some Git versions. Include %(symref) so those
        // symbolic aliases can be removed without hiding real branches.
        const remote = remoteOut.split('\n')
          .map(line => {
            const [name, symref] = line.split('\t')
            return { name: name?.trim(), symref: symref?.trim() }
          })
          .filter(ref => ref.name && !ref.symref && !ref.name.endsWith('/HEAD'))
          .map(ref => ref.name!)
        return { current, local, remote }
      } catch {
        return { current: '', local: [], remote: [] }
      }
    })
  )

  ipcMain.handle('git:checkout', async (_e, workingDir: string, name: string, opts?: { create?: boolean; track?: boolean }) =>
    wrap(async () => {
      if (!workingDir || !name) return { ok: false, error: 'missing args' }
      const { execFile } = await import('child_process')
      const run = (args: string[]) => new Promise<{ ok: boolean; stderr: string }>((resolve) => {
        execFile('git', args, { cwd: workingDir, timeout: 5000 }, (err, _out, stderr) => {
          resolve({ ok: !err, stderr: stderr || (err ? String(err) : '') })
        })
      })
      const args = opts?.create ? ['checkout', '-b', name]
        : opts?.track ? ['checkout', '--track', name]
        : ['checkout', name]
      const r = await run(args)
      if (r.ok) return { ok: true }
      const dirty = /would be overwritten|Your local changes|commit your changes or stash/i.test(r.stderr)
      return { ok: false, error: r.stderr.trim(), reason: dirty ? 'dirty' as const : undefined }
    })
  )

  ipcMain.handle('git:stash', async (_e, workingDir: string, message?: string) =>
    wrap(async () => {
      if (!workingDir) return { ok: false, error: 'missing workingDir' }
      const { execFile } = await import('child_process')
      const args = ['stash', 'push', '-u']
      if (message) args.push('-m', message)
      return await new Promise<{ ok: boolean; error?: string }>((resolve) => {
        execFile('git', args, { cwd: workingDir, timeout: 5000 }, (err, _out, stderr) => {
          if (err) resolve({ ok: false, error: (stderr || String(err)).trim() })
          else resolve({ ok: true })
        })
      })
    })
  )

  ipcMain.handle('git:fetch', async (_e, workingDir: string) =>
    wrap(async () => {
      if (!workingDir) return { ok: false, error: 'missing workingDir' }
      const { execFile } = await import('child_process')
      const run = (args: string[], timeout = 30000) => new Promise<{ ok: boolean; stdout: string; error?: string }>((resolve) => {
        execFile('git', args, { cwd: workingDir, timeout }, (err, stdout, stderr) => {
          if (err) resolve({ ok: false, stdout: stdout || '', error: (stderr || String(err)).trim() })
          else resolve({ ok: true, stdout: stdout || '' })
        })
      })
      const remotesResult = await run(['remote'], 3000)
      if (!remotesResult.ok) return { ok: false, error: remotesResult.error }
      const remotes = remotesResult.stdout.split('\n').map(remote => remote.trim()).filter(Boolean)
      if (remotes.length === 0) return { ok: true }

      // Explicitly fetch every head. Plain `git fetch --all` still honors a
      // single-branch clone's narrow refspec and leaves the picker incomplete.
      const results = await Promise.all(remotes.map(remote =>
        run(['fetch', '--prune', remote, `+refs/heads/*:refs/remotes/${remote}/*`])
      ))
      const failed = results.find(result => !result.ok)
      return failed ? { ok: false, error: failed.error } : { ok: true }
    })
  )

  ipcMain.handle('git:pull', async (_e, workingDir: string) =>
    wrap(async () => {
      if (!workingDir) return { ok: false, error: 'missing workingDir' }
      const { execFile } = await import('child_process')
      const run = (args: string[], timeout = 30000) => new Promise<{ ok: boolean; stdout: string; error?: string }>((resolve) => {
        execFile('git', args, { cwd: workingDir, timeout }, (err, stdout, stderr) => {
          if (err) resolve({ ok: false, stdout: stdout || '', error: (stderr || String(err)).trim() })
          else resolve({ ok: true, stdout: stdout || '' })
        })
      })

      const upstream = await run(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], 3000)
      if (!upstream.ok) return { ok: false, reason: 'no-upstream' as const, error: 'This branch has no upstream branch' }
      const upstreamRef = upstream.stdout.trim()
      const remote = upstreamRef.split('/')[0]

      const fetched = await run(['fetch', '--prune', remote, `+refs/heads/*:refs/remotes/${remote}/*`])
      if (!fetched.ok) return { ok: false, error: fetched.error }

      const behindOut = await run(['rev-list', '--count', `HEAD..${upstreamRef}`], 5000)
      const behind = behindOut.ok ? parseInt(behindOut.stdout.trim(), 10) || 0 : 0
      if (behind === 0) return { ok: true, updated: 0, upstream: upstreamRef }

      // --ff-only keeps the pull non-destructive: divergent history stops here
      // instead of leaving a surprise merge (or conflicts) in the checkout.
      const pulled = await run(['pull', '--ff-only'], 60000)
      if (pulled.ok) return { ok: true, updated: behind, upstream: upstreamRef }
      const stderr = pulled.error || ''
      const dirty = /would be overwritten|Your local changes|commit your changes or stash/i.test(stderr)
      const diverged = /Not possible to fast-forward|non-fast-forward|diverged/i.test(stderr)
      return {
        ok: false,
        reason: dirty ? 'dirty' as const : diverged ? 'diverged' as const : undefined,
        error: stderr.trim(),
      }
    })
  )

  ipcMain.handle('git:worktrees', async (_e, workingDir: string) =>
    wrap(async () => {
      if (!workingDir) return { list: [] }
      const { execFile } = await import('child_process')
      const out = await new Promise<string>((resolve) => {
        execFile('git', ['worktree', 'list', '--porcelain'], { cwd: workingDir, timeout: 3000 }, (err, stdout) => {
          resolve(err ? '' : stdout)
        })
      })
      const list: { branch: string; path: string; isMain: boolean }[] = []
      let cur: { path?: string; branch?: string } = {}
      for (const line of out.split('\n')) {
        if (line.startsWith('worktree ')) cur = { path: line.slice('worktree '.length).trim() }
        else if (line.startsWith('branch ')) cur.branch = line.slice('branch '.length).trim().replace('refs/heads/', '')
        else if (line.trim() === '' && cur.path) {
          list.push({ path: cur.path, branch: cur.branch || '(detached)', isMain: list.length === 0 })
          cur = {}
        }
      }
      if (cur.path) list.push({ path: cur.path, branch: cur.branch || '(detached)', isMain: list.length === 0 })
      return { list }
    })
  )

  ipcMain.handle('git:worktreeAdd', async (_e, workingDir: string, args2: { name: string; path: string }) =>
    wrap(async () => {
      if (!workingDir || !args2?.name || !args2?.path) return { ok: false, error: 'missing args' }
      const { execFile } = await import('child_process')
      const fsMod = await import('fs')
      const pathMod = await import('path')
      const target = pathMod.resolve(args2.path)
      const container = pathMod.dirname(target)
      // A branch name that sanitizes to nothing would make `target` the container itself.
      if (pathMod.basename(target) === 'worktrees' && container.endsWith('.codey')) {
        return { ok: false, error: 'invalid branch name' }
      }
      fsMod.mkdirSync(container, { recursive: true })
      // In-repo worktrees would otherwise show up in the main repo's `git status`.
      // Drop a `.gitignore` (`*`) so every worktree checkout is ignored — but only in
      // the known .codey/worktrees container; never in arbitrary caller-supplied dirs.
      try {
        if (container.endsWith(pathMod.join('.codey', 'worktrees'))) {
          const ignorePath = pathMod.join(container, '.gitignore')
          if (!fsMod.existsSync(ignorePath)) fsMod.writeFileSync(ignorePath, '*\n')
        }
      } catch { /* best-effort; worktree add still proceeds */ }
      return await new Promise<{ ok: boolean; path?: string; error?: string }>((resolve) => {
        execFile('git', ['worktree', 'add', target, '-b', args2.name], { cwd: workingDir, timeout: 20000 }, (err, _out, stderr) => {
          if (err) resolve({ ok: false, error: (stderr || String(err)).trim() })
          else resolve({ ok: true, path: target })
        })
      })
    })
  )

  ipcMain.handle('git:createPr', async (_e, workingDir: string, input: { title: string; body?: string }) =>
    wrap(async () => {
      if (!workingDir || !input?.title) return { ok: false, error: 'missing args' }
      const { execFile } = await import('child_process')
      const run = (cmd: string, args: string[], timeout: number) => new Promise<{ ok: boolean; stdout: string; stderr: string }>((resolve) => {
        execFile(cmd, args, { cwd: workingDir, timeout }, (err, stdout, stderr) => {
          resolve({ ok: !err, stdout: stdout || '', stderr: stderr || (err ? String(err) : '') })
        })
      })
      // Resolve current branch
      const br = await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], 3000)
      const branch = br.stdout.trim()
      if (!branch || branch === 'HEAD') return { ok: false, error: 'Not on a branch' }
      // Push with upstream (no-op if already pushed; -u is safe to repeat)
      const push = await run('git', ['push', '-u', 'origin', branch], 60000)
      if (!push.ok) return { ok: false, error: (push.stderr || 'git push failed').trim() }
      // Create PR. Finder-launched apps get launchd's minimal PATH, so resolve gh
      // from the common install locations before falling back to PATH lookup.
      const fsMod = await import('fs')
      const gh = ['/opt/homebrew/bin/gh', '/usr/local/bin/gh', '/usr/bin/gh']
        .find(p => fsMod.existsSync(p)) || 'gh'
      const pr = await run(gh, ['pr', 'create', '--title', input.title, '--body', input.body || '', '--head', branch], 60000)
      if (!pr.ok) {
        const msg = /ENOENT/.test(pr.stderr)
          ? 'GitHub CLI (gh) not found — install it with `brew install gh`'
          : (pr.stderr || 'gh pr create failed').trim()
        return { ok: false, error: msg }
      }
      const url = (pr.stdout.match(/https?:\/\/\S+/) || [])[0] || pr.stdout.trim()
      return { ok: true, url }
    })
  )

  ipcMain.handle('git:prStatus', async (_e, workingDir: string, url?: string) =>
    wrap(async () => {
      if (!workingDir) throw new Error('A working directory is required')
      const { execFile } = await import('child_process')
      const fsMod = await import('fs')
      const run = (cmd: string, args: string[], timeout: number) => new Promise<string>((resolve, reject) => {
        execFile(cmd, args, { cwd: workingDir, timeout }, (error, stdout, stderr) => {
          if (error) reject(new Error((stderr || String(error)).trim()))
          else resolve(stdout.trim())
        })
      })
      const gh = ['/opt/homebrew/bin/gh', '/usr/local/bin/gh', '/usr/bin/gh']
        .find(candidate => fsMod.existsSync(candidate)) || 'gh'
      const PR_FIELDS = 'url,number,state,mergedAt,headRefName,headRefOid,baseRefName'
      type PrView = {
        url: string
        number?: number
        state: string
        mergedAt?: string | null
        headRefName?: string
        headRefOid?: string
        baseRefName?: string
      }
      // No url means "whatever PR the current branch has" — gh resolves it.
      const view$ = async (prUrl?: string): Promise<PrView> =>
        JSON.parse(await run(gh, ['pr', 'view', ...(prUrl ? [prUrl] : []), '--json', PR_FIELDS], 15_000))

      let view = await view$(url)
      const [localHead, currentBranch] = await Promise.all([
        run('git', ['rev-parse', 'HEAD'], 3_000),
        run('git', ['branch', '--show-current'], 3_000),
      ])
      // The caller's stored url can outlive the branch it belongs to: finish a
      // chat's PR, start the next branch in the same checkout, and the old
      // (merged) PR would keep answering forever. When the pinned PR's head is
      // not the branch we're on, ask again for this branch's own PR.
      if (shouldRediscoverPr({ pinnedHeadBranch: view.headRefName, currentBranch })) {
        try { view = await view$() } catch { /* no PR for this branch; keep the pinned one */ }
      }
      const sameBranch = !!view.headRefName && currentBranch === view.headRefName
      let commitsAfterMerge = false
      if (sameBranch && view.state.toUpperCase() === 'MERGED' && view.headRefOid && localHead !== view.headRefOid) {
        try {
          const count = await run('git', ['rev-list', '--count', `${view.headRefOid}..HEAD`], 3_000)
          commitsAfterMerge = Number.parseInt(count, 10) > 0
        } catch { /* a missing remote object is not evidence of new work */ }
      }
      return {
        url: view.url || url || '',
        number: view.number,
        state: deriveDeliveryState({
          providerState: view.state,
          sameBranch,
          commitsAfterMerge,
        }),
        headBranch: view.headRefName,
        baseBranch: view.baseRefName,
        headCommit: view.headRefOid,
        mergedAt: view.mergedAt ? Date.parse(view.mergedAt) : undefined,
        lastCheckedAt: Date.now(),
      }
    })
  )

  ipcMain.handle('git:watch', async (_e, workingDir: string) =>
    wrap(async () => {
      if (!workingDir) return { ok: false }
      const fsMod = await import('fs')
      const pathMod = await import('path')
      const { execFile } = await import('child_process')
      const gitDir = pathMod.join(workingDir, '.git')
      const existing = gitWatchers.get(workingDir)
      if (existing) { existing.count++; return { ok: true } }
      try {
        const emit = () => {
          const entry = gitWatchers.get(workingDir)
          if (!entry) return
          if (entry.timer) clearTimeout(entry.timer)
          entry.timer = setTimeout(() => sendToRenderer('git:changed', { workingDir }), 200)
        }
        // Resolve real git dir: for a linked worktree .git is a file containing "gitdir: <path>"
        const resolvedGitDir = fsMod.existsSync(gitDir) && fsMod.statSync(gitDir).isDirectory()
          ? gitDir
          : (() => {
              try { return fsMod.readFileSync(gitDir, 'utf8').match(/gitdir:\s*(.+)/)?.[1]?.trim() } catch { return undefined }
            })()
        if (!resolvedGitDir) return { ok: false }
        // A linked worktree's private git dir sees its own HEAD/index changes,
        // while branch refs and worktree add/remove operations live under the
        // repository's common git dir. Watch both and keep polling in the
        // renderer as a fallback for nested ref directories and dropped events.
        const commonOut = await new Promise<string | undefined>(resolve => {
          execFile('git', ['rev-parse', '--git-common-dir'], { cwd: workingDir, timeout: 1500 }, (err, stdout) => {
            resolve(err ? undefined : stdout.trim())
          })
        })
        const commonGitDir = commonOut ? pathMod.resolve(workingDir, commonOut) : undefined
        const candidates = Array.from(new Set([
          resolvedGitDir,
          commonGitDir,
        ].filter((candidate): candidate is string => Boolean(candidate && fsMod.existsSync(candidate)))))
        const watchers = candidates.map(candidate => fsMod.watch(candidate, { persistent: false }, () => emit()))
        gitWatchers.set(workingDir, { watchers, count: 1, timer: null })
        return { ok: true }
      } catch {
        return { ok: false }
      }
    })
  )

  ipcMain.handle('git:unwatch', async (_e, workingDir: string) =>
    wrap(async () => {
      if (!workingDir) return { ok: true }
      const entry = gitWatchers.get(workingDir)
      if (!entry) return { ok: true }
      entry.count--
      if (entry.count <= 0) {
        if (entry.timer) clearTimeout(entry.timer)
        for (const watcher of entry.watchers) {
          try { watcher.close() } catch { /* ignore */ }
        }
        gitWatchers.delete(workingDir)
      }
      return { ok: true }
    })
  )

  // ── Workers IPC ──────────────────────────────────────────────────
  ipcMain.handle('workers:list', async () =>
    wrap(async () => workerManager?.getAllWorkers() ?? [])
  )

  ipcMain.handle('workers:get', async (_e, name: string) =>
    wrap(async () => {
      const w = workerManager?.getWorker(name)
      if (!w) throw new Error(`Worker not found: ${name}`)
      return w
    })
  )

  ipcMain.handle('workers:save', async (_e, name: string, personality: any, config: any) =>
    wrap(async () => {
      await workerManager?.saveWorker(name, personality, config)
      // Invalidate any warm `--resume` sessions bootstrapped under the
      // previous personality; next run rebuilds with the new definition.
      inProcessGateway?.invalidateWorkerSessions(name)
    })
  )

  ipcMain.handle('workers:delete', async (_e, name: string) =>
    wrap(async () => {
      await workerManager?.deleteWorker(name)
      inProcessGateway?.invalidateWorkerSessions(name)
      // Cascade: remove the worker from every global team that referenced it.
      // Teams are now defined globally, so we no longer walk per-workspace.
      if (coreConfigManager) {
        const teams = { ...coreConfigManager.getTeams() }
        let changed = false
        for (const teamName of Object.keys(teams)) {
          const raw = teams[teamName]
          const arr = Array.isArray(raw) ? raw : raw.members
          const filtered = arr.filter((m: string) => m !== name)
          if (filtered.length !== arr.length) {
            teams[teamName] = Array.isArray(raw) ? filtered : { ...raw, members: filtered }
            changed = true
          }
        }
        if (changed) coreConfigManager.setTeams(teams)
      }
    })
  )

  // ── Workspaces IPC ────────────────────────────────────────────────
  ipcMain.handle('workspaces:list', async () =>
    wrap(async () => workspaceManager?.listWorkspaces() ?? [])
  )

  ipcMain.handle('workspaces:current', async () =>
    wrap(async () => workspaceManager?.getCurrentWorkspace() ?? '')
  )

  ipcMain.handle('workspaces:switch', async (_e, name: string) =>
    wrap(async () => {
      await workspaceManager?.switchWorkspace(name)
    })
  )

  ipcMain.handle('workspaces:info', async (_e, name: string) =>
    wrap(async () => {
      if (!workspaceManager) throw new Error('Workspace manager not ready')
      const fsMod = await import('fs')
      const pathMod = await import('path')
      const root = workspaceManager.getWorkspacesRoot()
      const configPath = pathMod.join(root, name, 'workspace.json')
      if (!fsMod.existsSync(configPath)) return { workingDir: '' }
      const data = JSON.parse(fsMod.readFileSync(configPath, 'utf-8'))
      return { workingDir: data.workingDir || '' }
    })
  )

  ipcMain.handle('workspaces:create', async (_e, dir: string) =>
    wrap(async () => {
      if (!workspaceManager) throw new Error('Workspace manager not ready')
      if (!dir || typeof dir !== 'string') throw new Error('A directory is required')
      const fsMod = await import('fs')
      if (!fsMod.existsSync(dir) || !fsMod.statSync(dir).isDirectory()) {
        throw new Error(`Not a directory: ${dir}`)
      }
      return workspaceManager.findOrCreateByDir(dir)
    })
  )

  ipcMain.handle('workspaces:delete', async (_e, name: string) =>
    wrap(async () => {
      if (!workspaceManager) throw new Error('Workspace manager not ready')
      await inProcessGateway?.prepareWorkspaceDeletion(name)
      await workspaceManager.deleteWorkspace(name)
      inProcessGateway?.getChatManager().cascadeDeleteWorkspace(name)
    })
  )

  ipcMain.handle('workspaces:rename', async (_e, oldName: string, newName: string) =>
    wrap(async () => {
      if (!workspaceManager) throw new Error('Workspace manager not ready')
      await workspaceManager.renameWorkspace(oldName, newName)
      inProcessGateway?.getChatManager().cascadeRenameWorkspace(oldName, newName.trim())
    })
  )

  ipcMain.handle('workspaces:reveal', async (_e, name: string) =>
    wrap(async () => {
      if (!workspaceManager) throw new Error('Workspace manager not ready')
      const fsMod = await import('fs')
      const pathMod = await import('path')
      const root = workspaceManager.getWorkspacesRoot()
      const wsDir = pathMod.join(root, name)
      let target = wsDir
      try {
        const cfg = JSON.parse(fsMod.readFileSync(pathMod.join(wsDir, 'workspace.json'), 'utf8'))
        if (cfg && typeof cfg.workingDir === 'string' && fsMod.existsSync(cfg.workingDir)) {
          target = cfg.workingDir
        }
      } catch {}
      shell.showItemInFolder(target)
    })
  )

  ipcMain.handle('editors:list', async () =>
    wrap(async () => Promise.all(supportedEditors.map(async editor => ({
      id: editor.id,
      name: editor.name,
      installed: !!await findEditorApp(editor),
    }))))
  )

  ipcMain.handle('editors:open', async (_e, editorId: string, target: string) =>
    wrap(async () => {
      const editor = supportedEditors.find(candidate => candidate.id === editorId)
      if (!editor) throw new Error('Unsupported editor')
      if (!target || typeof target !== 'string') throw new Error('A file or directory path is required')
      const fsMod = await import('fs')
      if (!fsMod.existsSync(target)) throw new Error('Path is unavailable')
      const appPath = await findEditorApp(editor)
      if (!appPath) throw new Error(`${editor.name} is not installed`)
      const { execFile } = await import('child_process')
      await new Promise<void>((resolve, reject) => {
        execFile('open', ['-a', appPath, target], (error) => error ? reject(error) : resolve())
      })
    })
  )

  ipcMain.handle('dialog:pickDirectory', async () =>
    wrap(async () => {
      const result = await dialog.showOpenDialog(mainWindow ?? undefined as any, {
        title: 'Select project folder',
        properties: ['openDirectory', 'createDirectory'],
      })
      if (result.canceled || result.filePaths.length === 0) return null
      return result.filePaths[0]
    })
  )

  // ── Global teams IPC ──────────────────────────────────────────────
  // The global team library: a Record<name, TeamConfigRaw>. Each workspace
  // opts into a subset by listing names in its workspace.json `teams` array.
  ipcMain.handle('globalTeams:get', async () =>
    wrap(async () => coreConfigManager?.getTeams() ?? {})
  )

  ipcMain.handle('globalTeams:set', async (_e, teams: Record<string, unknown>) =>
    wrap(async () => {
      if (!coreConfigManager) throw new Error('Config manager not initialized')
      coreConfigManager.setTeams((teams ?? {}) as any)
      // Re-resolve the active workspace so its team Map picks up library edits
      // (e.g. members or dispatch mode changed under an enabled name).
      try { workspaceManager?.setGlobalTeamsProvider(() => coreConfigManager!.getTeams()) } catch { /* ok */ }
    })
  )

  // ── Workers generate IPC ──────────────────────────────────────────
  ipcMain.handle('workers:generate', async (_e, prompt: string) =>
    wrap(async () => {
      const { generateWorker, AgentFactory } = await import('@codey/core')
      const factory = new AgentFactory()
      const root = resolveDataRoot()
      const activeAgent = (inProcessGateway as any)?.config?.defaultAgent ?? 'claude-code'
      // Reuse the gateway's credential-aware resolver so apiKey+baseUrl
      // from the active profile flow through. Without this, MiniMax
      // (or any custom-endpoint routing) never receives its auth and
      // the spawned CLI exits 1 hitting the default endpoint.
      const activeModel = (inProcessGateway as any)?.getDefaultModelConfig?.(activeAgent)
        ?? { provider: 'anthropic', model: 'claude-sonnet-4-5' }
      const result = await generateWorker(
        {
          agentFactory: factory,
          workerManager: workerManager!,
          workersDir: join(root, 'workers'),
          activeAgent,
          activeModel,
          workingDir: root,
        },
        prompt,
      )
      if (!result.ok) throw new Error(result.error)
      return result.worker
    })
  )

  // ── Automations IPC ───────────────────────────────────────────────
  ipcMain.handle('automations:list', async () =>
    wrap(async () => inProcessGateway?.listAutomations() ?? [])
  )

  ipcMain.handle('automations:get', async (_e, id: string) =>
    wrap(async () => {
      const a = inProcessGateway?.getAutomation(id)
      if (!a) throw new Error(`Automation not found: ${id}`)
      return a
    })
  )

  ipcMain.handle('automations:create', async (_e, draft: any) =>
    wrap(async () => {
      if (!inProcessGateway) throw new Error('Gateway not ready')
      // Reject bad data (garbage tz especially) at the boundary — once stored,
      // it would make the scheduler's Intl calls throw on every tick.
      validateAutomationDraft(draft)
      return inProcessGateway.createAutomation(draft)
    })
  )

  ipcMain.handle('automations:update', async (_e, id: string, patch: any) =>
    wrap(async () => {
      if (!inProcessGateway) throw new Error('Gateway not ready')
      validateAutomationPatch(patch)
      return inProcessGateway.updateAutomation(id, patch)
    })
  )

  ipcMain.handle('automations:delete', async (_e, id: string) =>
    wrap(async () => {
      if (!inProcessGateway) throw new Error('Gateway not ready')
      inProcessGateway.deleteAutomation(id)
    })
  )

  ipcMain.handle('automations:setEnabled', async (_e, id: string, enabled: boolean) =>
    wrap(async () => {
      if (!inProcessGateway) throw new Error('Gateway not ready')
      return inProcessGateway.setAutomationEnabled(id, enabled)
    })
  )

  ipcMain.handle('automations:runNow', async (_e, id: string) =>
    wrap(async () => {
      if (!inProcessGateway) throw new Error('Gateway not ready')
      return inProcessGateway.runAutomationNow(id)
    })
  )

  ipcMain.handle('automations:runChat', async (_e, id: string) =>
    wrap(async () => {
      if (!inProcessGateway) throw new Error('Gateway not ready')
      return { chatId: await inProcessGateway.ensureAutomationRunChat(id) }
    })
  )

  ipcMain.handle('automations:resume', async (_e, id: string, runId: string, answer: string) =>
    wrap(async () => {
      if (!inProcessGateway) throw new Error('Gateway not ready')
      return inProcessGateway.resumeAutomationRun(id, runId, answer)
    })
  )

  ipcMain.handle('automations:history', async (_e, id: string, limit?: number) =>
    wrap(async () => inProcessGateway?.listAutomationRuns(id, limit) ?? [])
  )

  ipcMain.handle('automations:runLog', async (_e, id: string, runId: string) =>
    wrap(async () => inProcessGateway?.getAutomationRunLog(id, runId) ?? null)
  )

  ipcMain.handle('automations:markSeen', async (_e, id: string, runId: string) =>
    wrap(async () => {
      inProcessGateway?.markAutomationRunSeen(id, runId)
    })
  )

  ipcMain.handle('automations:chat:start', async (_e, mode: 'create' | 'edit', automationId?: string) =>
    wrap(async () => {
      if (!inProcessGateway) throw new Error('Gateway not ready')
      return inProcessGateway.startAutomationChat(mode, automationId)
    })
  )

  ipcMain.handle('automations:chat:send', async (_e, sessionId: string, text: string) =>
    wrap(async () => {
      if (!inProcessGateway) throw new Error('Gateway not ready')
      return inProcessGateway.sendAutomationChat(sessionId, text)
    })
  )

  ipcMain.handle('automations:chat:patch', async (_e, sessionId: string, patch: any) =>
    wrap(async () => {
      if (!inProcessGateway) throw new Error('Gateway not ready')
      validateAutomationChatPatch(patch)
      return inProcessGateway.patchAutomationChat(sessionId, patch)
    })
  )

  ipcMain.handle('automations:chat:save', async (_e, sessionId: string) =>
    wrap(async () => {
      if (!inProcessGateway) throw new Error('Gateway not ready')
      return inProcessGateway.saveAutomationChat(sessionId)
    })
  )

  ipcMain.handle('automations:recheck', async (_e, id: string) =>
    wrap(async () => {
      if (!inProcessGateway) throw new Error('Gateway not ready')
      inProcessGateway.recheckAutomation(id)
    })
  )

  ipcMain.handle('automations:dismissCheck', async (_e, id: string) =>
    wrap(async () => {
      if (!inProcessGateway) throw new Error('Gateway not ready')
      inProcessGateway.dismissAutomationCheck(id)
    })
  )

  ipcMain.handle('automations:chat:cancel', async (_e, sessionId: string) =>
    wrap(async () => {
      inProcessGateway?.cancelAutomationChat(sessionId)
    })
  )

  // ── Voice IPC ─────────────────────────────────────────────────────
  // Speaks an existing reply aloud. Runs the gateway's digest + TTS pipeline
  // and streams the resulting text/audio segments to the renderer, which
  // handles playback. `voice:stopSpeaking` marks the run stale so a barge-in
  // stops delivering events even though synthesis already in flight can't be
  // recalled.
  let speakRun = 0
  // Level updates arrive ~20x/s; `send` rather than `invoke` so they never
  // queue up behind a reply the sender doesn't need anyway.
  ipcMain.on('voice:hudLevel', (_e, level: number) => {
    sendVoiceHudCommand(hudLevelCommand(level))
  })

  ipcMain.handle('voice:hudState', async (_e, state: string) =>
    wrap(async () => {
      if (!state || state === 'idle' || state === 'hidden') hideVoiceHud()
      else showVoiceHud(state)
    })
  )

  ipcMain.handle('voice:stopSpeaking', async () =>
    wrap(async () => { speakRun += 1 })
  )

  ipcMain.handle('voice:toggleNativeConversation', async (_e, fromHotkey: boolean) =>
    wrap(async () => {
      const provider = coreConfigManager?.get().voice?.provider
      if (provider !== 'local') return { native: false }
      // Carried on the command instead of stashed here first: the helper
      // silently declines a toggle that arrives mid-transcription, and a
      // pre-emptive assignment then had nothing to reset it.
      if (!sendVoiceHelperCommand(conversationToggleCommand(fromHotkey === true))) {
        throw new Error('Voice Helper is not available')
      }
      return { native: true }
    })
  )

  ipcMain.handle('voice:toggleNativeDictation', async () =>
    wrap(async () => {
      const provider = coreConfigManager?.get().voice?.provider
      if (provider !== 'local') return { native: false }
      if (!sendVoiceHelperCommand('composer-dictation-toggle')) {
        throw new Error('Voice Helper is not available')
      }
      return { native: true }
    })
  )

  ipcMain.handle('voice:cancelNativeConversation', async () =>
    wrap(async () => {
      if (nativeConverseActive) sendVoiceHelperCommand('conversation-cancel')
    })
  )

  ipcMain.handle('voice:cancelNativeDictation', async () =>
    wrap(async () => {
      if (nativeDictationActive) sendVoiceHelperCommand('composer-dictation-cancel')
    })
  )

  ipcMain.handle('voice:setHotkeyCaptureActive', async (_e, active: boolean) =>
    wrap(async () => {
      voiceHotkeyCaptureActive = active === true
      const config = coreConfigManager?.get() ?? {}
      applyVoiceConverseHotkey(config)
      applyVoiceHotkey(config)
      await applyVoiceHelper(config)
    })
  )

  ipcMain.handle('voice:speak', async (_e, { text, conversationId, verbatim }: { text: string; conversationId?: string; verbatim?: boolean }) =>
    wrap(async () => {
      if (!inProcessGateway) throw new Error('Gateway not running')
      if (typeof text !== 'string' || !text.trim()) return
      speakRun += 1
      const myRun = speakRun
      await inProcessGateway.runVoiceSpeak(text, (event: any) => {
        if (myRun !== speakRun) return
        sendToRenderer('voice:speakEvent', event)
      }, conversationId, verbatim === true)
    })
  )

  ipcMain.handle('voice:ack', async (_e, transcript: string) =>
    wrap(async () => {
      if (!inProcessGateway) throw new Error('Gateway not running')
      return { text: inProcessGateway.generateVoiceAck(String(transcript ?? '')) }
    })
  )

  // Learn new dictionary words by comparing what was dictated against what the user
  // actually sent. Done here rather than in the renderer because the merge is
  // read-modify-write on the shared voice config: config:set replaces the
  // whole `voice` object, so a renderer doing this itself would clobber any
  // field the Settings tab changed in between.
  ipcMain.handle('voice:learnVocabulary', async (_e, payload: { spoken?: string; edited?: string }) =>
    wrap(async () => {
      if (!coreConfigManager) return { learned: [] }
      const spoken = String(payload?.spoken ?? '')
      const edited = String(payload?.edited ?? '')
      if (!spoken.trim() || !edited.trim()) return { learned: [] }

      const voice = (coreConfigManager.get() as any)?.voice
      if (!voice || voice.vocabularyAutoLearn === false) return { learned: [] }

      const corrections = learnCorrections(spoken, edited)
      if (corrections.length === 0) return { learned: [] }

      const current = normalizeVocabulary(voice.vocabulary)
      const pending = normalizePending(voice.vocabularyPending)

      // A correction has to be seen twice before it enters the dictionary.
      // The first sighting only goes on the waiting list, which keeps a
      // deliberate one-off edit from becoming a permanent hint.
      const seen = recordCorrections(pending, current, corrections)
      if (seen.promoted.length === 0) {
        if (seen.pending !== pending) {
          coreConfigManager.update({ voice: { ...voice, vocabularyPending: seen.pending } } as any)
        }
        return { learned: [] }
      }

      const merged = mergeLearnedTerms(current, seen.promoted)
      if (!merged.changed) {
        coreConfigManager.update({ voice: { ...voice, vocabularyPending: seen.pending } } as any)
        return { learned: [] }
      }

      coreConfigManager.update({
        voice: { ...voice, vocabulary: merged.terms, vocabularyPending: seen.pending },
      } as any)
      mainWindow?.webContents.send('voice:vocabularyLearned', merged.terms)
      // The alias goes back with each word purely so undo can find its waiting
      // list entry; it is not stored anywhere and the pill does not show it.
      const promotedFor = (term: string) =>
        seen.promoted.find(p => p.term.toLowerCase() === term.toLowerCase())?.alias ?? ''
      return { learned: merged.added.map(term => ({ term, alias: promotedFor(term) })) }
    })
  )

  // Undo for a correction the composer pill just announced. Has to clear the
  // waiting list too: the same swap sitting at one sighting would otherwise
  // go active on the user's very next correction of it.
  ipcMain.handle('voice:forgetVocabulary', async (_e, payload: { term?: string; alias?: string }) =>
    wrap(async () => {
      if (!coreConfigManager) return { ok: false }
      const term = String(payload?.term ?? '')
      const alias = String(payload?.alias ?? '')
      if (!term || !alias) return { ok: false }
      const voice = (coreConfigManager.get() as any)?.voice
      if (!voice) return { ok: false }

      const next = forgetCorrection(
        normalizeVocabulary(voice.vocabulary),
        normalizePending(voice.vocabularyPending),
        { term, alias },
      )
      coreConfigManager.update({
        voice: { ...voice, vocabulary: next.terms, vocabularyPending: next.pending },
      } as any)
      mainWindow?.webContents.send('voice:vocabularyLearned', next.terms)
      return { ok: true }
    })
  )

  ipcMain.handle('voice:transcribed', async (_e, text: string) =>
    wrap(async () => {
      if (typeof text !== 'string' || !text.trim()) return
      clipboard.writeText(text)
      // Auto-paste at the cursor of whatever app is foregrounded. We only
      // attempt this on macOS and only when the Codey window isn't focused —
      // if the user is typing into Codey itself, the renderer handles paste
      // through the normal clipboard. Sending Cmd+V via System Events
      // requires Accessibility permission; if denied, the clipboard fallback
      // still lets the user paste manually.
      const codeyFocused = mainWindow?.isFocused() === true
      if (process.platform === 'darwin' && !codeyFocused) {
        try {
          const { spawn } = await import('child_process')
          await new Promise<void>((resolve) => {
            const p = spawn('osascript', [
              '-e',
              'tell application "System Events" to keystroke "v" using command down',
            ])
            const t = setTimeout(() => { try { p.kill() } catch { /* gone */ } resolve() }, 2000)
            p.on('close', () => { clearTimeout(t); resolve() })
            p.on('error', () => { clearTimeout(t); resolve() })
          })
        } catch { /* clipboard remains available */ }
      }
      // The clipboard remains the fallback when auto-paste is unavailable.
      // Voice input deliberately does not create a system notification.
    })
  )

  ipcMain.handle('voice:transcribe', async (_e, payload: { audio: ArrayBuffer; mime: string }) =>
    wrap(async () => {
      if (!coreConfigManager) throw new Error('Gateway configuration is not available')
      const voice = coreConfigManager.getResolvedVoiceConfig()
      if (!voice) throw new Error('Voice is not configured')
      if (voice.provider === 'local') {
        throw new Error('Conversation recording currently requires API transcription; choose API under Voice → Speech recognition.')
      }
      if (!voice.apiKey) throw new Error('Select a Transcription key under Voice → Speech recognition.')
      const audio = payload?.audio
      if (!(audio instanceof ArrayBuffer) || audio.byteLength === 0) throw new Error('The recording was empty')
      const mime = typeof payload?.mime === 'string' && payload.mime ? payload.mime : 'audio/webm'
      const base = (voice.apiUrl || 'https://api.openai.com/v1').replace(/\/+$/, '')
      const form = new FormData()
      form.append('file', new Blob([audio], { type: mime }), mime.includes('webm') ? 'audio.webm' : 'audio.mp4')
      form.append('model', voice.apiModel || 'gpt-4o-mini-transcribe')
      if (voice.language && voice.language !== 'auto') form.append('language', voice.language)
      const response = await fetch(`${base}/audio/transcriptions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${voice.apiKey}` },
        body: form,
      })
      if (!response.ok) {
        const detail = (await response.text().catch(() => '')).trim()
        throw new Error(`Transcription failed (${response.status})${detail ? `: ${detail.slice(0, 240)}` : ''}`)
      }
      const body = await response.json() as any
      return { text: typeof body?.text === 'string' ? body.text.trim() : '' }
    })
  )

  ipcMain.handle('voice:error', async (_e, message: string) =>
    wrap(async () => {
      const detail = String(message ?? 'Unknown error')
      console.warn('Voice input failed:', detail)
      sendToRenderer('gateway-log', `[voice] ${detail}`)
      if (!mainWindow?.isFocused()) {
        new Notification({ title: 'Voice input failed', body: detail }).show()
      }
    })
  )

  // Pre-fetches a WhisperKit model variant by spawning the helper in
  // download-only mode. Streams `voice:downloadProgress` events to the renderer
  // so it can show a progress bar; resolves with success/error on exit.
  ipcMain.handle('voice:downloadModel', async (_e, modelName: string) =>
    wrap(async () => {
      if (process.platform !== 'darwin') throw new Error('Voice helper is macOS-only')
      if (typeof modelName !== 'string' || !modelName.trim()) throw new Error('Model name required')
      const bin = resolveVoiceHelperBinary()
      if (!bin) throw new Error('Voice helper binary not found')

      const { spawn } = require('child_process') as typeof import('child_process')
      const proc = spawn(bin, ['--download-model', modelName], { stdio: ['ignore', 'pipe', 'pipe'] })

      let lastErr = ''
      const onLine = (line: string) => {
        const s = line.trim()
        if (!s) return
        sendToRenderer('gateway-log', `[voice-download] ${s}`)
        if (s.startsWith('download:progress ')) {
          const pct = parseFloat(s.slice('download:progress '.length))
          if (!Number.isNaN(pct)) {
            sendToRenderer('voice:downloadProgress', { model: modelName, fraction: pct })
          }
        } else if (s.startsWith('download:error ')) {
          lastErr = s.slice('download:error '.length)
        }
      }
      const wireLines = (stream: NodeJS.ReadableStream | null) => {
        if (!stream) return
        let buf = ''
        stream.on('data', (chunk: Buffer) => {
          buf += chunk.toString()
          let idx: number
          while ((idx = buf.indexOf('\n')) >= 0) {
            onLine(buf.slice(0, idx))
            buf = buf.slice(idx + 1)
          }
        })
        stream.on('end', () => { if (buf) onLine(buf) })
      }
      wireLines(proc.stdout)
      wireLines(proc.stderr)

      const code: number = await new Promise(resolve => proc.on('exit', c => resolve(c ?? 1)))
      if (code !== 0) throw new Error(lastErr || `Download failed (exit ${code})`)
      return { model: modelName }
    })
  )

  // Warms a downloaded WhisperKit model: spawns the helper in --warm-model mode
  // which forces CoreML's per-machine compile to complete and cache. After this
  // succeeds, the model loads in ~200ms on subsequent Fn presses instead of
  // 30-90s. On success we persist a marker so the UI shows ⚡ for warmed models.
  ipcMain.handle('voice:warmModel', async (_e, modelName: string) =>
    wrap(async () => runVoiceModelWarm(modelName))
  )

  ipcMain.handle('voice:warmState', async () =>
    wrap(async () => currentVoiceWarm())
  )

  ipcMain.handle('voice:listWarmedModels', async () =>
    wrap(async () => {
      // Stale markers are dropped by the shared check, so the UI shows the
      // "downloaded" state rather than "warmed" after an OS or app update and
      // WhisperTab's auto-warm effect re-warms the selected model.
      return warmedVoiceModels()
    })
  )

  // Lists WhisperKit model folders currently on disk. WhisperKit stores
  // downloaded variants under ~/Documents/huggingface/models/argmaxinc/
  // whisperkit-coreml/<variant>/. We return the raw folder names so the
  // renderer can match against either the bare variant or the full
  // openai_whisper-<variant> form used in the UI dropdown.
  ipcMain.handle('voice:listDownloadedModels', async () =>
    wrap(async () => listDownloadedVoiceModels())
  )

  // Deletes a WhisperKit model variant from disk: the HuggingFace download
  // folder(s) and the warm marker entry. Caller passes any of the three name
  // forms ("openai_whisper-X", "X", or the canonical folder name) — we try
  // each candidate folder. Returns the list of paths actually removed.
  ipcMain.handle('voice:deleteModel', async (_e, modelName: string) =>
    wrap(async () => {
      const fsMod = await import('fs')
      const pathMod = await import('path')
      if (!modelName || typeof modelName !== 'string') {
        throw new Error('modelName required')
      }
      const bare = modelName.startsWith('openai_whisper-')
        ? modelName.slice('openai_whisper-'.length)
        : modelName
      const variants = new Set([modelName, bare, `openai_whisper-${bare}`])
      const home = app.getPath('home')
      const roots = [
        pathMod.join(home, 'Documents', 'huggingface', 'models', 'argmaxinc', 'whisperkit-coreml'),
        pathMod.join(home, 'Library', 'Application Support', 'huggingface', 'models', 'argmaxinc', 'whisperkit-coreml'),
      ]
      const removed: string[] = []
      for (const root of roots) {
        if (!fsMod.existsSync(root)) continue
        for (const v of variants) {
          const full = pathMod.join(root, v)
          if (fsMod.existsSync(full)) {
            fsMod.rmSync(full, { recursive: true, force: true })
            removed.push(full)
          }
        }
      }
      try {
        const markers = readWarmMarkers()
        let changed = false
        for (const v of variants) {
          if (v in markers) { delete markers[v]; changed = true }
        }
        if (changed) {
          fsMod.writeFileSync(warmMarkerPath(), JSON.stringify(markers, null, 2))
        }
      } catch (e) {
        console.warn('voice:deleteModel: failed to update warm markers:', e)
      }
      return { removed }
    })
  )

  // ── Config IPC ────────────────────────────────────────────────────
  ipcMain.handle('config:get', async () =>
    wrap(async () => coreConfigManager?.get() ?? {})
  )

  ipcMain.handle('config:set', async (_e, updates: any) =>
    wrap(async () => {
      if (!coreConfigManager) throw new Error('Config manager not initialized')
      coreConfigManager.update(updates)
    })
  )

  // ── Plugins IPC ───────────────────────────────────────────────────
  ipcMain.handle('plugins:list', async () =>
    wrap(async () => listPlugins(id => id === 'browser' ? browserSkillStatus() : chromeCompanionSkillStatus()))
  )

  // Installing writes the skill into the user's own ~/.codey/skills and links
  // it for every agent, so from here on the Skills tab owns it. Uninstalling
  // removes it; both are explicit user actions, and nothing rewrites the
  // directory in between.
  // `force` is the user having confirmed replacing or deleting a skill of the
  // same name that Codey did not write. Without it the core refuses, and the
  // card asks.
  ipcMain.handle('plugins:install', async (_e, id: string, force?: boolean) =>
    wrap(async () => {
      if (!isKnownPlugin(id)) throw new Error(`Unknown plugin: ${id}`)
      const result = id === 'browser'
        ? await installBrowserSkill(undefined, { force: force === true })
        : await installChromeCompanionSkill(undefined, { force: force === true })
      if (result.installed) await syncCodeyGlobalSkills()
      return result
    })
  )

  ipcMain.handle('plugins:uninstall', async (_e, id: string, force?: boolean) =>
    wrap(async () => {
      if (!isKnownPlugin(id)) throw new Error(`Unknown plugin: ${id}`)
      const result = id === 'browser'
        ? await uninstallBrowserSkill(undefined, { force: force === true })
        : await uninstallChromeCompanionSkill(undefined, { force: force === true })
      if (result.removed) await syncCodeyGlobalSkills()
      return result
    })
  )

  // Plugin switches are reversible. Chrome Companion owns a bundled-skill
  // helper; downloaded plugins use the same SKILL.md <-> SKILL.md.disabled
  // move as the Skills screen. Installing an absent optional plugin remains a
  // separate operation handled by plugins:install.
  ipcMain.handle('plugins:setEnabled', async (_e, id: string, enabled: boolean) =>
    wrap(async () => {
      if (!isKnownPlugin(id)) throw new Error(`Unknown plugin: ${id}`)
      if (typeof enabled !== 'boolean') throw new Error('Invalid enabled flag')
      if (id === 'chrome-companion') {
        await setChromeCompanionSkillEnabled(enabled)
      } else {
        const plugin = browserSkillStatus()
        if (plugin.state === 'absent') throw new Error(`Plugin ${id} is not installed`)
        const fsMod = await import('fs')
        const pathMod = await import('path')
        setSkillEnabled(fsMod, pathMod, plugin.dir, enabled)
      }
      await syncCodeyGlobalSkills()
      return listPlugins(pluginId => pluginId === 'browser' ? browserSkillStatus() : chromeCompanionSkillStatus())
        .find(plugin => plugin.id === id)!
    })
  )

  // "Is there an update?" never throws at the renderer: when the published
  // folder cannot be reached the card quietly says nothing is known, rather
  // than breaking the whole Plugins tab over a network blip.
  ipcMain.handle('plugins:check', async (_e, id: string) =>
    wrap(async () => {
      if (!isKnownPlugin(id)) throw new Error(`Unknown plugin: ${id}`)
      try {
        return id === 'browser' ? await checkBrowserSkillUpdate() : await checkChromeCompanionSkillUpdate()
      } catch {
        return { needsUpdate: null }
      }
    })
  )

  // ── External MCP servers IPC ──────────────────────────────────────
  ipcMain.handle('mcp:list', async () =>
    wrap(async () => {
      const servers = (coreConfigManager?.get() as any)?.mcpServers ?? {}
      return Object.entries(servers)
        // A hand-edited codey-browser entry can never reach agents; hide it here too.
        .filter(([name]) => name !== 'codey-browser')
        .map(([name, cfg]) => ({ name, ...(cfg as object) }))
    })
  )

  // Servers the user already configured inside the coding agents themselves.
  // Read-only: Codey does not own these files, it only reports what is there.
  ipcMain.handle('mcp:listAgent', async () =>
    wrap(async () => {
      const fsMod = await import('fs')
      const pathMod = await import('path')
      const osMod = await import('os')
      const agents = coreConfigManager?.get().agents as Record<string, { env?: Record<string, string> }> | undefined
      const agentEnv: Partial<Record<McpAgentKey, Record<string, string> | undefined>> = {
        'claude-code': agents?.['claude-code']?.env,
        codex: agents?.codex?.env,
        opencode: agents?.opencode?.env,
      }
      return scanAgentMcpServers({
        fs: fsMod,
        path: pathMod,
        home: osMod.homedir(),
        workingDir: getWorkingDir(fsMod, pathMod),
        agentEnv,
      }) satisfies AgentMcpServer[]
    })
  )

  ipcMain.handle('mcp:save', async (_e, draft: ExternalMcpDraft) =>
    wrap(async () => {
      if (!coreConfigManager) throw new Error('Config manager not initialized')
      const result = validateExternalMcp(draft)
      if (!result.ok) throw new Error(result.error)
      coreConfigManager.setExternalMcpServer(result.name, result.config)
    })
  )

  ipcMain.handle('mcp:remove', async (_e, name: string) =>
    wrap(async () => {
      if (!coreConfigManager) throw new Error('Config manager not initialized')
      coreConfigManager.removeExternalMcpServer(String(name))
    })
  )

  ipcMain.handle('mcp:setEnabled', async (_e, name: string, enabled: boolean) =>
    wrap(async () => {
      if (!coreConfigManager) throw new Error('Config manager not initialized')
      const existing = coreConfigManager.get().mcpServers?.[String(name)]
      if (!existing) throw new Error(`Unknown MCP server: ${name}`)
      coreConfigManager.setExternalMcpServer(String(name), { ...existing, enabled: enabled === true })
    })
  )

  // ── Models IPC ────────────────────────────────────────────────────
  ipcMain.handle('models:list', async () =>
    wrap(async () => coreConfigManager?.listModels() ?? [])
  )

  ipcMain.handle('models:save', async (_e, entry: any) =>
    wrap(async () => {
      if (!coreConfigManager) throw new Error('Config manager not initialized')
      if (!entry?.model) throw new Error('Model id is required')
      if (entry.apiType !== 'anthropic' && entry.apiType !== 'openai' && entry.apiType !== 'all') {
        throw new Error('Model apiType must be "anthropic", "openai", or "all"')
      }
      coreConfigManager.saveModel(entry)
    })
  )

  ipcMain.handle('models:delete', async (_e, name: string) =>
    wrap(async () => {
      if (!coreConfigManager) throw new Error('Config manager not initialized')
      coreConfigManager.deleteModel(name)
    })
  )

  ipcMain.handle('models:rename', async (_e, oldName: string, newName: string) =>
    wrap(async () => {
      if (!coreConfigManager) throw new Error('Config manager not initialized')
      coreConfigManager.renameModel(oldName, newName)
    })
  )

  // ── API Keys IPC ──────────────────────────────────────────────────
  ipcMain.handle('apiKeys:list', async () =>
    wrap(async () => coreConfigManager?.listApiKeys() ?? [])
  )

  ipcMain.handle('apiKeys:save', async (_e, entry: any) =>
    wrap(async () => {
      if (!coreConfigManager) throw new Error('Config manager not initialized')
      if (!entry?.name?.trim()) throw new Error('API name is required')
      if (!entry.apiKey?.trim()) throw new Error('API key is required')
      coreConfigManager.saveApiKey(entry)
    })
  )

  ipcMain.handle('apiKeys:delete', async (_e, name: string) =>
    wrap(async () => {
      if (!coreConfigManager) throw new Error('Config manager not initialized')
      coreConfigManager.deleteApiKey(name)
    })
  )

  ipcMain.handle('apiKeys:rename', async (_e, oldName: string, newName: string) =>
    wrap(async () => {
      if (!coreConfigManager) throw new Error('Config manager not initialized')
      coreConfigManager.renameApiKey(oldName, newName)
    })
  )

  // ── Advisor (formerly Dispatcher) IPC ─────────────────────────────
  // The advisor block selects the agent + model that decides which workers
  // a `dispatch: 'auto'` team uses, and runs the /team manager. Empty values
  // mean "use gateway default". IPC channel kept as `dispatcher:*` for
  // back-compat with the renderer; underlying field is `advisor`.
  ipcMain.handle('dispatcher:get', async () =>
    wrap(async () => {
      const cfg = coreConfigManager?.get()
      return { agent: cfg?.advisor?.agent, model: cfg?.advisor?.model }
    })
  )

  ipcMain.handle('dispatcher:set', async (_e, updates: { agent?: string; model?: string } | null | undefined) =>
    wrap(async () => {
      if (!coreConfigManager) throw new Error('Config manager not initialized')
      const agent = updates?.agent || undefined
      const model = updates?.model || undefined
      coreConfigManager.update({ advisor: { agent: agent as any, model } })
    })
  )

  // ── Aide IPC ──────────────────────────────────────────────────────
  // Lightweight global model used for housekeeping tasks (chat summarization,
  // title generation, classification). Empty values mean "use gateway default".
  ipcMain.handle('aide:get', async () =>
    wrap(async () => {
      const cfg = coreConfigManager?.get()
      return { agent: cfg?.aide?.agent, model: cfg?.aide?.model }
    })
  )

  ipcMain.handle('aide:set', async (_e, updates: { agent?: string; model?: string } | null | undefined) =>
    wrap(async () => {
      if (!coreConfigManager) throw new Error('Config manager not initialized')
      const agent = updates?.agent || undefined
      const model = updates?.model || undefined
      coreConfigManager.update({ aide: { agent: agent as any, model } })
    })
  )

  // ── Fallback IPC ──────────────────────────────────────────────────
  ipcMain.handle('fallback:get', async () =>
    wrap(async () => coreConfigManager?.getFallback() ?? { enabled: true, order: [] })
  )

  ipcMain.handle('fallback:set', async (_e, fb: any) =>
    wrap(async () => {
      if (!coreConfigManager) throw new Error('Config manager not initialized')
      coreConfigManager.setFallback({ enabled: !!fb?.enabled, order: Array.isArray(fb?.order) ? fb.order : [] })
    })
  )

  // ── Agents IPC ────────────────────────────────────────────────────
  ipcMain.handle('agents:get', async () =>
    wrap(async () => {
      const cfg = coreConfigManager?.get()
      return cfg?.agents ?? {}
    })
  )

  ipcMain.handle('agents:set', async (_e, updates: any) =>
    wrap(async () => {
      if (!coreConfigManager) throw new Error('Config manager not initialized')
      coreConfigManager.update({ agents: updates })
    })
  )

  ipcMain.handle('agents:checkInstalled', async (_e, force?: boolean) =>
    wrap(async () => getInstalledAgents(force === true))
  )

  // Installed + published, in one call: the panel needs both to decide whether
  // to offer an update at all, and asking for them separately would show the
  // button flicker into existence a second after the versions land.
  ipcMain.handle('agents:updateStatus', async (_e, force?: boolean) =>
    wrap(async () => agentUpdateStatus(force === true))
  )

  // Update one agent CLI in place. The re-probe afterwards is not optional:
  // the version on screen is the reason the user pressed the button, and a
  // successful update that still reads as the old version looks like a failure.
  ipcMain.handle('agents:update', async (_e, agent: string) =>
    wrap(async () => {
      const probed = await getInstalledAgents(false)
      const plan = updatePlanFor(agent, probed.status[agent])
      if (!plan) throw new Error(`No update available for ${agent} — its CLI was not found.`)
      const outcome = await runAgentUpdate({
        plan,
        spawn: (await import('child_process')).spawn,
        shell: process.env.SHELL || '/bin/zsh',
      })
      // Re-probe, and re-decide: after a successful update the button must
      // disappear, which only happens if the comparison is redone here.
      const after = await agentUpdateStatus(true)
      return { ...outcome, status: after.status, updates: after.updates }
    })
  )

  // ── Skills IPC ────────────────────────────────────────────────────
  const skillPaths: Record<string, { userDirs: string[]; projectSubdirs: string[] }> = {
    // Codey's own skills live globally in ~/.codey/skills and, for skills that
    // belong to one repository, in <project>/.codey/skills.
    'codey':       { userDirs: [CODEY_GLOBAL_SKILLS_SUBDIR], projectSubdirs: [CODEY_SKILLS_SUBDIR] },
    'claude-code': { userDirs: ['.claude/skills'], projectSubdirs: [CODEY_SKILLS_SUBDIR, '.claude/skills'] },
    // Codex and OpenCode also discover the cross-agent .agents convention.
    'codex':       { userDirs: ['.codex/skills', '.agents/skills'], projectSubdirs: [CODEY_SKILLS_SUBDIR, '.codex/skills', '.agents/skills'] },
    'opencode':    { userDirs: ['.config/opencode/skills', '.opencode/skills', '.agents/skills'], projectSubdirs: [CODEY_SKILLS_SUBDIR, '.opencode/skills', '.agents/skills'] },
    'pi':          { userDirs: ['.pi/agent/skills', '.agents/skills'], projectSubdirs: [CODEY_SKILLS_SUBDIR, '.pi/skills', '.agents/skills'] },
  }

  function configuredUserSkillDirs(agentKey: string, home: string, pathMod: typeof import('path')): string[] {
    const paths = skillPaths[agentKey] ?? skillPaths['claude-code']
    const env = coreConfigManager?.get().agents?.[agentKey as keyof ReturnType<ConfigManager['get']>['agents']]?.env ?? {}
    const configured: string[] = []
    if (agentKey === 'claude-code' && env.CLAUDE_CONFIG_DIR) {
      configured.push(pathMod.join(resolveUserPath(pathMod, env.CLAUDE_CONFIG_DIR, home), 'skills'))
    }
    if (agentKey === 'codex' && env.CODEX_HOME) {
      configured.push(pathMod.join(resolveUserPath(pathMod, env.CODEX_HOME, home), 'skills'))
    }
    if (agentKey === 'opencode' && env.XDG_CONFIG_HOME) {
      configured.push(pathMod.join(resolveUserPath(pathMod, env.XDG_CONFIG_HOME, home), 'opencode', 'skills'))
    }
    return [...configured, ...paths.userDirs.map(rel => pathMod.join(home, rel))]
  }

  /**
   * Working directory of a NAMED workspace, or of the active one when no name
   * is given. Unlike WorkspaceManager.getWorkingDirFor this does not fall back
   * to the active workspace for an unknown name: an install must never write
   * into a repository the user did not pick.
   */
  function getWorkingDir(
    fsMod: typeof import('fs'),
    pathMod: typeof import('path'),
    workspace?: string,
  ): string | null {
    if (!workspaceManager) return null
    const wsName = workspace || workspaceManager.getCurrentWorkspace()
    if (!wsName) return null
    const configPath = pathMod.join(workspaceManager.getWorkspacesRoot(), wsName, 'workspace.json')
    if (!fsMod.existsSync(configPath)) return null
    try {
      const data = JSON.parse(fsMod.readFileSync(configPath, 'utf-8'))
      return data.workingDir ?? null
    } catch { return null }
  }

  async function listAgentSkills(agentKey: string, workspace?: string): Promise<{ skills: ScannedSkill[]; projectDir: string | null }> {
    const fsMod = await import('fs')
    const pathMod = await import('path')
    const osMod = await import('os')
    const home = osMod.homedir()
    const paths = skillPaths[agentKey] ?? skillPaths['claude-code']

    const skills: ScannedSkill[] = []
    for (const dir of configuredUserSkillDirs(agentKey, home, pathMod)) {
      skills.push(...scanSkillsDir(fsMod, pathMod, dir, 'user'))
    }
    if (agentKey === 'claude-code') {
      const env = coreConfigManager?.get().agents?.['claude-code']?.env ?? {}
      const configRoot = env.CLAUDE_CONFIG_DIR
        ? resolveUserPath(pathMod, env.CLAUDE_CONFIG_DIR, home)
        : pathMod.join(home, '.claude')
      skills.push(...scanClaudePluginSkills(
        fsMod,
        pathMod,
        pathMod.join(configRoot, 'plugins', 'installed_plugins.json'),
      ))
    }

    let projectDir: string | null = null
    const workingDir = getWorkingDir(fsMod, pathMod, workspace)
    if (workingDir) {
      for (const rel of paths.projectSubdirs) {
        const dir = pathMod.join(workingDir, rel)
        if (!projectDir) projectDir = dir
        skills.push(...scanSkillsDir(fsMod, pathMod, dir, 'project'))
      }
    }

    let listed = uniqueSkills(fsMod, pathMod, skills)
    const browser = browserSkillStatus(home)
    if (browser.origin === 'codey') {
      listed = markSkillManagedBy(fsMod, pathMod, listed, browser.dir, 'codey')
    }
    return { skills: listed, projectDir }
  }

  ipcMain.handle('agents:slashCommands', async (_e, agent: string) =>
    wrap(async () => {
      const [discovered, skillResult] = await Promise.all([
        discoverSlashCommands(agent),
        listAgentSkills(agent),
      ])
      const qq: SlashCommand = {
        name: 'qq',
        description: 'Quick Question — ask about this chat without affecting it',
        source: 'gateway',
      }
      // Filter before mapping: `skillAliases` below is derived from this array,
      // so a disabled skill left in would still suppress the agent's own
      // command of the same bare name.
      const skills: SlashCommand[] = skillResult.skills
        .filter(skill => skill.enabled)
        .map(skill => ({
          name: skill.qualifiedName,
          description: skill.description || 'Agent skill',
          source: 'skill',
        }))
      // Gateway commands take precedence, then installed skills, then the
      // agent's own commands. A Set keeps the menu stable when a skill and an
      // agent command happen to share a name.
      const seen = new Set<string>()
      const skillAliases = new Set(skills.flatMap(command => {
        const separator = command.name.lastIndexOf(':')
        return separator >= 0 ? [command.name.slice(separator + 1).toLowerCase()] : []
      }))
      return [qq, ...skills, ...discovered].filter(command => {
        const key = command.name.toLowerCase()
        if (command.source === 'agent' && skillAliases.has(key)) return false
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
    })
  )

  ipcMain.handle('skills:list', async (_e, agent?: string, workspace?: string) =>
    wrap(async () => {
      const agentKey = agent ?? 'claude-code'
      return listAgentSkills(agentKey, workspace)
    })
  )

  // Transcripts are large and append-only; the cache lives for the app session
  // so re-opening the Skills tab only reads whatever grew since the last scan.
  const skillUsageCache = new Map<string, UsageCacheEntry>()

  ipcMain.handle('skills:usage', async (_e, agent?: string) =>
    wrap(async () => {
      const agentKey = agent ?? 'claude-code'
      // Only Claude Code records skill invocations in a format we can read;
      // for the others the Skills tab falls back to name ordering.
      if (agentKey !== 'claude-code') return {} as SkillUsageMap
      const fsMod = await import('fs')
      const pathMod = await import('path')
      const osMod = await import('os')
      const env = coreConfigManager?.get().agents?.['claude-code']?.env ?? {}
      const configRoot = env.CLAUDE_CONFIG_DIR
        ? resolveUserPath(pathMod, env.CLAUDE_CONFIG_DIR, osMod.homedir())
        : pathMod.join(osMod.homedir(), '.claude')
      return scanSkillUsage(fsMod, pathMod, [pathMod.join(configRoot, 'projects')], skillUsageCache)
    })
  )

  ipcMain.handle('skills:install', async (_e, payload: { agent?: string; scope: 'user' | 'project'; workspace?: string; localDir?: string; gitUrl?: string }) =>
    wrap(async () => {
      const fsMod = await import('fs')
      const pathMod = await import('path')
      const osMod = await import('os')
      const agentKey = payload.agent ?? 'claude-code'
      const paths = skillPaths[agentKey] ?? skillPaths['claude-code']

      const home = osMod.homedir()
      let projectWorkingDir: string | undefined
      // Codey skills are exposed to the agents through compatibility links, so
      // every install refreshes the links for whichever root it wrote into.
      const relink = async () => {
        if (projectWorkingDir) await syncCodeyProjectSkills(projectWorkingDir)
        else if (agentKey === 'codey') await syncCodeyGlobalSkills(home)
      }
      const getTargetRoot = async (): Promise<string> => {
        if (payload.scope === 'user') return configuredUserSkillDirs(agentKey, home, pathMod)[0]
        if (!workspaceManager) throw new Error('No workspace manager')
        // A project install targets whichever workspace the user picked, not
        // whichever one happens to be active.
        const wsName = payload.workspace || workspaceManager.getCurrentWorkspace()
        if (!wsName) throw new Error('No active workspace')
        if (!workspaceManager.listWorkspaces().includes(wsName)) {
          throw new Error(`Unknown workspace: ${wsName}`)
        }
        const workingDir = getWorkingDir(fsMod, pathMod, wsName)
        if (!workingDir) throw new Error(`Workspace "${wsName}" has no working directory`)
        projectWorkingDir = workingDir
        return pathMod.join(workingDir, paths.projectSubdirs[0])
      }

      const targetRoot = await getTargetRoot()
      await fsMod.promises.mkdir(targetRoot, { recursive: true })

      if (payload.localDir) {
        const src = resolveUserPath(pathMod, payload.localDir, home)
        if (!fsMod.existsSync(src) || !fsMod.statSync(src).isDirectory()) throw new Error(`Not a directory: ${src}`)
        if (samePath(fsMod, pathMod, src, targetRoot)) {
          await relink()
          return { name: pathMod.basename(targetRoot), dir: targetRoot }
        }
        const rootSkillFile = pathMod.join(src, SKILL_FILE)

        const discovered = fsMod.existsSync(rootSkillFile)
          ? []
          : scanSkillsDir(fsMod, pathMod, src, 'user')

        // Preserve a named collection directory (for example `superpowers`)
        // so its namespace survives installation. A generic `skills/` root is
        // still imported child-by-child and never copied into itself.
        const sourceName = pathMod.basename(src)
        const preserveCollection = discovered.length > 0
          && sourceName !== 'skills'
          && !sourceName.startsWith('.')
        const sources = fsMod.existsSync(rootSkillFile) || preserveCollection
          ? [{ name: sourceName, dir: src }]
          : discovered.map(skill => ({ name: pathMod.basename(skill.dir), dir: skill.dir }))
        if (sources.length === 0) throw new Error(`No SKILL.md found in: ${src}`)

        for (const source of sources) {
          const dest = pathMod.join(targetRoot, source.name)
          if (!samePath(fsMod, pathMod, source.dir, dest) && fsMod.existsSync(dest)) {
            throw new Error(`Skill already exists: ${source.name}`)
          }
        }

        const installed: Array<{ name: string; dir: string }> = []
        for (const source of sources) {
          const dest = pathMod.join(targetRoot, source.name)
          if (samePath(fsMod, pathMod, source.dir, dest)) {
            installed.push({ name: source.name, dir: dest })
            continue
          }
          await fsMod.promises.cp(source.dir, dest, { recursive: true })
          installed.push({ name: source.name, dir: dest })
        }
        await relink()
        return installed.length === 1 ? installed[0] : { name: `${installed.length} skills`, dir: targetRoot }
      }

      if (payload.gitUrl) {
        const { execFile } = await import('child_process')
        const { promisify } = await import('util')
        const execFileAsync = promisify(execFile)
        const url = payload.gitUrl.trim()
        const name = pathMod.basename(url, '.git')
        const dest = pathMod.join(targetRoot, name)
        if (fsMod.existsSync(dest)) throw new Error(`Skill already exists: ${name}`)
        await execFileAsync('git', ['clone', '--depth', '1', url, dest])
        await relink()
        return { name, dir: dest }
      }

      throw new Error('Either localDir or gitUrl is required')
    })
  )

  ipcMain.handle('skills:setEnabled', async (_e, dir: string, enabled: boolean) =>
    wrap(async () => {
      if (typeof dir !== 'string' || !dir) throw new Error('Invalid path')
      if (typeof enabled !== 'boolean') throw new Error('Invalid enabled flag')
      const fsMod = await import('fs')
      const pathMod = await import('path')
      setSkillEnabled(fsMod, pathMod, dir, enabled)
    })
  )

  ipcMain.handle('skills:remove', async (_e, dir: string) =>
    wrap(async () => {
      if (typeof dir !== 'string' || !dir) throw new Error('Invalid path')
      const fsMod = await import('fs')
      const pathMod = await import('path')
      await fsMod.promises.rm(dir, { recursive: true, force: true })
      // Relink the project the skill actually lived in, which is not
      // necessarily the active workspace once installs can target any of them.
      const removed = pathMod.resolve(dir)
      const owning = (workspaceManager?.listWorkspaces() ?? [])
        .map(name => getWorkingDir(fsMod, pathMod, name))
        .filter((wd): wd is string => wd !== null)
        .find(wd => removed.startsWith(`${pathMod.resolve(wd)}${pathMod.sep}`))
      const workingDir = owning ?? getWorkingDir(fsMod, pathMod)
      if (workingDir) await syncCodeyProjectSkills(workingDir)
      await syncCodeyGlobalSkills()
    })
  )

  ipcMain.handle('skills:reveal', async (_e, dir: string) =>
    wrap(async () => { shell.showItemInFolder(dir) })
  )

  // ── Agent memory IPC ──────────────────────────────────────────────
  // Read-only: the instruction files each agent CLI loads by itself. User
  // memory (what an agent knows about the user, everywhere) is shown in the
  // Agents settings; project memory belongs to a workspace.
  function agentEnv(agent: string): Record<string, string> {
    return coreConfigManager?.get().agents?.[agent as keyof ReturnType<ConfigManager['get']>['agents']]?.env ?? {}
  }

  ipcMain.handle('memory:user', async () =>
    wrap(async () => {
      const fsMod = await import('fs')
      const pathMod = await import('path')
      const osMod = await import('os')
      const home = osMod.homedir()
      return {
        agents: Object.keys(AGENT_MEMORY).map(agent => ({
          agent,
          entries: scanUserMemory(fsMod, pathMod, agent, home, agentEnv(agent)),
        })),
      }
    })
  )

  // ── Sharing the global memory with the agents ─────────────────────
  // The user-global store owns this text; sharing renders its entries into
  // each agent's own global memory file inside a marked block. Off until the
  // user opts in, because the sync writes into files the user owns.
  function sharingEnabled(): boolean {
    return coreConfigManager?.get().sharedMemory?.enabled === true
  }

  /** Render the global entries into every agent file, or clear the block. */
  async function applySharedMemory(): Promise<string[]> {
    const fsMod = await import('fs')
    const pathMod = await import('path')
    const osMod = await import('os')
    const home = osMod.homedir()
    const targets = sharedMemoryTargets(pathMod, home, agentEnv)
    let body = ''
    if (sharingEnabled()) {
      const store = await openMemoryStore('global')
      body = renderSharedBody(store.getAll())
    }
    return syncSharedMemory(fsMod, pathMod, targets, body).written
  }

  /**
   * Carry the pre-merge `~/.codey/memory/MEMORY.md` into the global store, so
   * a user who had typed shared text keeps it now that entries own the block.
   * Runs once: the file is removed after it lands in the store.
   */
  async function migrateLegacySharedFile(): Promise<void> {
    const fsMod = await import('fs')
    const pathMod = await import('path')
    const osMod = await import('os')
    const file = legacySharedFilePath(pathMod, osMod.homedir())
    let text = ''
    try {
      text = fsMod.readFileSync(file, 'utf-8').trim()
    } catch { return }
    if (text) {
      const store = await openMemoryStore('global')
      store.add({
        type: 'context',
        content: text,
        label: labelFor(text),
        tags: ['user', 'migrated'],
        source: 'migration',
      })
      await store.flush()
    }
    try { fsMod.unlinkSync(file) } catch { /* already gone */ }
  }

  // Agents read their memory files from disk when they spawn, so one sync per
  // launch keeps the shared block current everywhere.
  try {
    await migrateLegacySharedFile()
    await applySharedMemory()
  } catch { /* best-effort: a stale block must not break startup */ }

  ipcMain.handle('memory:shared:get', async () =>
    wrap(async () => {
      const pathMod = await import('path')
      const osMod = await import('os')
      return {
        enabled: sharingEnabled(),
        targets: sharedMemoryTargets(pathMod, osMod.homedir(), agentEnv),
      }
    })
  )

  ipcMain.handle('memory:shared:setEnabled', async (_e, enabled: boolean) =>
    wrap(async () => {
      if (!coreConfigManager) throw new Error('Config manager not initialized')
      coreConfigManager.update({ sharedMemory: { enabled } })
      return { synced: await applySharedMemory() }
    })
  )

  ipcMain.handle('memory:project', async (_e, workspace?: string) =>
    wrap(async () => {
      const fsMod = await import('fs')
      const pathMod = await import('path')
      const osMod = await import('os')
      const home = osMod.homedir()
      const workingDir = getWorkingDir(fsMod, pathMod, workspace)
      const agents = workingDir
        ? Object.keys(AGENT_MEMORY).map(agent => ({
            agent,
            entries: scanProjectMemory(fsMod, pathMod, agent, home, agentEnv(agent), workingDir),
          }))
        : []
      return { agents, workingDir }
    })
  )

  // ── Codey's own memory (MemoryStore entries) ──────────────────────
  // Distinct from memory:* above, which reads the agents' own instruction
  // files. These entries are what Codey injects into prompts, and the UI
  // manages them directly instead of the rendered memory.md beside them,
  // which the store overwrites on every change.
  /**
   * Resolve the store to edit. When the gateway already holds one for this
   * target, reuse that instance: two MemoryStore objects over the same
   * index.json would overwrite each other's entries on the next flush.
   */
  async function openMemoryStore(scope: MemoryStoreScope, workspace?: string) {
    const gatewayWorkspaces = inProcessGateway?.getWorkspaceManager()
    if (scope === 'global') {
      if (gatewayWorkspaces) return gatewayWorkspaces.getGlobalMemoryStore()
      const { MemoryStore, globalMemoryDir } = await import('@codey/core')
      const store = new MemoryStore(globalMemoryDir())
      await store.load()
      return store
    }
    if (!workspaceManager) throw new Error('Workspace manager not ready')
    const name = workspace || workspaceManager.getCurrentWorkspace()
    if (!name) throw new Error('No workspace selected')
    if (gatewayWorkspaces && name === gatewayWorkspaces.getCurrentWorkspace()) {
      return gatewayWorkspaces.getMemoryStore()
    }
    const fsMod = await import('fs')
    const pathMod = await import('path')
    const root = pathMod.join(workspaceManager.getWorkspacesRoot(), name)
    if (!fsMod.existsSync(root)) throw new Error(`Workspace "${name}" does not exist`)
    // Loaded fresh on each call so an edit never writes from a stale snapshot.
    const { MemoryStore } = await import('@codey/core')
    const store = new MemoryStore(root)
    await store.load()
    return store
  }

  ipcMain.handle('codeyMemory:list', async (_e, scope: MemoryStoreScope, workspace?: string) =>
    wrap(async () => {
      const store = await openMemoryStore(scope, workspace)
      return { entries: listStore(store) }
    })
  )

  ipcMain.handle('codeyMemory:add', async (_e, scope: MemoryStoreScope, workspace: string | undefined, content: string, type?: string) =>
    wrap(async () => {
      const store = await openMemoryStore(scope, workspace)
      const text = validateContent(content)
      const entry = store.add({
        type: isMemoryType(type) ? type : 'fact',
        content: text,
        label: labelFor(text),
        tags: ['user'],
        source: 'user',
      })
      await store.flush()
      if (scope === 'global') await applySharedMemory()
      return toMemoryItem(entry)
    })
  )

  ipcMain.handle('codeyMemory:update', async (_e, scope: MemoryStoreScope, workspace: string | undefined, id: string, content: string, type?: string) =>
    wrap(async () => {
      const store = await openMemoryStore(scope, workspace)
      const text = validateContent(content)
      const ok = store.update(id, {
        content: text,
        label: labelFor(text),
        ...(isMemoryType(type) ? { type } : {}),
      })
      if (!ok) throw new Error('That memory no longer exists')
      await store.flush()
      if (scope === 'global') await applySharedMemory()
      return { updated: true }
    })
  )

  ipcMain.handle('codeyMemory:remove', async (_e, scope: MemoryStoreScope, workspace: string | undefined, id: string) =>
    wrap(async () => {
      const store = await openMemoryStore(scope, workspace)
      const removed = store.remove(id)
      if (removed) {
        await store.flush()
        if (scope === 'global') await applySharedMemory()
      }
      return { removed }
    })
  )

  ipcMain.handle('codeyMemory:settings', async () =>
    wrap(async () => {
      const memory = coreConfigManager?.get().memory ?? {}
      return { enabled: memory.enabled !== false, autoExtract: memory.autoExtract !== false }
    })
  )

  ipcMain.handle('codeyMemory:setSettings', async (_e, patch: { enabled?: boolean; autoExtract?: boolean }) =>
    wrap(async () => {
      if (!coreConfigManager) throw new Error('Config manager not initialized')
      coreConfigManager.update({ memory: patch })
      const memory = coreConfigManager.get().memory ?? {}
      return { enabled: memory.enabled !== false, autoExtract: memory.autoExtract !== false }
    })
  )

  // ── Playbooks (crystallizer SkillStore) — distinct from skills:* above,
  //    which manages agent-skill directories on disk. ──────────────────────────
  // The gateway's OWN workspace manager — not main.ts's workspaceManager singleton.
  function playbookWorkspaces() {
    if (!inProcessGateway) throw new Error('Gateway not initialized');
    return inProcessGateway.getWorkspaceManager();
  }
  // Playbooks are per-workspace state shown in a global tab, so every action
  // resolves the store of the workspace the renderer named. An empty name
  // falls back to the active workspace (getSkillStoreFor's own behaviour).
  function playbookStore(workspace: string) {
    return playbookWorkspaces().getSkillStoreFor(workspace)
  }
  ipcMain.handle('playbooks:list', async () =>
    wrap(async () => listPlaybooks(await playbookWorkspaces().getAllSkillStores())));
  ipcMain.handle('playbooks:detail', async (_e, workspace: string, name: string) =>
    wrap(async () => playbookDetail(await playbookStore(workspace), name)));
  ipcMain.handle('playbooks:history', async (_e, workspace: string, name: string) =>
    wrap(async () => playbookHistory(await playbookStore(workspace), name)));
  ipcMain.handle('playbooks:archive', async (_e, workspace: string, name: string) =>
    wrap(async () => archivePlaybook(await playbookStore(workspace), name)));
  ipcMain.handle('playbooks:restore', async (_e, workspace: string, name: string) =>
    wrap(async () => restorePlaybook(await playbookStore(workspace), name)));
  ipcMain.handle('playbooks:delete', async (_e, workspace: string, name: string) =>
    wrap(async () => deletePlaybook(await playbookStore(workspace), name)));
  ipcMain.handle('playbooks:rollback', async (_e, workspace: string, name: string) =>
    wrap(async () => rollbackPlaybook(await playbookStore(workspace), name)));
  ipcMain.handle('playbooks:promote', async (_e, workspace: string, name: string) =>
    wrap(async () => {
      const pathMod = await import('path')
      // The skill belongs beside the code it describes: use the working dir of
      // the playbook's OWN workspace, not whichever one is currently active.
      const workingDir = playbookWorkspaces().getWorkingDirFor(workspace)
      if (!workingDir) throw new Error(`Workspace "${workspace}" has no working directory.`)
      // The durable copy lives once under `.codey/skills`; compatibility links
      // expose it through every agent's native discovery convention.
      const result = await promotePlaybook(
        await playbookStore(workspace),
        name,
        [pathMod.join(workingDir, CODEY_SKILLS_SUBDIR)],
      )
      await syncCodeyProjectSkills(workingDir)
      return result
    }));

  // ── Conversations IPC ─────────────────────────────────────────────
  ipcMain.handle('conversations:list', async () =>
    wrap(async () => {
      const cm = (inProcessGateway as any)?.contextManager
      return cm?.listConversationIds?.() ?? []
    })
  )

  // ── Chat IPC ──────────────────────────────────────────────────────
  ipcMain.handle('chat:send', async (_e, payload: {
    conversationId: string
    text: string
    sender?: string
  }) =>
    wrap(async () => {
      if (!inProcessGateway) throw new Error('Gateway not initialized')
      const convId = payload.conversationId
      const sse = (event: string, data: string) => {
        if (event === 'stream' || event === 'plan') {
          sendToRenderer('chat:token', { conversationId: convId, token: data })
        } else if (event === 'status') {
          sendToRenderer('chat:status', { conversationId: convId, update: data })
        }
      }
      const result = await inProcessGateway.processPromptHttp(payload.text, sse, convId)
      // Always deliver the final response — some agent paths skip streaming
      if (result?.response) {
        sendToRenderer('chat:done', {
          conversationId: convId,
          response: result.response,
          tokens: result.tokens,
          durationSec: result.durationSec,
          choices: result.choices,
        })
      }
      return result
    })
  )

  // ── Chats IPC (multi-chat) ────────────────────────────────────────
  ipcMain.handle('chats:list', async (_e, workspaceName?: string) =>
    wrap(async () => {
      if (!inProcessGateway) throw new Error('Gateway not initialized')
      return inProcessGateway.listChats(workspaceName)
    })
  )

  ipcMain.handle('chats:get', async (_e, id: string) =>
    wrap(async () => {
      if (!inProcessGateway) throw new Error('Gateway not initialized')
      return inProcessGateway.getChat(id)
    })
  )

  ipcMain.handle('chats:create', async (_e, input: { workspaceName: string; selection?: any; title?: string }) =>
    wrap(async () => {
      if (!inProcessGateway) throw new Error('Gateway not initialized')
      return inProcessGateway.createChat(input)
    })
  )

  ipcMain.handle('chats:rename', async (_e, id: string, title: string) =>
    wrap(async () => {
      if (!inProcessGateway) throw new Error('Gateway not initialized')
      return inProcessGateway.getChatManager().rename(id, title)
    })
  )

  ipcMain.handle('chats:taskBrief', async (_e, id: string) =>
    wrap(async () => {
      if (!inProcessGateway) throw new Error('Gateway not initialized')
      return inProcessGateway.generateTaskBrief(id)
    })
  )

  ipcMain.handle('chats:delete', async (_e, id: string) =>
    wrap(async () => {
      if (!inProcessGateway) throw new Error('Gateway not initialized')
      await inProcessGateway.deleteChat(id)
      return null
    })
  )

  ipcMain.handle('chats:updateSelection', async (_e, id: string, selection: any) =>
    wrap(async () => {
      if (!inProcessGateway) throw new Error('Gateway not initialized')
      return inProcessGateway.getChatManager().updateSelection(id, selection)
    })
  )

  ipcMain.handle('chats:updateAgentModel', async (_e, id: string, agent: string | null, model: string | null) =>
    wrap(async () => {
      if (!inProcessGateway) throw new Error('Gateway not initialized')
      return inProcessGateway.getChatManager().updateAgentModel(id, agent as any, model)
    })
  )

  ipcMain.handle('chats:updateEffort', async (_e, id: string, effort: string | null) =>
    wrap(async () => {
      if (!inProcessGateway) throw new Error('Gateway not initialized')
      return inProcessGateway.getChatManager().updateEffort(id, effort as any)
    })
  )

  ipcMain.handle('chats:updateContextPanelOpen', async (_e, id: string, open: boolean | null) =>
    wrap(async () => {
      if (!inProcessGateway) throw new Error('Gateway not initialized')
      return inProcessGateway.getChatManager().updateContextPanelOpen(id, open)
    })
  )

  ipcMain.handle('chats:setSoloAdvisor', async (_e, id: string, enabled: boolean) =>
    wrap(async () => {
      if (!inProcessGateway) throw new Error('Gateway not initialized')
      return inProcessGateway.getChatManager().setSoloAdvisor(id, enabled)
    })
  )

  ipcMain.handle('chats:setWorkingDir', async (_e, id: string, dir: string | null) =>
    wrap(async () => {
      if (!inProcessGateway) throw new Error('Gateway not initialized')
      return inProcessGateway.getChatManager().setWorkingDirOverride(id, dir)
    })
  )

  ipcMain.handle('chats:setExecutionMode', async (_e, id: string, mode: 'shared-checkout' | 'isolated-worktree') =>
    wrap(async () => {
      if (!inProcessGateway) throw new Error('Gateway not initialized')
      return inProcessGateway.setChatExecutionMode(id, mode)
    })
  )

  ipcMain.handle('chats:bindWorktree', async (_e, id: string, worktreePath: string, expectedBranch?: string) =>
    wrap(async () => {
      if (!inProcessGateway) throw new Error('Gateway not initialized')
      return inProcessGateway.bindChatToWorktree(id, worktreePath, expectedBranch)
    })
  )

  ipcMain.handle('chats:createWorktree', async (_e, id: string, name: string) =>
    wrap(async () => {
      if (!inProcessGateway) throw new Error('Gateway not initialized')
      return inProcessGateway.createChatWorktree(id, name)
    })
  )

  ipcMain.handle('chats:setPullRequest', async (_e, id: string, pullRequest: NonNullable<import('@codey/core').Chat['pullRequest']>) =>
    wrap(async () => {
      if (!inProcessGateway) throw new Error('Gateway not initialized')
      return inProcessGateway.getChatManager().setPullRequest(id, pullRequest)
    })
  )

  ipcMain.handle('chats:stop', async (_e, chatId: string) =>
    wrap(async () => {
      if (!inProcessGateway) throw new Error('Gateway not initialized')
      return inProcessGateway.stopChat(chatId)
    })
  )

  ipcMain.handle('qq:ask', async (_e, payload: { chatId: string; question: string; history: Array<{ role: 'user' | 'assistant'; content: string }>; attachments?: any[] }) =>
    wrap(async () => {
      if (!inProcessGateway) throw new Error('Gateway not initialized')
      // Stream events to the renderer on a dedicated channel so QQ never
      // collides with the main 'chats:event' stream.
      const sink = (ev: any) => sendToRenderer('qq:event', ev)
      return inProcessGateway.runQuickQuestion(payload.chatId, payload.question, payload.history ?? [], sink, payload.attachments)
    })
  )

  ipcMain.handle('qq:stop', async (_e, chatId: string) =>
    wrap(async () => {
      if (!inProcessGateway) throw new Error('Gateway not initialized')
      return inProcessGateway.stopQuickQuestion(chatId)
    })
  )

  ipcMain.handle('chats:upload', async (_e, chatId: string, fileName: string, mimeType: string, data: ArrayBuffer) =>
    wrap(async () => {
      if (!inProcessGateway) throw new Error('Gateway not initialized')
      const chat = inProcessGateway.getChatManager().get(chatId)
      if (!chat) throw new Error(`Chat not found: ${chatId}`)

      const fsMod = await import('fs')
      const pathMod = await import('path')
      const cryptoMod = await import('crypto')

      // Resolve workspace working directory
      const workspacesRoot = (inProcessGateway as any).workspaceManager.getWorkspacesRoot()
      const wsConfigPath = pathMod.join(workspacesRoot, chat.workspaceName, 'workspace.json')
      let workingDir = (inProcessGateway as any).workingDir
      if (fsMod.existsSync(wsConfigPath)) {
        try {
          const wsConfig = JSON.parse(fsMod.readFileSync(wsConfigPath, 'utf-8'))
          if (wsConfig.workingDir) workingDir = wsConfig.workingDir
        } catch { /* use default */ }
      }

      // Create .codey/uploads/ directory (always absolute so frontend / asset
      // protocol can reference it regardless of process cwd)
      const absWorkingDir = pathMod.resolve(workingDir || process.cwd())
      const uploadsDir = pathMod.join(absWorkingDir, '.codey', 'uploads')
      fsMod.mkdirSync(uploadsDir, { recursive: true })

      // Generate unique filename
      const timestamp = Date.now()
      const random = cryptoMod.randomBytes(4).toString('hex')
      const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_')
      const uniqueName = `${timestamp}-${random}-${safeName}`
      const filePath = pathMod.join(uploadsDir, uniqueName)

      // Write file
      const buffer = Buffer.from(data)
      fsMod.writeFileSync(filePath, buffer)

      const { randomUUID } = cryptoMod
      return {
        id: randomUUID(),
        name: fileName,
        path: filePath,
        mimeType,
        size: buffer.length,
      }
    })
  )

  ipcMain.handle('chats:send', async (_e, payload: { chatId: string; text: string; attachments?: any[] }) =>
    wrap(async () => {
      if (!inProcessGateway) throw new Error('Gateway not initialized')
      // No-op sink: events flow to the renderer via the global chatEventListener
      // installed at boot (sendToRenderer 'chats:event'). Wiring a per-call sink
      // here would deliver every event twice — and the second 'done' delivery
      // would race past the just-cleared pendingAssistantId and trigger a chat
      // refetch that overwrites the in-flight assistant message with the
      // server's persisted version (with a different UUID), making selectedTurnId
      // point at nothing and the right Context Panel go blank.
      const sink = () => { /* no-op */ }
      return inProcessGateway.sendToChat(payload.chatId, payload.text, sink, payload.attachments)
    })
  )

  ipcMain.handle('chats:link', async (_e, chatId: string, channel: 'telegram' | 'discord' | 'imessage', channelUserId: string) =>
    wrap(async () => {
      if (!inProcessGateway) throw new Error('Gateway not initialized')
      return inProcessGateway.linkChat(chatId, channel, channelUserId)
    })
  )

  ipcMain.handle('chats:unlink', async (_e, chatId: string, channel: 'telegram' | 'discord' | 'imessage', channelUserId: string) =>
    wrap(async () => {
      if (!inProcessGateway) throw new Error('Gateway not initialized')
      return inProcessGateway.unlinkChat(chatId, channel, channelUserId)
    })
  )

  // ── Permissions IPC ──────────────────────────────────────────────
  ipcMain.handle('permissions:addAllowed', async (_e, toolNames: string[], chatId?: string) =>
    wrap(async () => {
      const fsMod = await import('fs')
      const pathMod = await import('path')
      if (!workspaceManager) throw new Error('Workspace manager not ready')

      // Resolve the project workingDir from the chat so we write to the
      // correct .claude/settings.local.json that Claude Code actually reads.
      let workingDir: string | undefined
      if (chatId && inProcessGateway) {
        try {
          const chat = inProcessGateway.getChatManager().get(chatId)
          if (!chat) throw new Error('Chat not found')
          const wsConfigPath = pathMod.join(
            workspaceManager.getWorkspacesRoot(),
            chat.workspaceName,
            'workspace.json',
          )
          if (fsMod.existsSync(wsConfigPath)) {
            const wsConfig = JSON.parse(fsMod.readFileSync(wsConfigPath, 'utf-8'))
            if (wsConfig.workingDir) workingDir = wsConfig.workingDir
          }
        } catch { /* fall through to default */ }
      }

      const settingsDir = workingDir
        ? pathMod.join(workingDir, '.claude')
        : pathMod.join(pathMod.dirname(workspaceManager.getWorkspacesRoot()), '.claude')
      const settingsFile = pathMod.join(settingsDir, 'settings.local.json')
      let cfg: any = { permissions: { allow: [] } }
      if (fsMod.existsSync(settingsFile)) {
        try { cfg = JSON.parse(fsMod.readFileSync(settingsFile, 'utf-8')) } catch { /* fresh */ }
      }
      if (!cfg.permissions) cfg.permissions = {}
      if (!Array.isArray(cfg.permissions.allow)) cfg.permissions.allow = []
      let added = 0
      for (const name of toolNames) {
        if (!cfg.permissions.allow.includes(name)) {
          cfg.permissions.allow.push(name)
          added++
        }
      }
      if (added > 0) {
        fsMod.mkdirSync(settingsDir, { recursive: true })
        fsMod.writeFileSync(settingsFile, JSON.stringify(cfg, null, 2), 'utf-8')
      }
      return { added }
    })
  )

  ipcMain.handle('pairing:start', async (_e, channel: 'telegram' | 'discord' | 'imessage') =>
    wrap(async () => {
      if (!inProcessGateway) throw new Error('Gateway not initialized')
      return inProcessGateway.startPairing(channel)
    })
  )

  ipcMain.handle('pairing:list', async () =>
    wrap(async () => {
      if (!inProcessGateway) throw new Error('Gateway not initialized')
      return inProcessGateway.listPairings()
    })
  )

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    } else {
      mainWindow?.show()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', () => {
  isQuitting = true
  for (const sessionId of terminalSessions.keys()) disposeTerminalSession(sessionId)
  // Detach the browser surface but let Electron own final WebContents teardown.
  // Closing child contents while the native window is already quitting can race
  // Chromium's view destruction and terminate the browser process with SIGTRAP.
  browserController.destroy({ closeContents: false })
  browserControlPermission?.dispose()
  browserSitePermissions?.dispose()
  void browserAgentBridge?.stop()
  void chromeCompanion?.stop()
  try { globalShortcut.unregisterAll() } catch { /* nothing to unregister */ }
  stopVoiceHelper()
})

ipcMain.handle('app:version', () => app.getVersion())

ipcMain.handle('open-external', (_event, url: string) => {
  if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
    shell.openExternal(url)
  }
})

ipcMain.handle('shell:openPath', async (_event, p: string) => {
  if (typeof p !== 'string' || !p) return ''
  return await shell.openPath(p)
})

ipcMain.handle('shell:showItemInFolder', async (_event, p: string) => {
  if (typeof p !== 'string' || !p) return false
  shell.showItemInFolder(p)
  return true
})

// Read a text file so the file-changes viewer can resolve real line numbers for
// an edit by locating its content in the current file. Capped at 2 MB and
// returns null on any failure (missing file, binary, too large).
ipcMain.handle('file:readText', async (_event, p: string): Promise<string | null> => {
  if (typeof p !== 'string' || !p) return null
  try {
    const fs = require('fs') as typeof import('fs')
    const stat = await fs.promises.stat(p)
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024) return null
    return await fs.promises.readFile(p, 'utf-8')
  } catch {
    return null
  }
})
