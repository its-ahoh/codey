import { describe, it, expect } from 'vitest'
import { validateSchedule, validateAutomationDraft, validateAutomationPatch } from './automation-validate'

describe('validateSchedule', () => {
  it('accepts a valid schedule (times shape and legacy single) and no schedule at all', () => {
    expect(() => validateSchedule({ times: [{ hour: 9, minute: 30 }], tz: 'Asia/Shanghai' })).not.toThrow()
    expect(() => validateSchedule({ times: [{ hour: 9, minute: 0 }, { hour: 18, minute: 0 }], tz: 'UTC' })).not.toThrow()
    expect(() => validateSchedule({ hour: 9, minute: 30, tz: 'Asia/Shanghai' })).not.toThrow() // legacy
    expect(() => validateSchedule(undefined)).not.toThrow()
  })

  it('rejects an empty or non-array times', () => {
    expect(() => validateSchedule({ times: [], tz: 'UTC' })).toThrow(/times/)
    expect(() => validateSchedule({ times: 'daily', tz: 'UTC' })).toThrow(/times/)
  })

  it('rejects out-of-range or non-integer hour/minute', () => {
    expect(() => validateSchedule({ times: [{ hour: 24, minute: 0 }], tz: 'UTC' })).toThrow(/hour/)
    expect(() => validateSchedule({ times: [{ hour: 9.5, minute: 0 }], tz: 'UTC' })).toThrow(/hour/)
    expect(() => validateSchedule({ times: [{ hour: 9, minute: 60 }], tz: 'UTC' })).toThrow(/minute/)
    expect(() => validateSchedule({ times: [{ hour: 9, minute: 0 }, { hour: 9, minute: -1 }], tz: 'UTC' })).toThrow(/minute/)
    expect(() => validateSchedule({ hour: 24, minute: 0, tz: 'UTC' })).toThrow(/hour/) // legacy
  })

  it('rejects a tz that Intl does not know', () => {
    expect(() => validateSchedule({ times: [{ hour: 9, minute: 0 }], tz: 'Beijing' })).toThrow(/time zone/)
    expect(() => validateSchedule({ times: [{ hour: 9, minute: 0 }] })).toThrow(/time zone/)
  })
})

describe('validateAutomationDraft / validateAutomationPatch', () => {
  it('requires a valid report.notify on create, only present fields on update', () => {
    expect(() => validateAutomationDraft({ report: { notify: true } })).toThrow(/report\.notify/) // booleans are not modes
    for (const mode of ['all', 'failure', 'success', 'none']) {
      expect(() => validateAutomationDraft({ report: { notify: mode } })).not.toThrow()
    }
    expect(() => validateAutomationDraft({})).toThrow(/report\.notify/)
    expect(() => validateAutomationDraft({ report: { notify: 'yes' } })).toThrow(/report\.notify/)
    expect(() => validateAutomationPatch({ name: 'x' })).not.toThrow() // no schedule on the patch
    expect(() => validateAutomationPatch({ schedule: { hour: 9, minute: 0, tz: 'Beijing' } })).toThrow(/time zone/)
    expect(() => validateAutomationPatch({ report: { notify: 'failure' } })).not.toThrow()
    expect(() => validateAutomationPatch({ report: { notify: 'sometimes' } })).toThrow(/report\.notify/)
  })
})
