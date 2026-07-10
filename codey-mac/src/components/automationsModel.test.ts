// codey-mac/src/components/automationsModel.test.ts
import { describe, it, expect } from 'vitest'
import { scheduleSummary, canSchedule, timeOfDayToSchedule } from './automationsModel'

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
