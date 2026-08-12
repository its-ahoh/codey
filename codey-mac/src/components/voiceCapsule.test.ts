import { describe, it, expect } from 'vitest'
import { capsulePhase, capsuleVisible, spokenTurnSettled } from './voiceCapsule'

describe('capsulePhase', () => {
  it('lets live capture and playback speak for themselves', () => {
    expect(capsulePhase('recording', 'off')).toBe('recording')
    expect(capsulePhase('transcribing', 'working')).toBe('transcribing')
    expect(capsulePhase('speaking', 'replying')).toBe('speaking')
  })

  it('gets out of the way once the acknowledgement has been spoken', () => {
    // The agent run is a background wait — nothing to watch, so nothing on
    // the desktop. The capsule comes back when there is something to hear.
    expect(capsulePhase('idle', 'working')).toBe('idle')
  })

  it('still shows while the acknowledgement itself is being prepared or played', () => {
    expect(capsulePhase('transcribing', 'working')).toBe('transcribing')
    expect(capsulePhase('speaking', 'working')).toBe('speaking')
  })

  it('reads a dispatched-but-not-yet-started reply as Speaking', () => {
    // Not 'transcribing': flipping back to Thinking for the IPC round trip
    // before the first audio event is a visible stutter.
    expect(capsulePhase('idle', 'replying')).toBe('speaking')
  })

  it('hides once the turn is over', () => {
    expect(capsulePhase('idle', 'off')).toBe('idle')
  })
})

describe('capsuleVisible', () => {
  it('shows for a hotkey conversation', () => {
    expect(capsuleVisible({ phase: 'recording', mode: 'converse', fromHotkey: true })).toBe(true)
  })

  it('stays out of the way for composer clicks and dictation', () => {
    expect(capsuleVisible({ phase: 'recording', mode: 'converse', fromHotkey: false })).toBe(false)
    expect(capsuleVisible({ phase: 'recording', mode: 'dictate', fromHotkey: true })).toBe(false)
  })

  it('is hidden when there is no phase to report', () => {
    expect(capsuleVisible({ phase: 'idle', mode: 'converse', fromHotkey: true })).toBe(false)
  })
})

describe('spokenTurnSettled', () => {
  it('keeps the turn open while the agent is still working', () => {
    expect(spokenTurnSettled({ turn: 'working', voiceState: 'idle', agentInFlight: true })).toBe(false)
  })

  it('keeps the turn open while the acknowledgement is playing', () => {
    expect(spokenTurnSettled({ turn: 'working', voiceState: 'speaking', agentInFlight: true })).toBe(false)
  })

  it('settles once the agent is done and nothing is playing', () => {
    expect(spokenTurnSettled({ turn: 'working', voiceState: 'idle', agentInFlight: false })).toBe(true)
  })

  it('settles a reply only after its playback stops', () => {
    expect(spokenTurnSettled({ turn: 'replying', voiceState: 'speaking', agentInFlight: false })).toBe(false)
    expect(spokenTurnSettled({ turn: 'replying', voiceState: 'idle', agentInFlight: false })).toBe(true)
  })

  it('has nothing to settle when no turn is running', () => {
    expect(spokenTurnSettled({ turn: 'off', voiceState: 'idle', agentInFlight: false })).toBe(false)
  })
})
