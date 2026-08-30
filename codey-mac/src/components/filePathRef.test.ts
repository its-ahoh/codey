import { describe, it, expect } from 'vitest'
import { opensInSystemApp, parseFileRef } from './filePathRef'

describe('parseFileRef', () => {
  it('accepts absolute, home and relative paths', () => {
    expect(parseFileRef('/Users/me/project/src/app.ts')).toEqual({ path: '/Users/me/project/src/app.ts' })
    expect(parseFileRef('~/notes/todo.md')).toEqual({ path: '~/notes/todo.md' })
    expect(parseFileRef('./scripts/build.sh')).toEqual({ path: './scripts/build.sh' })
    expect(parseFileRef('src/gateway.ts')).toEqual({ path: 'src/gateway.ts' })
  })

  it('accepts a bare filename and a dotfile', () => {
    expect(parseFileRef('package.json')).toEqual({ path: 'package.json' })
    expect(parseFileRef('.env')).toEqual({ path: '.env' })
  })

  it('accepts a directory, without its trailing slash', () => {
    expect(parseFileRef('src/components/')).toEqual({ path: 'src/components' })
    expect(parseFileRef('/tmp')).toEqual({ path: '/tmp' })
  })

  it('pulls out a line number', () => {
    expect(parseFileRef('src/app.ts:42')).toEqual({ path: 'src/app.ts', line: 42 })
    expect(parseFileRef('src/app.ts:42:7')).toEqual({ path: 'src/app.ts', line: 42 })
  })

  it('drops punctuation that got swept in', () => {
    expect(parseFileRef('(src/app)')).toEqual({ path: 'src/app' })
    expect(parseFileRef('src/app.ts')).toEqual({ path: 'src/app.ts' })
  })

  it('rejects URLs and mail addresses', () => {
    expect(parseFileRef('https://example.com/a.ts')).toBeNull()
    expect(parseFileRef('mailto:me@example.com')).toBeNull()
  })

  it('rejects commands, prose and globs', () => {
    expect(parseFileRef('npm run build')).toBeNull()
    expect(parseFileRef('src/**/*.ts')).toBeNull()
    expect(parseFileRef('gateway')).toBeNull()
    expect(parseFileRef('')).toBeNull()
    expect(parseFileRef('x'.repeat(500))).toBeNull()
  })
})

describe('opensInSystemApp', () => {
  it('sends documents, media and archives to the OS', () => {
    expect(opensInSystemApp('docs/spec.pdf')).toBe(true)
    expect(opensInSystemApp('/tmp/shot.PNG')).toBe(true)
    expect(opensInSystemApp('build/app.zip')).toBe(true)
  })

  it('keeps text-ish files in the editor', () => {
    expect(opensInSystemApp('src/app.ts')).toBe(false)
    expect(opensInSystemApp('icon.svg')).toBe(false)
    expect(opensInSystemApp('notes.md')).toBe(false)
    expect(opensInSystemApp('Makefile')).toBe(false)
    expect(opensInSystemApp('data.weirdext')).toBe(false)
  })
})
