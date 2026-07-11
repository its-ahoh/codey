// codey-mac/src/components/automationsModel.test.ts
import { describe, it, expect } from 'vitest'
import { scheduleSummary, canSchedule, timeOfDayToSchedule, nextRunAt, humanizeDelta, draftComplete } from './automationsModel'

describe('scheduleSummary', () => {
  it('renders daily and weekly summaries', () => {
    expect(scheduleSummary({ hour: 9, minute: 0, tz: 'Asia/Shanghai' })).toBe('daily 09:00')
    expect(scheduleSummary({ hour: 18, minute: 30, daysOfWeek: [1, 2, 3, 4, 5], tz: 'UTC' }))
      .toBe('Mon–Fri 18:30')
    expect(scheduleSummary({ hour: 8, minute: 5, daysOfWeek: [0, 6], tz: 'UTC' })).toBe('Sun, Sat 08:05')
    expect(scheduleSummary(undefined)).toBe('manual')
  })
})

describe('canSchedule', () => {
  it('requires a synthesized brief (spec: interview is the gate)', () => {
    expect(canSchedule({ brief: '' })).toBe(false)
    expect(canSchedule({ brief: '  ' })).toBe(false)
    expect(canSchedule({ brief: 'Post news.' })).toBe(true)
  })
})

describe('timeOfDayToSchedule', () => {
  it('maps an HH:MM picker value + tz into a structured schedule', () => {
    expect(timeOfDayToSchedule('09:30', 'Asia/Shanghai', [1, 3]))
      .toEqual({ hour: 9, minute: 30, tz: 'Asia/Shanghai', daysOfWeek: [1, 3] })
    expect(timeOfDayToSchedule('9:5', 'UTC')).toEqual({ hour: 9, minute: 5, tz: 'UTC' })
    expect(timeOfDayToSchedule('25:00', 'UTC')).toBeNull()
  })
})

describe('nextRunAt', () => {
  // 2026-07-02T09:00 Asia/Shanghai (a Thursday) is 2026-07-02T01:00Z; SH has no DST.
  const SH_9AM = Date.UTC(2026, 6, 2, 1, 0, 0)
  const daily = { hour: 9, minute: 0, tz: 'Asia/Shanghai' }

  it('returns the next slot today when still ahead', () => {
    expect(nextRunAt(daily, SH_9AM - 3600_000)).toBe(SH_9AM)
  })
  it('rolls to tomorrow when the slot already passed or is exactly now', () => {
    expect(nextRunAt(daily, SH_9AM)).toBe(SH_9AM + 86_400_000)
  })
  it('respects daysOfWeek', () => {
    // Thursday 08:00 with Friday-only schedule -> Friday 09:00
    expect(nextRunAt({ ...daily, daysOfWeek: [5] }, SH_9AM - 3600_000)).toBe(SH_9AM + 86_400_000)
  })
  it('returns null for manual-only', () => {
    expect(nextRunAt(undefined, SH_9AM)).toBeNull()
  })
  it('crosses a spring-forward transition correctly (DST)', () => {
    // 2026-03-08 02:00 America/New_York springs forward; 09:00 NY that day is 13:00Z
    const before = Date.UTC(2026, 2, 8, 1, 0, 0) // 2026-03-07 20:00 NY
    expect(nextRunAt({ hour: 9, minute: 0, tz: 'America/New_York' }, before))
      .toBe(Date.UTC(2026, 2, 8, 13, 0, 0))
  })
  it('does not skip a calendar day near midnight before spring-forward', () => {
    // Sat 2026-03-07 23:30 NY; daily 23:00 schedule -> Sunday Mar 8 23:00 EDT = Mar 9 03:00Z
    const satLate = Date.UTC(2026, 2, 8, 4, 30, 0)
    expect(nextRunAt({ hour: 23, minute: 0, tz: 'America/New_York' }, satLate))
      .toBe(Date.UTC(2026, 2, 9, 3, 0, 0))
  })
})

describe('humanizeDelta', () => {
  it('formats minutes, hours, days', () => {
    expect(humanizeDelta(30_000)).toBe('in <1m')
    expect(humanizeDelta(5 * 60_000)).toBe('in 5m')
    expect(humanizeDelta(14 * 3600_000)).toBe('in 14h')
    expect(humanizeDelta(3 * 86_400_000)).toBe('in 3d')
  })
})

describe('draftComplete', () => {
  it('requires name, brief, and a workspace', () => {
    expect(draftComplete({})).toBe(false)
    expect(draftComplete({ name: 'n', brief: 'b' })).toBe(false)
    expect(draftComplete({ name: ' ', brief: 'b', target: { workspaceName: 'w' } })).toBe(false)
    expect(draftComplete({ name: 'n', brief: 'b', target: { workspaceName: ' ' } })).toBe(false)
    expect(draftComplete({ name: 'n', brief: 'b', target: { workspaceName: 'w' } })).toBe(true)
  })
})
