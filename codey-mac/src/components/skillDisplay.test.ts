import { describe, expect, it } from 'vitest'
import { skillDisplayName } from './SkillsTab'

describe('skillDisplayName', () => {
  it('adds the Codey namespace to an official skill', () => {
    expect(skillDisplayName({ qualifiedName: 'browser', managedBy: 'codey' })).toBe('codey:browser')
  })

  it('does not change user skills or duplicate an existing namespace', () => {
    expect(skillDisplayName({ qualifiedName: 'browser' })).toBe('browser')
    expect(skillDisplayName({ qualifiedName: 'codey:browser', managedBy: 'codey' })).toBe('codey:browser')
  })
})
