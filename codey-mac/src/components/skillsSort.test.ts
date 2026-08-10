import { describe, expect, it } from 'vitest'
import { sortSkills, usageFor, usageLabel } from './skillsSort'
import type { SkillEntry, SkillUsageMap } from '../codey-api'

const skill = (qualifiedName: string): SkillEntry => ({
  name: qualifiedName.split(':').pop()!,
  qualifiedName,
  description: '',
  scope: 'user',
  dir: `/skills/${qualifiedName}`,
  enabled: true,
})

const DAY = 86_400_000
const skills = [skill('alpha'), skill('pack:beta'), skill('gamma')]
const usage: SkillUsageMap = {
  'alpha': { count: 9, lastUsedAt: 1_000 },
  'pack:beta': { count: 2, lastUsedAt: 9_000 },
}

const names = (list: SkillEntry[]) => list.map(s => s.qualifiedName)

describe('sortSkills', () => {
  it('sorts alphabetically by qualified name', () => {
    expect(names(sortSkills(skills, 'name', usage))).toEqual(['alpha', 'gamma', 'pack:beta'])
  })

  it('puts the most recently used first and never-used last', () => {
    expect(names(sortSkills(skills, 'recent', usage))).toEqual(['pack:beta', 'alpha', 'gamma'])
  })

  it('puts the most frequently used first and never-used last', () => {
    expect(names(sortSkills(skills, 'frequent', usage))).toEqual(['alpha', 'pack:beta', 'gamma'])
  })

  it('breaks ties by name and leaves the input untouched', () => {
    const tied: SkillUsageMap = { alpha: { count: 1, lastUsedAt: 5 }, gamma: { count: 1, lastUsedAt: 5 } }
    expect(names(sortSkills(skills, 'frequent', tied))).toEqual(['alpha', 'gamma', 'pack:beta'])
    expect(names(skills)).toEqual(['alpha', 'pack:beta', 'gamma'])
  })
})

describe('usageFor', () => {
  it('matches the qualified name first, then the bare name', () => {
    const map: SkillUsageMap = { 'pack:beta': { count: 3, lastUsedAt: 2 }, 'beta': { count: 7, lastUsedAt: 1 } }
    expect(usageFor(map, skill('pack:beta')).count).toBe(3)
    expect(usageFor({ beta: { count: 7, lastUsedAt: 1 } }, skill('pack:beta')).count).toBe(7)
    expect(usageFor({}, skill('alpha'))).toEqual({ count: 0, lastUsedAt: 0 })
  })
})

describe('usageLabel', () => {
  const now = 100 * DAY

  it('is empty for a skill that was never used', () => {
    expect(usageLabel({ count: 0, lastUsedAt: 0 }, now)).toBe('')
  })

  it('shows the count with a relative time', () => {
    expect(usageLabel({ count: 4, lastUsedAt: now - 3 * DAY }, now)).toBe('used 4× · 3d ago')
    expect(usageLabel({ count: 1, lastUsedAt: now - 5_000 }, now)).toBe('used 1× · just now')
  })

  it('drops the time when the transcript had no usable timestamp', () => {
    expect(usageLabel({ count: 2, lastUsedAt: 0 }, now)).toBe('used 2×')
  })
})
