import { describe, expect, it } from 'vitest'
import { describeSkillPack, skillPackConflictPrompt, skillPackSourceLabel } from './skillPackDisplay'

describe('skill pack display', () => {
  it('shortens a source to one line', () => {
    expect(skillPackSourceLabel('https://github.com/cursor/plugins/tree/main/pstack')).toBe('github.com/cursor/plugins/tree/main/pstack')
    expect(skillPackSourceLabel('https://github.com/me/pack.git')).toBe('github.com/me/pack')
    expect(skillPackSourceLabel('/Users/me/packs/mine')).toBe('/Users/me/packs/mine')
  })

  it('says how big the pack is, where it is from, and whether it needs attention', () => {
    const pack = { skills: ['a', 'b'], source: 'https://github.com/me/pack.git', state: 'installed' as const }
    expect(describeSkillPack(pack)).toBe('2 skills · github.com/me/pack')
    expect(describeSkillPack({ ...pack, skills: ['a'] }, null)).toBe('1 skill · github.com/me/pack')
    expect(describeSkillPack({ ...pack, state: 'disabled' }, true)).toBe('2 skills · github.com/me/pack · turned off · update available')
  })

  it('names the clashing skills before replacing them, and caps a long list', () => {
    expect(skillPackConflictPrompt('pstack', ['tdd'])).toContain(': tdd.')
    const prompt = skillPackConflictPrompt('pstack', ['a', 'b', 'c', 'd', 'e', 'f', 'g'])
    expect(prompt).toContain('a, b, c, d, e and 2 more')
  })
})
