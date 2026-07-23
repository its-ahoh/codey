import { describe, expect, it } from 'vitest'
import { languageForFilePath, resolveSharedContextGap } from './toolFormat'

describe('resolveSharedContextGap', () => {
  it('keeps separated context when unrevealed lines remain between hunks', () => {
    expect(resolveSharedContextGap(25, 10, 10)).toEqual({
      merged: false,
      after: 10,
      before: 10,
    })
  })

  it('merges the entire gap once expansions from both hunks meet', () => {
    expect(resolveSharedContextGap(15, 10, 10)).toEqual({
      merged: true,
      after: 15,
      before: 0,
    })
  })

  it('merges adjacent hunks without requiring an extra expansion', () => {
    expect(resolveSharedContextGap(0, 0, 0)).toEqual({
      merged: true,
      after: 0,
      before: 0,
    })
  })
})

describe('languageForFilePath', () => {
  it('recognizes common source and markup files', () => {
    expect(languageForFilePath('/repo/src/view.tsx')).toBe('typescript')
    expect(languageForFilePath('/repo/query.sql')).toBe('sql')
    expect(languageForFilePath('/repo/icon.svg')).toBe('xml')
  })

  it('recognizes extensionless Dockerfiles and leaves unknown files plain', () => {
    expect(languageForFilePath('/repo/Dockerfile')).toBe('bash')
    expect(languageForFilePath('/repo/data.unknown')).toBeUndefined()
  })
})
