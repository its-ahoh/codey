import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ensurePairingSecret,
  installedExtensionDir,
  PAIRING_FILE,
  PAIRING_SECRET_FILE,
  refreshRememberedInstall,
  rememberedInstallDir,
  rememberInstallDir,
  stageChromeExtension,
  stagedVersion,
} from './chrome-extension-stage'

const temps: string[] = []

function temp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-ext-stage-'))
  temps.push(dir)
  return dir
}

function bundledExtension(version: string): string {
  const dir = temp()
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ version, name: 'Codey' }))
  fs.writeFileSync(path.join(dir, 'service-worker.js'), `// ${version}`)
  fs.mkdirSync(path.join(dir, 'icons'))
  fs.writeFileSync(path.join(dir, 'icons', 'codey-16.png'), 'png')
  return dir
}

afterEach(() => {
  while (temps.length) fs.rmSync(temps.pop()!, { force: true, recursive: true })
})

describe('stageChromeExtension', () => {
  it('copies the whole extension, subdirectories included, out of the bundle', () => {
    const target = stageChromeExtension(bundledExtension('1.0.0'), temp())
    expect(path.basename(target)).toBe('chrome-extension')
    expect(fs.readFileSync(path.join(target, 'service-worker.js'), 'utf8')).toBe('// 1.0.0')
    expect(fs.existsSync(path.join(target, 'icons', 'codey-16.png'))).toBe(true)
  })

  it('creates a staging root that does not exist yet', () => {
    const root = path.join(temp(), 'nested', 'deeper')
    expect(fs.existsSync(stageChromeExtension(bundledExtension('1.0.0'), root))).toBe(true)
  })

  it('refreshes the staged copy when the bundled version moves on', () => {
    const root = temp()
    stageChromeExtension(bundledExtension('1.0.0'), root)
    const target = stageChromeExtension(bundledExtension('1.1.0'), root)
    expect(stagedVersion(target)).toBe('1.1.0')
    expect(fs.readFileSync(path.join(target, 'service-worker.js'), 'utf8')).toBe('// 1.1.0')
  })

  it('drops files the new version no longer ships', () => {
    const root = temp()
    const staged = stageChromeExtension(bundledExtension('1.0.0'), root)
    fs.writeFileSync(path.join(staged, 'removed.js'), 'old')
    stageChromeExtension(bundledExtension('1.1.0'), root)
    expect(fs.existsSync(path.join(staged, 'removed.js'))).toBe(false)
  })

  it('leaves an up-to-date copy alone', () => {
    const root = temp()
    const source = bundledExtension('1.0.0')
    const staged = stageChromeExtension(source, root)
    const before = fs.statSync(path.join(staged, 'manifest.json')).mtimeMs
    stageChromeExtension(source, root)
    expect(fs.statSync(path.join(staged, 'manifest.json')).mtimeMs).toBe(before)
  })

  it('restores a staged copy the user deleted, even at an unchanged version', () => {
    const root = temp()
    const source = bundledExtension('1.0.0')
    fs.rmSync(stageChromeExtension(source, root), { force: true, recursive: true })
    expect(fs.existsSync(path.join(stageChromeExtension(source, root), 'manifest.json'))).toBe(true)
  })

  it('refuses a build whose extension is missing', () => {
    expect(() => stageChromeExtension(path.join(temp(), 'absent'), temp()))
      .toThrow(/missing from this build/)
  })
})

describe('stagedVersion', () => {
  it('reads the manifest version', () => {
    expect(stagedVersion(bundledExtension('0.9.2'))).toBe('0.9.2')
  })

  it('returns null for a missing or damaged manifest', () => {
    const dir = temp()
    expect(stagedVersion(dir)).toBe(null)
    fs.writeFileSync(path.join(dir, 'manifest.json'), '{ not json')
    expect(stagedVersion(dir)).toBe(null)
  })
})

