import { autoUpdater } from 'electron-updater'
import type { IpcMain } from 'electron'

type Notify = (payload: Record<string, unknown>) => void
type Log = (message: string) => void
type IpcResult<T> = { ok: true; data: T } | { ok: false; error: string }
type Wrap = <T>(fn: () => Promise<T>) => Promise<IpcResult<T>>

let started = false
const FOUR_HOURS = 4 * 60 * 60 * 1000

/**
 * Wire electron-updater events to the renderer. No-ops in dev / unpackaged
 * builds, where there is no app-update.yml and autoUpdater would throw.
 */
export function initAutoUpdater(notify: Notify, isPackaged: boolean, log: Log): void {
  if (!isPackaged || started) return
  started = true

  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false

  autoUpdater.on('checking-for-update', () => notify({ type: 'checking' }))
  autoUpdater.on('update-available', (info) => notify({ type: 'available', version: info.version }))
  autoUpdater.on('update-not-available', () => notify({ type: 'not-available' }))
  autoUpdater.on('download-progress', (p) => notify({ type: 'progress', percent: Math.round(p.percent) }))
  autoUpdater.on('update-downloaded', (info) => notify({ type: 'downloaded', version: info.version }))
  autoUpdater.on('error', (err) => {
    log(`[updater] error: ${err?.message ?? err}`)
    notify({ type: 'error' })
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
}
