import { describe, expect, it } from 'vitest'
import { looksLikeLocalPath, skillDisplayName } from './SkillsTab'

describe('skillDisplayName', () => {
  it('adds the Codey namespace to an official skill', () => {
    expect(skillDisplayName({ qualifiedName: 'browser', managedBy: 'codey' })).toBe('codey:browser')
  })

  it('does not change user skills or duplicate an existing namespace', () => {
    expect(skillDisplayName({ qualifiedName: 'browser' })).toBe('browser')
    expect(skillDisplayName({ qualifiedName: 'codey:browser', managedBy: 'codey' })).toBe('codey:browser')
  })
})

describe('looksLikeLocalPath', () => {
  it('treats home, absolute and relative paths as folders', () => {
    for (const p of ['~', '~/skills/one', '/tmp/one', './one', '../one']) expect(looksLikeLocalPath(p)).toBe(true)
  })

  it('treats URLs and bare words as git sources', () => {
    for (const p of ['https://github.com/user/repo', 'git@github.com:user/repo.git', 'one']) expect(looksLikeLocalPath(p)).toBe(false)
  })
})
