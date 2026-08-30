import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir, homedir } from 'os'
import { join } from 'path'
import { resolveRefPath, locateRefPath } from './file-ref'

describe('resolveRefPath', () => {
  it('keeps an absolute path', () => {
    expect(resolveRefPath('/tmp/a.ts')).toBe('/tmp/a.ts')
  })

  it('expands ~', () => {
    expect(resolveRefPath('~/notes.md')).toBe(join(homedir(), 'notes.md'))
  })

  it('resolves a relative path against the working dir', () => {
    expect(resolveRefPath('src/app.ts', '/repo')).toBe('/repo/src/app.ts')
    expect(resolveRefPath('./src/app.ts', '/repo')).toBe('/repo/src/app.ts')
  })

  it('refuses a relative path with no working dir', () => {
    expect(resolveRefPath('src/app.ts')).toBeNull()
    expect(resolveRefPath('')).toBeNull()
  })
})

describe('locateRefPath', () => {
  it('reports a file, a directory and a miss', async () => {
    const root = mkdtempSync(join(tmpdir(), 'file-ref-'))
    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'src', 'app.ts'), 'x')

    await expect(locateRefPath('src/app.ts', root)).resolves.toEqual({
      absPath: join(root, 'src/app.ts'), exists: true, isDirectory: false,
    })
    await expect(locateRefPath('src', root)).resolves.toEqual({
      absPath: join(root, 'src'), exists: true, isDirectory: true,
    })
    await expect(locateRefPath('src/nope.ts', root)).resolves.toEqual({
      absPath: join(root, 'src/nope.ts'), exists: false, isDirectory: false,
    })
    await expect(locateRefPath('src/app.ts', null)).resolves.toEqual({
      absPath: null, exists: false, isDirectory: false,
    })
  })
})
