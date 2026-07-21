import { describe, it, expect } from 'vitest'
import { validateSchedule, validateAutomationChatPatch, validateAutomationDraft, validateAutomationPatch } from './automation-validate'

describe('validateSchedule', () => {
  it('accepts a valid schedule (slots shape and legacy forms) and no schedule at all', () => {
    expect(() => validateSchedule({ slots: [{ hour: 9, minute: 30 }], tz: 'Asia/Shanghai' })).not.toThrow()
    expect(() => validateSchedule({ slots: [{ hour: 9, minute: 0, daysOfWeek: [1, 2, 3] }, { hour: 18, minute: 0, daysOfWeek: [4, 5] }], tz: 'UTC' })).not.toThrow()
    expect(() => validateSchedule({ times: [{ hour: 9, minute: 30 }], tz: 'Asia/Shanghai' })).not.toThrow()
    expect(() => validateSchedule({ hour: 9, minute: 30, tz: 'Asia/Shanghai' })).not.toThrow() // legacy
    expect(() => validateSchedule(undefined)).not.toThrow()
  })

  it('rejects an empty or non-array times', () => {
    expect(() => validateSchedule({ slots: [], tz: 'UTC' })).toThrow(/slots/)
    expect(() => validateSchedule({ slots: 'daily', tz: 'UTC' })).toThrow(/slots/)
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

  it('validates weekday values', () => {
    expect(() => validateSchedule({ slots: [{ hour: 9, minute: 0, daysOfWeek: [1, 5] }], tz: 'UTC' })).not.toThrow()
    expect(() => validateSchedule({ slots: [{ hour: 9, minute: 0, daysOfWeek: [7] }], tz: 'UTC' })).toThrow(/daysOfWeek/)
    expect(() => validateSchedule({ times: [{ hour: 9, minute: 0 }], daysOfWeek: [], tz: 'UTC' })).not.toThrow()
    expect(() => validateSchedule({ times: [{ hour: 9, minute: 0 }], daysOfWeek: [1, 5], tz: 'UTC' })).not.toThrow()
    expect(() => validateSchedule({ times: [{ hour: 9, minute: 0 }], daysOfWeek: [7], tz: 'UTC' })).toThrow(/daysOfWeek/)
    expect(() => validateSchedule({ times: [{ hour: 9, minute: 0 }], daysOfWeek: 'weekdays', tz: 'UTC' })).toThrow(/daysOfWeek/)
  })
})

describe('validateAutomationDraft / validateAutomationPatch', () => {
  const validDraft = (over: Record<string, unknown> = {}) => ({
    name: 'News', enabled: true,
    target: { kind: 'prompt', workspaceName: 'default' },
    brief: 'Post the news.', params: {}, report: { notify: 'none' },
    ...over,
  })

  it('requires a complete valid definition on create', () => {
    expect(() => validateAutomationDraft(validDraft())).not.toThrow()
    expect(() => validateAutomationDraft(validDraft({ report: { notify: true } }))).toThrow(/report\.notify/) // booleans are not modes
    for (const mode of ['all', 'failure', 'success', 'none']) {
      expect(() => validateAutomationDraft(validDraft({ report: { notify: mode } }))).not.toThrow()
    }
    expect(() => validateAutomationDraft({})).toThrow(/name/)
    expect(() => validateAutomationDraft(validDraft({ name: ' ' }))).toThrow(/name/)
    expect(() => validateAutomationDraft(validDraft({ target: { kind: 'team', workspaceName: 'default' } }))).toThrow(/target/)
    expect(() => validateAutomationDraft(validDraft({ params: { count: 3 } }))).toThrow(/params/)
    expect(() => validateAutomationDraft(validDraft({ id: 'caller-chosen' }))).toThrow(/cannot be changed/)
  })

  it('allows only mutable, valid fields on update', () => {
    expect(() => validateAutomationPatch({ name: 'x' })).not.toThrow() // no schedule on the patch
    expect(() => validateAutomationPatch({ schedule: { hour: 9, minute: 0, tz: 'Beijing' } })).toThrow(/time zone/)
    expect(() => validateAutomationPatch({ report: { notify: 'failure' } })).not.toThrow()
    expect(() => validateAutomationPatch({ report: { notify: 'sometimes' } })).toThrow(/report\.notify/)
    expect(() => validateAutomationPatch({ createdAt: 123 })).toThrow(/cannot be changed/)
    expect(() => validateAutomationPatch({ chatId: 'other' })).toThrow(/cannot be changed/)
    expect(() => validateAutomationPatch(null)).toThrow(/patch must be an object/)
  })
})

describe('validateAutomationChatPatch', () => {
  it('accepts draft fields and explicit clears', () => {
    expect(() => validateAutomationChatPatch({ name: 'News', notify: 'failure' })).not.toThrow()
    expect(() => validateAutomationChatPatch({ schedule: null, brief: null })).not.toThrow()
    expect(() => validateAutomationChatPatch({ target: { kind: 'team', workspaceName: 'default', teamName: 'news' } })).not.toThrow()
  })

  it('rejects persisted/internal fields and malformed values', () => {
    expect(() => validateAutomationChatPatch({ id: 'x' })).toThrow(/cannot be changed/)
    expect(() => validateAutomationChatPatch({ notify: 'sometimes' })).toThrow(/notify/)
    expect(() => validateAutomationChatPatch({ params: { count: 3 } })).toThrow(/params/)
  })
})
