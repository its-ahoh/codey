import { describe, it, expect } from 'vitest'
import { defaultThinkingExpanded } from './thinkingState'

describe('defaultThinkingExpanded', () => {
  it('expands while thinking and no answer yet', () => {
    expect(defaultThinkingExpanded({ hasAnswer: false, isComplete: false })).toBe(true)
  })
  it('collapses once answer text has started', () => {
    expect(defaultThinkingExpanded({ hasAnswer: true, isComplete: false })).toBe(false)
  })
  it('collapses when the message is complete', () => {
    expect(defaultThinkingExpanded({ hasAnswer: true, isComplete: true })).toBe(false)
  })
  it('collapses a completed message even if answer was empty', () => {
    expect(defaultThinkingExpanded({ hasAnswer: false, isComplete: true })).toBe(false)
  })
})
