import { autoUpdater } from 'electron-updater'
import type { IpcMain } from 'electron'

type Notify = (payload: Record<string, unknown>) => void
type Log = (message: string) => void
type IpcResult<T> = { ok: true; data: T } | { ok: false; error: string }
type Wrap = <T>(fn: () => Promise<T>) => Promise<IpcResult<T>>

let started = false
const FOUR_HOURS = 4 * 60 * 60 * 1000

// Last state pushed to the renderer. The initial check fires during
// app.whenReady(), which can resolve before React mounts and subscribes to
// `updater:state`; that event would then be dropped. We remember it here so a
// freshly-mounted renderer can backfill via the `updater:lastState` IPC call —
// the same pattern the gateway-log ring buffer uses in main.ts.
let lastState: Record<string, unknown> | null = null

/**
 * Wire electron-updater events to the renderer. No-ops in dev / unpackaged
 * builds, where there is no app-update.yml and autoUpdater would throw.
 */
export function initAutoUpdater(notify: Notify, isPackaged: boolean, log: Log): void {
  if (!isPackaged || started) return
  started = true

  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false

  const emit: Notify = (payload) => {
    lastState = payload
    notify(payload)
  }

  autoUpdater.on('checking-for-update', () => emit({ type: 'checking' }))
  autoUpdater.on('update-available', (info) => emit({ type: 'available', version: info.version }))
  autoUpdater.on('update-not-available', () => emit({ type: 'not-available' }))
  autoUpdater.on('download-progress', (p) => emit({ type: 'progress', percent: Math.round(p.percent) }))
  autoUpdater.on('update-downloaded', (info) => emit({ type: 'downloaded', version: info.version }))
  autoUpdater.on('error', (err) => {
    log(`[updater] error: ${err?.message ?? err}`)
    emit({ type: 'error' })
  })

  const check = () => {
    autoUpdater.checkForUpdates().catch((e) => log(`[updater] check failed: ${e?.message ?? e}`))
  }
  check()
  setInterval(check, FOUR_HOURS)
}

/** IPC handlers driven by the renderer button. */
export function registerUpdaterIpc(ipcMain: IpcMain, wrap: Wrap): void {
  ipcMain.handle('updater:check', () => wrap(async () => { await autoUpdater.checkForUpdates() }))
  ipcMain.handle('updater:download', () => wrap(async () => { await autoUpdater.downloadUpdate() }))
  ipcMain.handle('updater:install', () => wrap(async () => { autoUpdater.quitAndInstall() }))
  // Backfill: the renderer reads the last known state on mount in case it
  // missed the initial event while React was still mounting.
  ipcMain.handle('updater:lastState', () => wrap(async () => lastState))
}
