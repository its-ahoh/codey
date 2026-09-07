import { describe, it, expect } from 'vitest'
import { hudStateCommand, hudLevelCommand, conversationToggleCommand, hudVocabularyCommand } from './voice-hud'

describe('conversationToggleCommand', () => {
  it('tells the helper which turns own a capsule', () => {
    expect(conversationToggleCommand(true)).toBe('conversation-toggle hotkey')
    expect(conversationToggleCommand(false)).toBe('conversation-toggle button')
  })
})

describe('hudStateCommand', () => {
  it('maps the three live phases onto helper commands', () => {
    expect(hudStateCommand('recording')).toBe('hud-state listening')
    expect(hudStateCommand('transcribing')).toBe('hud-state thinking')
    expect(hudStateCommand('speaking')).toBe('hud-state speaking')
  })

  it('treats every non-live value as a request to hide', () => {
    expect(hudStateCommand('idle')).toBe('hud-state idle')
    expect(hudStateCommand('hidden')).toBe('hud-state idle')
    expect(hudStateCommand('')).toBe('hud-state idle')
    expect(hudStateCommand('nonsense')).toBe('hud-state idle')
  })
})

describe('hudLevelCommand', () => {
  it('emits a fixed-precision level', () => {
    expect(hudLevelCommand(0.5)).toBe('hud-level 0.500')
    expect(hudLevelCommand(0)).toBe('hud-level 0.000')
  })

  it('clamps out-of-range readings instead of forwarding them', () => {
    expect(hudLevelCommand(1.8)).toBe('hud-level 1.000')
    expect(hudLevelCommand(-0.3)).toBe('hud-level 0.000')
  })

  it('refuses a level that is not a finite number', () => {
    // Swift parses this line with Float(); a "NaN" argument would parse to a
    // NaN and poison the meter's sliding window.
    expect(hudLevelCommand(NaN)).toBeNull()
    expect(hudLevelCommand(Infinity)).toBeNull()
  })
})

describe('hudVocabularyCommand', () => {
  it('carries the learned word as one line', () => {
    expect(hudVocabularyCommand('Codey')).toBe('hud-vocabulary Codey')
  })

  it('flattens whitespace so the term stays a single stdin line', () => {
    expect(hudVocabularyCommand(' zhuan\nxie qi ')).toBe('hud-vocabulary zhuan xie qi')
  })

  it('caps the length rather than pushing a paragraph at the pill', () => {
    const long = 'a'.repeat(120)
    expect(hudVocabularyCommand(long)).toBe(`hud-vocabulary ${'a'.repeat(40)}`)
  })

  it('sends nothing when there is no readable word left', () => {
    expect(hudVocabularyCommand('   ')).toBeNull()
    expect(hudVocabularyCommand('')).toBeNull()
  })
})
