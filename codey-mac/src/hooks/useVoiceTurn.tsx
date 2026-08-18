import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { useChatVoice, type ChatVoiceMode } from '../components/useChatVoice'
import { capsulePhase, capsuleVisible, spokenTurnSettled, type SpokenTurnPhase } from '../components/voiceCapsule'
import { useChats } from './useChats'

/**
 * Owns a spoken turn for as long as it runs — which is longer than any one
 * chat view lives.
 *
 * `ChatTab` is keyed by chat id (App.tsx), so switching chats unmounts it. With
 * capture, playback and the turn's own state living in the tab, switching away
 * mid-turn killed the reply outright: the effect that speaks the answer was
 * gone before the agent finished. Mounted above the keyed subtree, the turn
 * outlives the view the way the agent run does.
 *
 * The tab still owns the composer — a transcript has to land in a text box
 * somewhere — and hands the turn over here once it has been sent.
 */

type TranscriptHandler = (text: string, mode: ChatVoiceMode) => void

type VoiceApi = ReturnType<typeof useChatVoice>

export interface VoiceTurnValue extends VoiceApi {
  /** Chat that owns the current capture / spoken reply. */
  ownerChatId: string | null
  /**
   * Where finished transcripts go. The mounted chat registers its composer;
   * a transcript that arrives with nothing registered is dropped rather than
   * sent somewhere the user isn't looking.
   */
  setTranscriptHandler: (handler: TranscriptHandler | null) => void
  /**
   * Hands a just-sent spoken message over: acknowledge it now, read the reply
   * back when it arrives.
   */
  beginSpokenTurn: (chatId: string, spoken: string) => void
  /**
   * What Esc does: drop the capture (or stop the reply) and close the turn.
   * `cancel` alone leaves the turn state armed, so UI affordances use this.
   */
  abandon: () => void
}

const VoiceTurnContext = createContext<VoiceTurnValue | null>(null)

