import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { C, tint } from './theme'

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : []
  })

describe('tint', () => {
  it('builds a see-through color that works with CSS variables', () => {
    expect(tint(C.red, 13)).toBe('color-mix(in srgb, var(--red) 13%, transparent)')
  })

  it('is used instead of a hex alpha suffix, which is invalid on var() tokens', () => {
    const invalid = /\$\{(?:C\.\w+|toneColor\([^)]*\))\}[0-9a-fA-F]{2}(?![0-9a-zA-Z])|\bC\.\w+ \+ ['"`][0-9a-fA-F]{2,8}['"`]/
    const offenders = sourceFiles(__dirname).filter(file => invalid.test(readFileSync(file, 'utf8')))
    expect(offenders).toEqual([])
  })
})