describe('a user-chosen install location', () => {
  it('is remembered and read back', () => {
    const userData = temp()
    expect(rememberedInstallDir(userData)).toBe(null)
    rememberInstallDir(userData, '/Users/x/Documents/codey-chrome-extension')
    expect(rememberedInstallDir(userData)).toBe('/Users/x/Documents/codey-chrome-extension')
  })

  it('installs under the folder name the user will recognise', () => {
    const target = stageChromeExtension(bundledExtension('1.0.0'), temp(), 'codey-chrome-extension')
    expect(path.basename(target)).toBe('codey-chrome-extension')
    expect(fs.existsSync(path.join(target, 'manifest.json'))).toBe(true)
  })

  it('is refreshed on launch when Codey ships a newer extension', () => {
    const userData = temp()
    const chosen = stageChromeExtension(bundledExtension('1.0.0'), temp(), 'codey-chrome-extension')
    rememberInstallDir(userData, chosen)
    expect(refreshRememberedInstall(bundledExtension('1.1.0'), userData)).toBe(chosen)
    expect(stagedVersion(chosen)).toBe('1.1.0')
  })

  it('is left untouched when it already matches', () => {
    const userData = temp()
    const source = bundledExtension('1.0.0')
    const chosen = stageChromeExtension(source, temp(), 'codey-chrome-extension')
    rememberInstallDir(userData, chosen)
    const before = fs.statSync(path.join(chosen, 'manifest.json')).mtimeMs
    refreshRememberedInstall(source, userData)
    expect(fs.statSync(path.join(chosen, 'manifest.json')).mtimeMs).toBe(before)
  })

  it('does nothing when nothing was ever chosen', () => {
    expect(refreshRememberedInstall(bundledExtension('1.0.0'), temp())).toBe(null)
  })

  it('does not recreate a tree under a parent that is gone', () => {
    const userData = temp()
    const parent = temp()
    const chosen = stageChromeExtension(bundledExtension('1.0.0'), parent, 'codey-chrome-extension')
    rememberInstallDir(userData, chosen)
    fs.rmSync(parent, { force: true, recursive: true })
    expect(refreshRememberedInstall(bundledExtension('1.1.0'), userData)).toBe(null)
    expect(fs.existsSync(parent)).toBe(false)
  })

  it('is the folder Chrome should be pointed at once chosen', () => {
    const userData = temp()
    const chosen = stageChromeExtension(bundledExtension('1.0.0'), temp(), 'codey-chrome-extension')
    rememberInstallDir(userData, chosen)
    expect(installedExtensionDir(bundledExtension('1.0.0'), userData)).toBe(chosen)
  })

  it('falls back to the default staging copy when the chosen one is gone', () => {
    const userData = temp()
    rememberInstallDir(userData, path.join(temp(), 'deleted-by-the-user'))
    const dir = installedExtensionDir(bundledExtension('1.0.0'), userData)
    expect(dir).toBe(path.join(userData, 'chrome-extension'))
    expect(fs.existsSync(path.join(dir, 'manifest.json'))).toBe(true)
  })
})

/**
 * The pairing secret is what stops any local process that grabbed the loopback
 * port from posing as Codey: both ends must hold it, so it has to reach every
 * staged copy of the extension and survive re-staging without changing.
 */
describe('pairing secret', () => {
  it('is minted once, restrictively, and then reused', () => {
    const userData = temp()
    const secret = ensurePairingSecret(userData)
    expect(secret.length).toBeGreaterThanOrEqual(32)
    expect(ensurePairingSecret(userData)).toBe(secret)
    const mode = fs.statSync(path.join(userData, PAIRING_SECRET_FILE)).mode & 0o777
    expect(mode).toBe(0o600)
  })

  it('is staged next to the manifest and survives a same-version re-stage', () => {
    const userData = temp()
    const source = bundledExtension('1.0.0')
    const secret = ensurePairingSecret(userData)
    const staged = stageChromeExtension(source, userData, undefined, secret)
    const read = () => JSON.parse(fs.readFileSync(path.join(staged, PAIRING_FILE), 'utf8')).secret
    expect(read()).toBe(secret)
    // A re-stage that skips the copy must still leave the secret in place...
    stageChromeExtension(source, userData, undefined, secret)
    expect(read()).toBe(secret)
    // ...and a version bump rewrites the folder, so the secret is re-added.
    stageChromeExtension(bundledExtension('1.1.0'), userData, undefined, secret)
    expect(read()).toBe(secret)
  })

  it('reaches a remembered install on refresh, even at an unchanged version', () => {
    const userData = temp()
    const source = bundledExtension('1.0.0')
    const chosen = stageChromeExtension(source, temp(), 'codey-chrome-extension')
    rememberInstallDir(userData, chosen)
    const secret = ensurePairingSecret(userData)
    expect(refreshRememberedInstall(source, userData, secret)).toBe(chosen)
    expect(JSON.parse(fs.readFileSync(path.join(chosen, PAIRING_FILE), 'utf8')).secret).toBe(secret)
  })

  it('reaches whichever folder installedExtensionDir points Chrome at', () => {
    const userData = temp()
    const secret = ensurePairingSecret(userData)
    const dir = installedExtensionDir(bundledExtension('1.0.0'), userData, secret)
    expect(JSON.parse(fs.readFileSync(path.join(dir, PAIRING_FILE), 'utf8')).secret).toBe(secret)
  })
})
