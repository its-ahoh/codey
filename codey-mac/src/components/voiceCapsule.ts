// What phase the floating capsule should be showing for a spoken turn.
//
// Kept apart from the component because the interesting part is not the IPC —
// it is that a voice turn outlives the capture/playback machine, so the two
// have to be combined rather than either one taken on its own.

import type { ChatVoiceState } from './useChatVoice'

/**
 * How far along the spoken turn is, independent of whether audio happens to be
 * moving right now. 'working' spans the agent run; 'replying' covers the answer
 * being read back, including the gap before its first audio event.
 */
export type SpokenTurnPhase = 'off' | 'working' | 'replying'

/**
 * Playback wins when there is any — it is the more specific truth.
 *
 * With nothing playing, the turn phase decides. 'working' deliberately reads as
 * hidden: once the acknowledgement has been spoken the agent run is a
 * background wait, and a capsule parked on the desktop for minutes is clutter
 * rather than reassurance. 'replying' reads as Speaking so the capsule is back
 * the moment the answer is queued, not only when its first audio lands — that
 * gap is a gateway round trip, long enough to look like a stutter.
 */
export function capsulePhase(voiceState: ChatVoiceState, turn: SpokenTurnPhase): ChatVoiceState {
  if (voiceState !== 'idle') return voiceState
  if (turn === 'replying') return 'speaking'
  return 'idle'
}

/**
 * Only hotkey-started conversations get a capsule: clicking the composer
 * button means you are already looking at the window, and dictation reports
 * inline instead.
 */
export function capsuleVisible(opts: {
  phase: ChatVoiceState
  mode: 'dictate' | 'converse'
  fromHotkey: boolean
}): boolean {
  return opts.fromHotkey && opts.mode === 'converse' && opts.phase !== 'idle'
}

/**
 * Whether the turn is finished enough to start tearing the capsule down. The
 * caller defers the actual hide, so a 'replying' turn whose speak has been
 * dispatched but not yet started doesn't blink off.
 */
export function spokenTurnSettled(opts: {
  turn: SpokenTurnPhase
  voiceState: ChatVoiceState
  agentInFlight: boolean
}): boolean {
  if (opts.turn === 'off') return false
  if (opts.turn === 'working' && opts.agentInFlight) return false
  return opts.voiceState === 'idle'
}
