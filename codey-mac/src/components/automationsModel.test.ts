// codey-mac/src/components/automationsModel.test.ts
import { describe, it, expect } from 'vitest'
import { scheduleSummary, slotsToSchedule, nextRunAt, humanizeDelta, draftComplete, formatHHMM, knobsFrom, knobsEqual, checkLabel } from './automationsModel'

const t = (hour: number, minute: number, daysOfWeek?: number[]) => ({ hour, minute, ...(daysOfWeek ? { daysOfWeek } : {}) })

describe('scheduleSummary', () => {
  it('renders daily and weekly summaries', () => {
    expect(scheduleSummary({ slots: [t(9, 0)], tz: 'Asia/Shanghai' })).toBe('daily 09:00')
    expect(scheduleSummary({ slots: [t(18, 30, [1, 2, 3, 4, 5])], tz: 'UTC' }))
      .toBe('Mon–Fri 18:30')
    expect(scheduleSummary({ slots: [t(8, 5, [0, 6])], tz: 'UTC' })).toBe('Sun, Sat 08:05')
    expect(scheduleSummary(undefined)).toBe('manual')
  })
  it('lists every time of a multi-time schedule', () => {
    expect(scheduleSummary({ slots: [t(9, 0), t(18, 30)], tz: 'UTC' })).toBe('daily 09:00, 18:30')
  })
  it('keeps each time connected to its own weekdays', () => {
    expect(scheduleSummary({ slots: [t(21, 0, [1, 2, 3]), t(12, 0, [4, 5])], tz: 'UTC' }))
      .toBe('Mon–Wed 21:00 · Thu–Fri 12:00')
  })
})

describe('slotsToSchedule', () => {
  it('maps linked time/day picker values into a structured schedule', () => {
    expect(slotsToSchedule([{ time: '09:30', days: [1, 3] }], 'Asia/Shanghai'))
      .toEqual({ slots: [t(9, 30, [1, 3])], tz: 'Asia/Shanghai' })
    expect(slotsToSchedule([{ time: '9:5', days: [] }], 'UTC')).toEqual({ slots: [t(9, 5)], tz: 'UTC' })
    expect(slotsToSchedule([{ time: '25:00', days: [] }], 'UTC')).toBeNull()
  })
  it('sorts and dedupes slots; rejects empty or partially invalid lists', () => {
    expect(slotsToSchedule([{ time: '18:00', days: [] }, { time: '09:00', days: [] }, { time: '18:00', days: [] }], 'UTC'))
      .toEqual({ slots: [t(9, 0), t(18, 0)], tz: 'UTC' })
    expect(slotsToSchedule([], 'UTC')).toBeNull()
    expect(slotsToSchedule([{ time: '09:00', days: [] }, { time: 'bogus', days: [] }], 'UTC')).toBeNull()
  })
})

