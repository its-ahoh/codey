import * as fs from 'fs'
import { dirname, join } from 'path'

/** Folder name used when the user picks where to install the extension. */
export const CHOSEN_FOLDER_NAME = 'codey-chrome-extension'
/** Where the user's chosen install location is remembered. */
export const INSTALL_RECORD_FILE = 'chrome-extension-install.json'

/**
 * Chrome's "Load unpacked" picker cannot descend into a `.app` bundle, so the
 * copy of the extension that ships inside `Codey.app/Contents/Resources` is
 * unreachable for the user who has to select it. Stage a copy in a plain user
 * directory instead, and keep it in step with the bundled one by version.
 */
export function stageChromeExtension(
  source: string,
  stagingRoot: string,
  folderName = 'chrome-extension',
): string {
  if (!fs.existsSync(join(source, 'manifest.json'))) {
    throw new Error('The Chrome companion extension is missing from this build')
  }
  const target = join(stagingRoot, folderName)
  if (!fs.existsSync(target) || stagedVersion(target) !== stagedVersion(source)) {
    fs.rmSync(target, { force: true, recursive: true })
    fs.mkdirSync(stagingRoot, { recursive: true })
    fs.cpSync(source, target, { recursive: true })
  }
  return target
}

/** The manifest version of an extension directory, or null when unreadable. */
export function stagedVersion(dir: string): string | null {
  try {
    const manifest = JSON.parse(fs.readFileSync(join(dir, 'manifest.json'), 'utf8'))
    return typeof manifest.version === 'string' ? manifest.version : null
  } catch { return null }
}

/**
 * Chrome loads an unpacked extension from one fixed path forever, so a copy the
 * user installed somewhere of their own would silently go stale at the next
 * Codey update. Remember that path and re-stage into it on launch.
 */
export function rememberInstallDir(userData: string, dir: string): void {
  fs.mkdirSync(userData, { recursive: true })
  fs.writeFileSync(join(userData, INSTALL_RECORD_FILE), JSON.stringify({ dir }), 'utf8')
}

export function rememberedInstallDir(userData: string): string | null {
  try {
    const record = JSON.parse(fs.readFileSync(join(userData, INSTALL_RECORD_FILE), 'utf8'))
    return typeof record.dir === 'string' && record.dir ? record.dir : null
  } catch { return null }
}

/**
 * Refresh the copy the user installed themselves, if any. Best-effort: an
 * external disk that is no longer mounted must not hold up startup.
 */
export function refreshRememberedInstall(source: string, userData: string): string | null {
  const dir = rememberedInstallDir(userData)
  if (!dir) return null
  try {
    // An unplugged external disk should be left alone, not recreated one
    // directory at a time under an absent mount point.
    if (!fs.existsSync(dirname(dir))) return null
    if (stagedVersion(dir) === stagedVersion(source)) return dir
    fs.rmSync(dir, { force: true, recursive: true })
    fs.cpSync(source, dir, { recursive: true })
    return dir
  } catch { return null }
}

/**
 * The folder the user should point Chrome at: their own chosen install when it
 * is still there, otherwise Codey's default staging copy.
 */
export function installedExtensionDir(source: string, userData: string): string {
  const remembered = rememberedInstallDir(userData)
  if (remembered && fs.existsSync(join(remembered, 'manifest.json'))) return remembered
  return stageChromeExtension(source, userData)
}
