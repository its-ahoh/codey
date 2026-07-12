// codey-mac/src/components/automationsModel.test.ts
import { describe, it, expect } from 'vitest'
import { scheduleSummary, timeOfDayToSchedule, nextRunAt, humanizeDelta, draftComplete, formatHHMM, knobsFrom, knobsEqual, checkLabel } from './automationsModel'

describe('scheduleSummary', () => {
  it('renders daily and weekly summaries', () => {
    expect(scheduleSummary({ hour: 9, minute: 0, tz: 'Asia/Shanghai' })).toBe('daily 09:00')
    expect(scheduleSummary({ hour: 18, minute: 30, daysOfWeek: [1, 2, 3, 4, 5], tz: 'UTC' }))
      .toBe('Mon–Fri 18:30')
    expect(scheduleSummary({ hour: 8, minute: 5, daysOfWeek: [0, 6], tz: 'UTC' })).toBe('Sun, Sat 08:05')
    expect(scheduleSummary(undefined)).toBe('manual')
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

describe('formatHHMM', () => {
  it('zero-pads hour and minute', () => {
    expect(formatHHMM(9, 5)).toBe('09:05')
    expect(formatHHMM(0, 0)).toBe('00:00')
    expect(formatHHMM(23, 59)).toBe('23:59')
  })
})

describe('knobsFrom', () => {
  const base = {
    params: { topic: 'ai' },
    schedule: { hour: 9, minute: 5, daysOfWeek: [5, 1, 3], tz: 'UTC' },
    report: { notify: true },
  }

  it('maps fields and sorts days', () => {
    expect(knobsFrom(base)).toEqual({
      params: { topic: 'ai' },
      scheduleOn: true,
      time: '09:05',
      days: [1, 3, 5],
      notify: true,
    })
  })

  it('defaults for a manual-only automation', () => {
    expect(knobsFrom({ params: {}, report: { notify: false } })).toEqual({
      params: {},
      scheduleOn: false,
      time: '09:00',
      days: [],
      notify: false,
    })
  })
})

describe('knobsEqual', () => {
  const auto = {
    params: { topic: 'ai' },
    schedule: { hour: 9, minute: 5, daysOfWeek: [5, 1, 3], tz: 'UTC' },
    report: { notify: true },
  }

  it('is true for knobs seeded from the same automation', () => {
    expect(knobsEqual(knobsFrom(auto), auto)).toBe(true)
  })

  it('tolerates unsorted persisted daysOfWeek (no phantom dirty)', () => {
    const seeded = knobsFrom(auto)
    expect(seeded.days).toEqual([1, 3, 5])
    expect(knobsEqual(seeded, auto)).toBe(true)
  })

  it('is false when a param differs', () => {
    expect(knobsEqual({ ...knobsFrom(auto), params: { topic: 'ml' } }, auto)).toBe(false)
  })

  it('is false when time differs', () => {
    expect(knobsEqual({ ...knobsFrom(auto), time: '10:05' }, auto)).toBe(false)
  })

  it('is false when notify differs', () => {
    expect(knobsEqual({ ...knobsFrom(auto), notify: false }, auto)).toBe(false)
  })

  it('is false when scheduleOn differs', () => {
    expect(knobsEqual({ ...knobsFrom(auto), scheduleOn: false }, auto)).toBe(false)
  })

  it('ignores time/days when the schedule is off on both sides', () => {
    const manual = { params: {}, report: { notify: true } }
    expect(knobsEqual({ ...knobsFrom(manual), time: '17:00', days: [2] }, manual)).toBe(true)
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

describe('checkLabel', () => {
  it('maps each check state to its status-row label', () => {
    expect(checkLabel('pending')).toEqual({ text: 'checking…', tone: 'dim' })
    expect(checkLabel('clean')).toEqual({ text: '✓ unattended-ready', tone: 'good' })
    expect(checkLabel('gaps')).toEqual({ text: '⚠ may need input during runs', tone: 'warn' })
    expect(checkLabel('error')).toEqual({ text: 'check failed', tone: 'dim' })
    expect(checkLabel(undefined)).toBeNull()
  })
})