describe('nextRunAt', () => {
  // 2026-07-02T09:00 Asia/Shanghai (a Thursday) is 2026-07-02T01:00Z; SH has no DST.
  const SH_9AM = Date.UTC(2026, 6, 2, 1, 0, 0)
  const daily = { slots: [t(9, 0)], tz: 'Asia/Shanghai' }

  it('returns the next slot today when still ahead', () => {
    expect(nextRunAt(daily, SH_9AM - 3600_000)).toBe(SH_9AM)
  })
  it('rolls to tomorrow when the slot already passed or is exactly now', () => {
    expect(nextRunAt(daily, SH_9AM)).toBe(SH_9AM + 86_400_000)
  })
  it('respects daysOfWeek', () => {
    // Thursday 08:00 with Friday-only schedule -> Friday 09:00
    expect(nextRunAt({ ...daily, slots: [t(9, 0, [5])] }, SH_9AM - 3600_000)).toBe(SH_9AM + 86_400_000)
  })
  it('returns null for manual-only', () => {
    expect(nextRunAt(undefined, SH_9AM)).toBeNull()
  })
  it('picks the nearest of multiple daily times', () => {
    const multi = { slots: [t(9, 0), t(18, 0)], tz: 'Asia/Shanghai' }
    // Just after 09:00: next slot is 18:00 today, not 09:00 tomorrow.
    expect(nextRunAt(multi, SH_9AM)).toBe(SH_9AM + 9 * 3600_000)
    expect(nextRunAt(multi, SH_9AM + 9 * 3600_000)).toBe(SH_9AM + 86_400_000)
  })
  it('keeps weekdays linked to their individual times', () => {
    const linked = { slots: [t(21, 0, [1, 2, 3]), t(12, 0, [4, 5])], tz: 'Asia/Shanghai' }
    // Thursday at 11:00: noon today is valid; Thursday 21:00 is not.
    const thursday11 = Date.UTC(2026, 6, 2, 3, 0, 0)
    expect(nextRunAt(linked, thursday11)).toBe(Date.UTC(2026, 6, 2, 4, 0, 0))
    // After Thursday noon, next is Friday noon—not Thursday 21:00.
    expect(nextRunAt(linked, Date.UTC(2026, 6, 2, 5, 0, 0))).toBe(Date.UTC(2026, 6, 3, 4, 0, 0))
  })
  it('crosses a spring-forward transition correctly (DST)', () => {
    // 2026-03-08 02:00 America/New_York springs forward; 09:00 NY that day is 13:00Z
    const before = Date.UTC(2026, 2, 8, 1, 0, 0) // 2026-03-07 20:00 NY
    expect(nextRunAt({ slots: [t(9, 0)], tz: 'America/New_York' }, before))
      .toBe(Date.UTC(2026, 2, 8, 13, 0, 0))
  })
  it('does not skip a calendar day near midnight before spring-forward', () => {
    // Sat 2026-03-07 23:30 NY; daily 23:00 schedule -> Sunday Mar 8 23:00 EDT = Mar 9 03:00Z
    const satLate = Date.UTC(2026, 2, 8, 4, 30, 0)
    expect(nextRunAt({ slots: [t(23, 0)], tz: 'America/New_York' }, satLate))
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
    schedule: { slots: [t(9, 5, [5, 1, 3]), t(18, 0, [5, 1, 3])], tz: 'UTC' },
    report: { notify: 'all' as const },
  }

  it('maps fields and sorts days', () => {
    expect(knobsFrom(base)).toEqual({
      params: { topic: 'ai' },
      scheduleOn: true,
      slots: [{ time: '09:05', days: [1, 3, 5] }, { time: '18:00', days: [1, 3, 5] }],
      notify: 'all',
    })
  })

  it('defaults for a manual-only automation', () => {
    expect(knobsFrom({ params: {}, report: { notify: 'none' } })).toEqual({
      params: {},
      scheduleOn: false,
      slots: [{ time: '09:00', days: [] }],
      notify: 'none',
    })
  })

  it('passes notify modes through', () => {
    expect(knobsFrom({ params: {}, report: { notify: 'failure' } }).notify).toBe('failure')
  })
})

describe('knobsEqual', () => {
  const auto = {
    params: { topic: 'ai' },
    schedule: { slots: [t(9, 5, [5, 1, 3]), t(18, 0, [5, 1, 3])], tz: 'UTC' },
    report: { notify: 'all' as const },
  }

  it('is true for knobs seeded from the same automation', () => {
    expect(knobsEqual(knobsFrom(auto), auto)).toBe(true)
  })

  it('tolerates unsorted persisted daysOfWeek (no phantom dirty)', () => {
    const seeded = knobsFrom(auto)
    expect(seeded.slots[0].days).toEqual([1, 3, 5])
    expect(knobsEqual(seeded, auto)).toBe(true)
  })

  it('is false when a param differs', () => {
    expect(knobsEqual({ ...knobsFrom(auto), params: { topic: 'ml' } }, auto)).toBe(false)
  })

  it('is false when times differ', () => {
    expect(knobsEqual({ ...knobsFrom(auto), slots: [{ time: '10:05', days: [1, 3, 5] }, { time: '18:00', days: [1, 3, 5] }] }, auto)).toBe(false)
    expect(knobsEqual({ ...knobsFrom(auto), slots: [{ time: '09:05', days: [1, 3, 5] }] }, auto)).toBe(false)
  })

  it('tolerates unordered staged times (no phantom dirty)', () => {
    expect(knobsEqual({ ...knobsFrom(auto), slots: [...knobsFrom(auto).slots].reverse() }, auto)).toBe(true)
  })

  it('is false when notify differs', () => {
    expect(knobsEqual({ ...knobsFrom(auto), notify: 'none' }, auto)).toBe(false)
  })

  it('is false when scheduleOn differs', () => {
    expect(knobsEqual({ ...knobsFrom(auto), scheduleOn: false }, auto)).toBe(false)
  })

  it('ignores times/days when the schedule is off on both sides', () => {
    const manual = { params: {}, report: { notify: 'all' as const } }
    expect(knobsEqual({ ...knobsFrom(manual), slots: [{ time: '17:00', days: [2] }] }, manual)).toBe(true)
  })
})

describe('draftComplete', () => {
  it('requires name, brief, and a workspace', () => {
    expect(draftComplete({})).toBe(false)
    expect(draftComplete({ name: 'n', brief: 'b' })).toBe(false)
    expect(draftComplete({ name: ' ', brief: 'b', target: { workspaceName: 'w' } })).toBe(false)
    expect(draftComplete({ name: 'n', brief: 'b', target: { workspaceName: ' ' } })).toBe(false)
    expect(draftComplete({ name: 'n', brief: 'b', target: { workspaceName: 'w' } })).toBe(true)
    expect(draftComplete({ name: 'n', brief: 'b', target: { kind: 'team', workspaceName: 'w' } })).toBe(false)
    expect(draftComplete({ name: 'n', brief: 'b', target: { kind: 'team', workspaceName: 'w', teamName: 'news' } })).toBe(true)
  })
})

describe('checkLabel', () => {
  it('maps each check state to its status-row label', () => {
    expect(checkLabel('pending')).toEqual({ text: 'Checking setup…', tone: 'dim' })
    expect(checkLabel('clean')).toEqual({ text: 'Ready to run unattended', tone: 'good' })
    expect(checkLabel('gaps')).toEqual({ text: 'Needs clarification', tone: 'warn' })
    expect(checkLabel('error')).toEqual({ text: 'Check couldn’t run', tone: 'dim' })
    expect(checkLabel(undefined)).toBeNull()
  })
})