export const VoiceTurnProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { state } = useChats()

  const transcriptHandlerRef = useRef<TranscriptHandler | null>(null)
  const voice = useChatVoice({
    onTranscript: (text, mode) => transcriptHandlerRef.current?.(text, mode),
    onError: msg => void window.codey.voice.showError(msg),
  })

  // Which chat the running turn belongs to, and how far along it is. Held
  // together because a phase without its chat can't find the reply to read.
  const [turn, setTurn] = useState<{ chatId: string | null; phase: SpokenTurnPhase }>({ chatId: null, phase: 'off' })
  const [ownerChatId, setOwnerChatId] = useState<string | null>(null)
  const ownerChatIdRef = useRef<string | null>(null)
  const spokenTurnRef = useRef(false)
  const prevFlightRef = useRef<unknown>(null)
  const ackGenerationRef = useRef(0)

  const flight = turn.chatId ? state.inFlight[turn.chatId] : undefined

  const setTranscriptHandler = useCallback((handler: TranscriptHandler | null) => {
    transcriptHandlerRef.current = handler
  }, [])

  const beginSpokenTurn = useCallback((chatId: string, spoken: string) => {
    spokenTurnRef.current = true
    ownerChatIdRef.current = chatId
    setOwnerChatId(chatId)
    setTurn({ chatId, phase: 'working' })
    // Acknowledge immediately. An agent turn routinely runs for 30s to
    // several minutes, and unbroken silence in a voice interface reads as
    // "it died" rather than "it's working". Routed through the gateway like
    // the reply so both use the same voice; verbatim because a one-line ack
    // has nothing to digest, and no conversationId so it can't displace the
    // cached reply behind "more detail".
    const ackGeneration = ++ackGenerationRef.current
    void window.codey.voice.ack(spoken).then(result => {
      // A very fast agent reply can beat acknowledgement generation. Never
      // let a late ack interrupt the actual answer or leak into a newer turn.
      if (ackGeneration !== ackGenerationRef.current || !spokenTurnRef.current) return
      const fallback = /[\u4e00-\u9fff]/.test(spoken) ? '我去处理' : 'Working on it.' // lint-allow-non-english
      void voice.speak(result.ok ? result.data.text : fallback, undefined, true)
    })
  }, [voice.speak]) // eslint-disable-line react-hooks/exhaustive-deps

  // Read the reply aloud once the turn settles. Keyed off the in-flight
  // marker clearing rather than off message content, so partial streamed
  // text is never spoken mid-generation.
  useEffect(() => {
    const wasInFlight = prevFlightRef.current
    prevFlightRef.current = flight
    if (!wasInFlight || flight) return
    if (!spokenTurnRef.current) return
    spokenTurnRef.current = false
    ackGenerationRef.current += 1
    const chatId = turn.chatId
    const messages = (chatId ? state.chats[chatId]?.messages : undefined) ?? []
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i]
      if (message.role === 'assistant' && message.content?.trim()) {
        ownerChatIdRef.current = chatId
        setOwnerChatId(chatId)
        setTurn({ chatId, phase: 'replying' })
        void voice.speak(message.content, chatId ?? undefined)
        return
      }
    }
    setTurn({ chatId: null, phase: 'off' })
  }, [flight]) // eslint-disable-line react-hooks/exhaustive-deps

  // Close out the turn once the reply has actually finished playing. Deferred
  // rather than keyed straight off `voice.state === 'idle'`, because the state
  // is idle for the moment between dispatching a speak and its first event —
  // hiding there would blink the capsule off right as the reply starts. The
  // same delay is the safety net for a speak that never starts at all.
  useEffect(() => {
    if (!spokenTurnSettled({ turn: turn.phase, voiceState: voice.state, agentInFlight: !!flight })) return
    const timer = setTimeout(() => {
      setTurn({ chatId: null, phase: 'off' })
      ownerChatIdRef.current = null
      setOwnerChatId(null)
    }, 1500)
    return () => clearTimeout(timer)
  }, [turn.phase, voice.state, flight])

  // Drive the floating capsule. Only converse turns get one — dictation is a
  // brief, eyes-on-screen action, and its status shows inline in the composer
  // instead.
  //
  // The capsule is for the parts of a turn you can hear: listening, the
  // acknowledgement, the reply. The agent run in between is silent, so the
  // capsule steps off the desktop and comes back with the answer.
  const capsuleState = capsulePhase(voice.state, turn.phase)
  useEffect(() => {
    // Clicking the button means you're already looking at the window; the
    // floating capsule is for the hotkey, where you may not be.
    const showable = capsuleVisible({ phase: capsuleState, mode: voice.mode, fromHotkey: voice.fromHotkey })
    void window.codey.voice.setHudState(showable ? capsuleState : 'idle')
  }, [capsuleState, voice.mode, voice.fromHotkey])

  useEffect(() => {
    if (voice.fromHotkey && voice.mode === 'converse' && voice.state !== 'idle') {
      window.codey.voice.setHudLevel(voice.level)
    }
  }, [voice.level, voice.mode, voice.state, voice.fromHotkey])

  /**
   * Abandon the turn outright: stop whatever is playing and close the turn, so
   * a cancelled reply doesn't leave the capsule up for the settle delay or the
   * turn state armed for a reply that will never be spoken.
   */
  const abandonTurn = useCallback(() => {
    voice.cancel()
    // Clear the marker so the settle effect never reads back an abandoned reply.
    spokenTurnRef.current = false
    setTurn({ chatId: null, phase: 'off' })
    ownerChatIdRef.current = null
    setOwnerChatId(null)
  }, [voice.cancel])
  const abandonRef = useRef(abandonTurn)
  abandonRef.current = abandonTurn

  // Keep one IPC listener mounted for the lifetime of the app. The voice
  // callbacks change as recording state updates; using a ref avoids a brief
  // unsubscribe/re-subscribe gap exactly when the second hotkey press is meant
  // to stop and send the recording.
  const toggle = useCallback<VoiceApi['toggle']>((mode, opts) => {
    // Latch the destination at the moment capture starts. The selected chat
    // can change while recording, transcribing, or playing the reply, but the
    // voice UI must continue to belong to the chat where the turn began.
    if (voice.state === 'idle' || voice.state === 'speaking') {
      ownerChatIdRef.current = state.selectedChatId
      setOwnerChatId(state.selectedChatId)
    }
    voice.toggle(mode, opts)
  }, [voice.state, voice.toggle, state.selectedChatId])

  const toggleRef = useRef(toggle)
  toggleRef.current = toggle

  // Fn shortcuts can be handled entirely by the native helper, bypassing the
  // toggle above. Detect that idle → active edge and claim the selected chat
  // here too. A capture-only owner is cleared when capture settles; a spoken
  // turn keeps its owner until reply playback settles.
  const previousVoiceStateRef = useRef(voice.state)
  useEffect(() => {
    const previous = previousVoiceStateRef.current
    previousVoiceStateRef.current = voice.state
    if (previous === 'idle' && voice.state !== 'idle' && ownerChatIdRef.current === null) {
      ownerChatIdRef.current = state.selectedChatId
      setOwnerChatId(state.selectedChatId)
    } else if (previous !== 'idle' && voice.state === 'idle' && turn.phase === 'off') {
      ownerChatIdRef.current = null
      setOwnerChatId(null)
    }
  }, [voice.state, state.selectedChatId, turn.phase])
  useEffect(() => window.codey.voice.onConverseHotkey(() => {
    toggleRef.current('converse', { fromHotkey: true })
  }), [])
  useEffect(() => window.codey.voice.onCancelConverse(() => {
    abandonRef.current()
  }), [])

  // Esc abandons a voice turn: drop the recording rather than sending it, or
  // stop a reply mid-sentence. Captured so it doesn't also reach the composer.
  //
  // Only reaches us when the Codey window is focused, which in a hotkey turn
  // it usually isn't — the helper's global monitor covers that case and comes
  // back through onCancelConverse above.
  useEffect(() => {
    if (voice.state === 'idle' && turn.phase === 'off') return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      abandonTurn()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [voice.state, turn.phase, abandonTurn])

  const value: VoiceTurnValue = { ...voice, toggle, ownerChatId, setTranscriptHandler, beginSpokenTurn, abandon: abandonTurn }
  return <VoiceTurnContext.Provider value={value}>{children}</VoiceTurnContext.Provider>
}

export function useVoiceTurn(): VoiceTurnValue {
  const value = useContext(VoiceTurnContext)
  if (!value) throw new Error('useVoiceTurn must be used within a VoiceTurnProvider')
  return value
}
