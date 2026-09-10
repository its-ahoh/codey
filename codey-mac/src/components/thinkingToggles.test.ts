import { describe, it, expect, beforeEach } from 'vitest'
import {
  getThinkingToggles,
  rememberThinkingToggle,
  __resetThinkingToggles,
} from './thinkingToggles'

describe('thinking toggles', () => {
  beforeEach(() => { __resetThinkingToggles() })

  it('has no overrides initially', () => {
    expect(getThinkingToggles()).toEqual({})
  })

  it('remembers an explicit collapse across a chat switch and back', () => {
    rememberThinkingToggle('asst-1', false)
    // The override is keyed by message id, not chat, so it must still be there
    // after the remount that a chat switch causes.
    expect(getThinkingToggles()).toEqual({ 'asst-1': false })
  })

  it('keeps the latest toggle per message', () => {
    rememberThinkingToggle('asst-1', false)
    rememberThinkingToggle('asst-1', true)
    expect(getThinkingToggles()).toEqual({ 'asst-1': true })
  })

  it('tracks different messages independently', () => {
    rememberThinkingToggle('asst-1', false)
    rememberThinkingToggle('asst-2', true)
    expect(getThinkingToggles()).toEqual({ 'asst-1': false, 'asst-2': true })
  })
})
