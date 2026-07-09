import { describe, it, expect } from 'vitest'
import { relativeTime, timelineRows, skillActions } from './learnedSkillsModel'

const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000

describe('relativeTime', () => {
  const now = 1_000 * DAY
  it('formats just now / minutes / hours / days', () => {
    expect(relativeTime(now - 10_000, now)).toBe('just now')
    expect(relativeTime(now - 5 * MIN, now)).toBe('5m ago')
    expect(relativeTime(now - 3 * HOUR, now)).toBe('3h ago')
    expect(relativeTime(now - 2 * DAY, now)).toBe('2d ago')
  })
})

describe('timelineRows', () => {
  const now = 1_000 * DAY
  it('maps evolution events to display rows, oldest first', () => {
    const rows = timelineRows([
      { at: now - 2 * DAY, kind: 'created', toVersion: 1, steps: 's1' },
      { at: now - DAY, kind: 'evolved', fromVersion: 1, toVersion: 2,
        trigger: { runId: 'r1', promptSummary: 'draft release notes for v2.1' }, steps: 's2' },
      { at: now - 3 * HOUR, kind: 'rolled-back', fromVersion: 2, toVersion: 1, steps: 's1' },
    ], now)
    expect(rows).toEqual([
      { label: 'v1 created', when: '2d ago', trigger: undefined, steps: 's1' },
      { label: 'v2 evolved', when: '1d ago', trigger: 'draft release notes for v2.1', steps: 's2' },
      { label: 'v1 rolled back', when: '3h ago', trigger: undefined, steps: 's1' },
    ])
  })

  it('truncates long trigger summaries to 80 chars with ellipsis', () => {
    const long = 'x'.repeat(120)
    const rows = timelineRows([
      { at: 0, kind: 'evolved', fromVersion: 1, toVersion: 2,
        trigger: { runId: 'r', promptSummary: long }, steps: 's' },
    ], 0)
    expect(rows[0].trigger!.length).toBe(81) // 80 + ellipsis char
    expect(rows[0].trigger!.endsWith('…')).toBe(true)
  })
})

describe('skillActions', () => {
  it('derives which action buttons are enabled', () => {
    expect(skillActions({ archived: false, canRollback: true }))
      .toEqual({ forget: true, restore: false, rollback: true })
    expect(skillActions({ archived: true, canRollback: false }))
      .toEqual({ forget: false, restore: true, rollback: false })
  })

  it('allows rollback on archived skills, matching the gateway', () => {
    expect(skillActions({ archived: true, canRollback: true }))
      .toEqual({ forget: false, restore: true, rollback: true })
  })
})
