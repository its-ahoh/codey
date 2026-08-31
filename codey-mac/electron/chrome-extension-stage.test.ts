import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { stageChromeExtension, stagedVersion } from './chrome-extension-stage'

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
