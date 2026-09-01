import * as crypto from 'crypto'
import * as fs from 'fs'
import { dirname, join } from 'path'

/** Folder name used when the user picks where to install the extension. */
export const CHOSEN_FOLDER_NAME = 'codey-chrome-extension'
/** Where the user's chosen install location is remembered. */
export const INSTALL_RECORD_FILE = 'chrome-extension-install.json'
/** Where this install's pairing secret lives (the host's copy). */
export const PAIRING_SECRET_FILE = 'chrome-companion-pairing.json'
/** The extension's copy of the secret, staged next to its manifest. */
export const PAIRING_FILE = 'pairing.json'

/**
 * The pairing secret shared between Codey and the staged extension. Loopback
 * ports are first come, first served, so the extension must not trust whoever
 * answers on one - both ends prove they hold this secret instead. Created once
 * per install and reused, so re-staging does not un-pair a working setup.
 */
export function ensurePairingSecret(userData: string): string {
  const file = join(userData, PAIRING_SECRET_FILE)
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (typeof value.secret === 'string' && value.secret.length >= 32) return value.secret
  } catch { /* first run or damaged file - mint a fresh secret below */ }
  const secret = crypto.randomBytes(32).toString('base64url')
  fs.mkdirSync(userData, { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ secret }), { encoding: 'utf8', mode: 0o600 })
  return secret
}

/** Give a staged extension directory its copy of the pairing secret. */
export function writePairingFile(dir: string, secret: string): void {
  const file = join(dir, PAIRING_FILE)
  const payload = JSON.stringify({ secret })
  try {
    if (fs.readFileSync(file, 'utf8') === payload) return
  } catch { /* absent or unreadable - write it */ }
  fs.writeFileSync(file, payload, { encoding: 'utf8', mode: 0o600 })
}

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
  pairingSecret?: string,
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
  // Written outside the version check: a re-stage that skipped the copy must
  // still leave the secret in place (the copy in the app bundle never has it).
  if (pairingSecret) writePairingFile(target, pairingSecret)
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
export function refreshRememberedInstall(source: string, userData: string, pairingSecret?: string): string | null {
  const dir = rememberedInstallDir(userData)
  if (!dir) return null
  try {
    // An unplugged external disk should be left alone, not recreated one
    // directory at a time under an absent mount point.
    if (!fs.existsSync(dirname(dir))) return null
    if (stagedVersion(dir) !== stagedVersion(source)) {
      fs.rmSync(dir, { force: true, recursive: true })
      fs.cpSync(source, dir, { recursive: true })
    }
    if (pairingSecret) writePairingFile(dir, pairingSecret)
    return dir
  } catch { return null }
}

/**
 * The folder the user should point Chrome at: their own chosen install when it
 * is still there, otherwise Codey's default staging copy.
 */
export function installedExtensionDir(source: string, userData: string, pairingSecret?: string): string {
  const remembered = rememberedInstallDir(userData)
  if (remembered && fs.existsSync(join(remembered, 'manifest.json'))) {
    if (pairingSecret) { try { writePairingFile(remembered, pairingSecret) } catch { /* unwritable install dir */ } }
    return remembered
  }
  return stageChromeExtension(source, userData, undefined, pairingSecret)
}
