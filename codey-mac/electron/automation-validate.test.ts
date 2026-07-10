import { describe, it, expect } from 'vitest'
import { validateSchedule, validateAutomationDraft, validateAutomationPatch } from './automation-validate'

describe('validateSchedule', () => {
  it('accepts a valid schedule and no schedule at all', () => {
    expect(() => validateSchedule({ hour: 9, minute: 30, tz: 'Asia/Shanghai' })).not.toThrow()
    expect(() => validateSchedule(undefined)).not.toThrow()
  })

  it('rejects out-of-range or non-integer hour/minute', () => {
    expect(() => validateSchedule({ hour: 24, minute: 0, tz: 'UTC' })).toThrow(/hour/)
    expect(() => validateSchedule({ hour: 9.5, minute: 0, tz: 'UTC' })).toThrow(/hour/)
    expect(() => validateSchedule({ hour: 9, minute: 60, tz: 'UTC' })).toThrow(/minute/)
    expect(() => validateSchedule({ hour: 9, minute: -1, tz: 'UTC' })).toThrow(/minute/)
  })

  it('rejects a tz that Intl does not know', () => {
    expect(() => validateSchedule({ hour: 9, minute: 0, tz: 'Beijing' })).toThrow(/time zone/)
    expect(() => validateSchedule({ hour: 9, minute: 0 })).toThrow(/time zone/)
  })
})

describe('validateAutomationDraft / validateAutomationPatch', () => {
  it('requires report.notify boolean on create, only present fields on update', () => {
    expect(() => validateAutomationDraft({ report: { notify: true } })).not.toThrow()
    expect(() => validateAutomationDraft({})).toThrow(/report\.notify/)
    expect(() => validateAutomationDraft({ report: { notify: 'yes' } })).toThrow(/report\.notify/)
    expect(() => validateAutomationPatch({ name: 'x' })).not.toThrow() // no schedule on the patch
    expect(() => validateAutomationPatch({ schedule: { hour: 9, minute: 0, tz: 'Beijing' } })).toThrow(/time zone/)
  })
})
