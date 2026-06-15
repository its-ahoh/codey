import { app, BrowserWindow, Menu, ipcMain, Tray, nativeImage, shell, dialog, protocol, net, globalShortcut, clipboard, Notification, systemPreferences, screen } from 'electron'
import { join } from 'path'
import { captureAccelerator, screenshotAccelerator, resolveCaptureSubmit, normalizeAccelerator } from './capture'
import { pathToFileURL } from 'url'
import { findAvailablePort } from './portUtils'
import { initAutoUpdater, registerUpdaterIpc } from './updater'
import { createCoreStateStore } from './core-state'
import { decideNotification, createTurnTracker } from './chat-notifications'
import { applyEvent, clearAttention, summarize } from './tray-state'

protocol.registerSchemesAsPrivileged([
  { scheme: 'codey-asset', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
])
import { WorkerManager, WorkspaceManager } from '@codey/core'
import { Codey } from '@codey/gateway/dist/gateway'
import { ConfigManager } from '@codey/gateway/dist/config'
import { ApiServer } from '@codey/gateway/dist/health'

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

const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged

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
      nodeIntegration: false
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

/**
 * One-shot probe for whether each agent's CLI binary is on PATH. Used by the
 * Settings tab to render an "Installed" chip vs. an "Install" link. We shell
 * out via the user's login shell so PATH includes whatever they've set up
 * interactively (homebrew, nvm, asdf, …); a bare child_process.spawn from
 * Electron sees a much narrower PATH.
 */
async function detectInstalledAgents(): Promise<Record<string, { installed: boolean; path?: string }>> {
  const { spawn } = await import('child_process')
  const binaries: Record<string, string> = {
    'claude-code': 'claude',
    'opencode': 'opencode',
    'codex': 'codex',
  }
  const shell = process.env.SHELL || '/bin/zsh'
  const probe = (bin: string) => new Promise<string | null>(resolve => {
    // -i -c so login dotfiles (.zshrc, .bash_profile) populate PATH the way
    // the user expects when they run `claude` in Terminal.
    const p = spawn(shell, ['-i', '-c', `command -v ${bin}`], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    p.stdout.on('data', d => { out += d.toString() })
    const timer = setTimeout(() => { try { p.kill() } catch { /* already gone */ } resolve(null) }, 4000)
    p.on('close', code => {
      clearTimeout(timer)
      const path = out.trim().split('\n').filter(Boolean).pop()
      resolve(code === 0 && path ? path : null)
    })
    p.on('error', () => { clearTimeout(timer); resolve(null) })
  })
  const result: Record<string, { installed: boolean; path?: string }> = {}
  await Promise.all(Object.entries(binaries).map(async ([agent, bin]) => {
    const p = await probe(bin)
    result[agent] = p ? { installed: true, path: p } : { installed: false }
  }))
  return result
}

interface SlashCommand {
  name: string
  description: string
  source: 'agent' | 'gateway'
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
  const binaries: Record<string, string> = {
    'claude-code': 'claude',
    'opencode': 'opencode',
    'codex': 'codex',
  }
  const bin = binaries[agent]
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
    // Back-compat: old `dispatcher` block becomes `advisor`.
    advisor: json?.advisor ?? json?.dispatcher,
    aide: json?.aide,
  }
}

async function bootInProcessCore() {
  coreStateStore.setBooting()
  const root = resolveDataRoot()
  try {
    coreConfigManager = new ConfigManager(join(root, 'gateway.json'))
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
        JSON.stringify({ workingDir: app.getPath('home'), teams: [] }, null, 2)
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
      applyCaptureHotkey(updated)
      applyScreenshotHotkey(updated)
      applyUiPreferences(updated)
    })
    {
      const v = (coreConfigManager.get() as any)?.voice
      sendToRenderer('gateway-log', `[voice] config on boot: enabled=${!!v?.enabled} hotkey=${v?.hotkey ?? '(unset)'}`)
    }
    applyVoiceHotkey(coreConfigManager.get())
    applyCaptureHotkey(coreConfigManager.get())
    applyScreenshotHotkey(coreConfigManager.get())
    applyUiPreferences(coreConfigManager.get())
    sendToRenderer('gateway-log', `[core] In-process core booted (root: ${root}, workers: ${workerManager.getAllWorkers().length}, agent: ${runtimeCfg.defaultAgent})`)
    // Boot the gateway in the background so configured channels (telegram,
    // discord, imessage) connect. Done after returning so IPC handler
    // registration in app.whenReady() isn't blocked by network I/O
    // (e.g. Telegram setMyCommands hanging).
    void inProcessGateway.start().catch((err: any) => {
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
      apiServer = new ApiServer(apiPort, (): any => inProcessGateway!.getHealthStatus(), coreConfigManager)
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

let currentVoiceAccelerator: string | null = null
function applyVoiceHotkey(rawCfg: any) {
  const voice = rawCfg?.voice
  // Fn is handled exclusively by the bundled Swift helper (Electron's
  // globalShortcut can't bind Fn at all). When the user picks Fn, we don't
  // register any in-process accelerator — the helper monitors it directly.
  const hk = voice?.hotkey
  const isFn = typeof hk === 'string' && hk.trim().toLowerCase() === 'fn'
  const desired = voice?.enabled && !isFn ? toElectronAccelerator(hk) : null

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
// voice.enabled is true so the user gets system-wide hotkeys (incl. Fn)
// without any extra install steps. It runs as an LSUIElement, communicates
// with the gateway over HTTP, and is killed on app quit.
let voiceHelperProc: import('child_process').ChildProcess | null = null
let voiceHelperStarted = false
let voicePermissionPrompted = false

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

// Warm marker file: records which WhisperKit variants have already gone through
// the one-time CoreML per-machine compile. Lets the UI distinguish "downloaded"
// (✓, first Fn press takes 30-90s) from "warmed" (⚡, instant).
function warmMarkerPath(): string {
  const path = require('path') as typeof import('path')
  return path.join(app.getPath('userData'), 'voice-warm.json')
}

type WarmMarkers = Record<string, { warmedAt: string; loadSeconds: number }>

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
    const entry = { warmedAt: new Date().toISOString(), loadSeconds }
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
  const enabled = !!rawCfg?.voice?.enabled
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
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    })
    voiceHelperStarted = true
    voiceHelperProc.stdout?.on('data', d => sendToRenderer('gateway-log', `[voice-helper] ${d.toString().trimEnd()}`))
    voiceHelperProc.stderr?.on('data', d => sendToRenderer('gateway-log', `[voice-helper] ${d.toString().trimEnd()}`))
    voiceHelperProc.on('exit', code => {
      sendToRenderer('gateway-log', `[voice-helper] exited (code ${code})`)
      voiceHelperProc = null
      voiceHelperStarted = false
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

app.whenReady().then(async () => {
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
      const chat = inProcessGateway.getChatManager().create({ workspaceName: resolved.workspaceName })

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

  // Check Full Disk Access by probing the iMessage database.
  // macOS shows a system dialog the first time; on subsequent launches
  // we surface a reminder if access is still denied.
  {
    const fsMod = await import('fs')
    const osMod = await import('os')
    const pathMod = await import('path')
    const chatDbPath = pathMod.join(osMod.homedir(), 'Library', 'Messages', 'chat.db')
    try {
      fsMod.accessSync(chatDbPath, fsMod.constants.R_OK)
    } catch {
      const { dialog: dlg } = await import('electron')
      dlg.showMessageBox({
        type: 'info',
        title: 'Full Disk Access recommended',
        message: 'Codey needs Full Disk Access to read iMessage conversations.',
        detail: 'Go to System Settings → Privacy & Security → Full Disk Access and add Codey.',
        buttons: ['OK'],
      })
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

  ipcMain.handle('workspaces:memory:get', async (_e, name: string) =>
    wrap(async () => {
      if (!workspaceManager) throw new Error('Workspace manager not ready')
      const fsMod = await import('fs')
      const pathMod = await import('path')
      const root = workspaceManager.getWorkspacesRoot()
      const memPath = pathMod.join(root, name, 'memory.md')
      if (!fsMod.existsSync(memPath)) return ''
      return fsMod.readFileSync(memPath, 'utf-8')
    })
  )

  ipcMain.handle('workspaces:memory:set', async (_e, name: string, content: string) =>
    wrap(async () => {
      if (!workspaceManager) throw new Error('Workspace manager not ready')
      if (typeof content !== 'string') throw new Error('Content must be a string')
      const fsMod = await import('fs')
      const pathMod = await import('path')
      const root = workspaceManager.getWorkspacesRoot()
      const wsDir = pathMod.join(root, name)
      if (!fsMod.existsSync(wsDir) || !fsMod.statSync(wsDir).isDirectory()) {
        throw new Error(`Workspace "${name}" does not exist`)
      }
      const memPath = pathMod.join(wsDir, 'memory.md')
      await fsMod.promises.writeFile(memPath, content, 'utf-8')
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

  // ── Workspace teams IPC (enabled names only) ─────────────────────
  // Returns the names of global teams enabled for this workspace. Definitions
  // live in `globalTeams`, not here.
  ipcMain.handle('teams:get', async (_e, name?: string) =>
    wrap(async () => {
      if (!workspaceManager) throw new Error('Workspace manager not ready')
      const target = name || workspaceManager.getCurrentWorkspace()
      if (!target) return [] as string[]
      const fsMod = await import('fs')
      const pathMod = await import('path')
      const configPath = pathMod.join(workspaceManager.getWorkspacesRoot(), target, 'workspace.json')
      if (!fsMod.existsSync(configPath)) return [] as string[]
      const data = JSON.parse(fsMod.readFileSync(configPath, 'utf-8'))
      if (Array.isArray(data.teams)) return data.teams.filter((n: any) => typeof n === 'string') as string[]
      // Legacy: workspace held its own definitions. Surface its keys so the
      // user can re-enable them once they're promoted to the global library.
      if (data.teams && typeof data.teams === 'object') return Object.keys(data.teams)
      return [] as string[]
    })
  )

  ipcMain.handle('teams:set', async (_e, nameOrNames: string | string[], maybeNames?: string[]) =>
    wrap(async () => {
      if (!workspaceManager) throw new Error('Workspace manager not ready')
      // Accept both (names) and (workspaceName, names).
      let target: string
      let names: string[]
      if (typeof nameOrNames === 'string') {
        target = nameOrNames || workspaceManager.getCurrentWorkspace()
        names = Array.isArray(maybeNames) ? maybeNames : []
      } else {
        target = workspaceManager.getCurrentWorkspace()
        names = Array.isArray(nameOrNames) ? nameOrNames : []
      }
      if (!target) throw new Error('No workspace specified')

      const sanitized = names.filter(n => typeof n === 'string' && n.trim().length > 0)
      if (target === workspaceManager.getCurrentWorkspace()) {
        await workspaceManager.setEnabledTeams(sanitized)
        return
      }
      const fsMod = await import('fs')
      const pathMod = await import('path')
      const configPath = pathMod.join(workspaceManager.getWorkspacesRoot(), target, 'workspace.json')
      if (!fsMod.existsSync(configPath)) throw new Error(`Workspace "${target}" does not exist`)
      const existing = JSON.parse(await fsMod.promises.readFile(configPath, 'utf-8'))
      existing.teams = sanitized
      await fsMod.promises.writeFile(configPath, JSON.stringify(existing, null, 2), 'utf-8')
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

  // ── Voice IPC ─────────────────────────────────────────────────────
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
      let pasted = false
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
            p.on('close', (code) => { clearTimeout(t); if (code === 0) pasted = true; resolve() })
            p.on('error', () => { clearTimeout(t); resolve() })
          })
        } catch { /* fall through to notification */ }
      }
      if (!pasted && Notification.isSupported()) {
        const n = new Notification({
          title: 'Voice transcribed (copied to clipboard)',
          body: text.length > 120 ? text.slice(0, 117) + '…' : text,
          silent: true,
        })
        n.show()
      }
    })
  )

  ipcMain.handle('voice:error', async (_e, message: string) =>
    wrap(async () => {
      if (Notification.isSupported()) {
        new Notification({ title: 'Voice input failed', body: String(message ?? 'Unknown error') }).show()
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
    wrap(async () => {
      if (process.platform !== 'darwin') throw new Error('Voice helper is macOS-only')
      if (typeof modelName !== 'string' || !modelName.trim()) throw new Error('Model name required')
      const bin = resolveVoiceHelperBinary()
      if (!bin) throw new Error('Voice helper binary not found')

      const { spawn } = require('child_process') as typeof import('child_process')
      const proc = spawn(bin, ['--warm-model', modelName], { stdio: ['ignore', 'pipe', 'pipe'] })

      let lastErr = ''
      let loadSeconds = 0
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
      if (code !== 0) {
        sendToRenderer('voice:warmError', { model: modelName, error: lastErr || `Warm failed (exit ${code})` })
        throw new Error(lastErr || `Warm failed (exit ${code})`)
      }
      writeWarmMarker(modelName, loadSeconds)
      sendToRenderer('voice:warmDone', { model: modelName, loadSeconds })
      return { model: modelName, loadSeconds }
    })
  )

  ipcMain.handle('voice:listWarmedModels', async () =>
    wrap(async () => Object.keys(readWarmMarkers()))
  )

  // Lists WhisperKit model folders currently on disk. WhisperKit stores
  // downloaded variants under ~/Documents/huggingface/models/argmaxinc/
  // whisperkit-coreml/<variant>/. We return the raw folder names so the
  // renderer can match against either the bare variant or the full
  // openai_whisper-<variant> form used in the UI dropdown.
  ipcMain.handle('voice:listDownloadedModels', async () =>
    wrap(async () => {
      const fsMod = await import('fs')
      const pathMod = await import('path')
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
            // Only count variants that actually contain .mlmodelc payloads
            // AND each .mlmodelc has a non-empty weights/weight.bin. CoreML
            // partial downloads leave the folder + model.mil present but the
            // weight file missing or zero-byte, which causes runtime "Could
            // not open weights/weight.bin" errors and an endless warm-failure
            // flicker in the UI. Checking weights here surfaces incomplete
            // downloads as "not downloaded" so the user gets a Download
            // button instead of a confusing warm error.
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
    })
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

  // ── Models IPC ────────────────────────────────────────────────────
  ipcMain.handle('models:list', async () =>
    wrap(async () => coreConfigManager?.listModels() ?? [])
  )

  ipcMain.handle('models:save', async (_e, entry: any) =>
    wrap(async () => {
      if (!coreConfigManager) throw new Error('Config manager not initialized')
      if (!entry?.model) throw new Error('Model id is required')
      if (entry.apiType !== 'anthropic' && entry.apiType !== 'openai') {
        throw new Error('Model apiType must be "anthropic" or "openai"')
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

  ipcMain.handle('agents:checkInstalled', async () =>
    wrap(async () => detectInstalledAgents())
  )

  ipcMain.handle('agents:slashCommands', async (_e, agent: string) =>
    wrap(async () => {
      const discovered = await discoverSlashCommands(agent)
      const qq: SlashCommand = {
        name: 'qq',
        description: 'Quick Question — ask about this chat without affecting it',
        source: 'gateway',
      }
      // Avoid a duplicate if a future discovery ever yields one.
      return [qq, ...discovered.filter(c => c.name !== 'qq')]
    })
  )

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
      return inProcessGateway.getChatManager().list(workspaceName)
    })
  )

  ipcMain.handle('chats:get', async (_e, id: string) =>
    wrap(async () => {
      if (!inProcessGateway) throw new Error('Gateway not initialized')
      const c = inProcessGateway.getChatManager().get(id)
      if (!c) throw new Error(`Chat not found: ${id}`)
      return c
    })
  )

  ipcMain.handle('chats:create', async (_e, input: { workspaceName: string; selection?: any; title?: string }) =>
    wrap(async () => {
      if (!inProcessGateway) throw new Error('Gateway not initialized')
      return inProcessGateway.getChatManager().create(input)
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
      inProcessGateway.getChatManager().delete(id)
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
  try { globalShortcut.unregisterAll() } catch { /* nothing to unregister */ }
  stopVoiceHelper()
})

ipcMain.handle('app:version', () => app.getVersion())

// IPC handlers
ipcMain.handle('show-window', () => {
  mainWindow?.show()
  mainWindow?.focus()
})

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
