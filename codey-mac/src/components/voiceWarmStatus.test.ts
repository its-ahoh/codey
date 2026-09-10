import { describe, it, expect } from 'vitest'
import { formatWarmElapsed, warmBlocksPress, warmTooltip, warmShortLabel } from './voiceWarmStatus'

describe('formatWarmElapsed', () => {
  it('stays in seconds under a minute', () => {
    expect(formatWarmElapsed(0)).toBe('0s')
    expect(formatWarmElapsed(45)).toBe('45s')
    expect(formatWarmElapsed(59.9)).toBe('59s')
  })

  it('switches to minutes at the boundary', () => {
    expect(formatWarmElapsed(60)).toBe('1m')
    expect(formatWarmElapsed(90)).toBe('1m 30s')
    expect(formatWarmElapsed(320)).toBe('5m 20s')
  })

  it('drops the seconds part when it is zero', () => {
    expect(formatWarmElapsed(120)).toBe('2m')
  })

  it('never shows a negative time from a clock skew', () => {
    expect(formatWarmElapsed(-5)).toBe('0s')
  })
})

describe('warmTooltip', () => {
  it('says it is busy, how long so far, and how long it usually takes', () => {
    const text = warmTooltip(90)
    expect(text).toContain('Preparing')
    expect(text).toContain('1m 30s')
    // Without the typical duration a multi-minute wait reads as a hang.
    expect(text).toContain('about 5 minutes')
  })

  it('works at zero, which is what the first render shows', () => {
    expect(warmTooltip(0)).toContain('0s so far')
  })
})

describe('warmBlocksPress', () => {
  it('blocks for WhisperKit, whose cold compile runs for minutes', () => {
    expect(warmBlocksPress('openai_whisper-large-v3-v20240930_turbo')).toBe(true)
    // An unknown/empty name is treated as WhisperKit: refusing is the safe
    // side of the guess, since recording into a missing pipeline strands the
    // user after they have spoken.
    expect(warmBlocksPress('')).toBe(true)
  })

  it('does not block for the streaming models', () => {
    expect(warmBlocksPress('nemotron/multilingual/480ms')).toBe(false)
    expect(warmBlocksPress('nemotron/latin/960ms')).toBe(false)
  })
})

describe('warmShortLabel', () => {
  it('names the state and the elapsed time', () => {
    expect(warmShortLabel(75)).toBe('Preparing model… 1m 15s')
  })
})
