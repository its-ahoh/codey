export type VoiceInputState = 'idle' | 'recording' | 'transcribing'

export const VOICE_TOGGLE_EVENT = 'codey:voice-toggle'
export const VOICE_STATE_EVENT = 'codey:voice-state'
export const VOICE_RESULT_EVENT = 'codey:voice-result'
export const VOICE_LEVEL_EVENT = 'codey:voice-level'

export interface VoiceToggleDetail {
  targetId: string
}

export interface VoiceStateDetail {
  state: VoiceInputState
  targetId: string | null
}

export interface VoiceResultDetail {
  text: string
  targetId: string
}

export interface VoiceLevelDetail {
  levels: number[]
  targetId: string
}

export function toggleVoiceInput(targetId: string) {
  window.dispatchEvent(new CustomEvent<VoiceToggleDetail>(VOICE_TOGGLE_EVENT, {
    detail: { targetId },
  }))
}
