import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Voice for a single chat: hold a button to talk, hear the reply read back.
 *
 * Deliberately scoped to the chat it's mounted in. The transcript is handed
 * to the caller so it goes out through the chat's own send path — keeping
 * that chat's context, history and working directory — and only the
 * reading-aloud goes through the gateway's speech pipeline.
 */

export type ChatVoiceState = 'idle' | 'recording' | 'transcribing' | 'speaking'

/**
 * `dictate` only turns speech into text for the composer. `converse` sends
 * the turn and reads the reply back — the hands-free mode.
 */
export type ChatVoiceMode = 'dictate' | 'converse'

interface SpeakEvent {
  type: 'start' | 'text' | 'audio' | 'done' | 'error' | 'ack' | 'command'
  tts?: 'server' | 'client'
  seq?: number
  text?: string
  dataBase64?: string
  ttsDegraded?: boolean
  message?: string
}

interface Options {
  /** Called with the finished transcript and the mode it was captured in. */
  onTranscript: (text: string, mode: ChatVoiceMode) => void
  onError?: (message: string) => void
}

export function useChatVoice({ onTranscript, onError }: Options) {
  const [state, setState] = useState<ChatVoiceState>('idle')
  /** Mode of the turn currently being captured or spoken. */
  const [mode, setMode] = useState<ChatVoiceMode>('converse')
  const modeRef = useRef<ChatVoiceMode>('converse')
  modeRef.current = mode

  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const streamRef = useRef<MediaStream | null>(null)
  const stateRef = useRef<ChatVoiceState>('idle')
  stateRef.current = state

  // Playback queue. Audio segments and system-voice text are interleaved in
  // arrival order, which the gateway guarantees is seq order.
  const audioElRef = useRef<HTMLAudioElement | null>(null)
  const queueRef = useRef<Array<{ kind: 'audio'; url: string } | { kind: 'speech'; text: string }>>([])
  const playingRef = useRef(false)
  const serverTtsRef = useRef(false)
  const pendingTextRef = useRef<Map<number, string>>(new Map())
  const streamDoneRef = useRef(false)

  const fail = useCallback((msg: string) => { onError?.(msg) }, [onError])

  // ── Playback ──────────────────────────────────────────────────────

  const drainQueue = useCallback(() => {
    if (playingRef.current) return
    const next = queueRef.current.shift()
    if (!next) {
      // Only leave .speaking once the stream is closed too: playback
      // routinely outruns synthesis of the next sentence mid-reply.
      if (streamDoneRef.current) setState('idle')
      return
    }
    playingRef.current = true

    if (next.kind === 'audio') {
      const el = new Audio(next.url)
      audioElRef.current = el
      const advance = () => {
        URL.revokeObjectURL(next.url)
        playingRef.current = false
        drainQueue()
      }
      el.onended = advance
      el.onerror = advance
      void el.play().catch(advance)
    } else {
      const utterance = new SpeechSynthesisUtterance(next.text)
      const advance = () => { playingRef.current = false; drainQueue() }
      utterance.onend = advance
      utterance.onerror = advance
      window.speechSynthesis.speak(utterance)
    }
  }, [])

  const stopPlayback = useCallback(() => {
    queueRef.current.forEach(item => { if (item.kind === 'audio') URL.revokeObjectURL(item.url) })
    queueRef.current = []
    playingRef.current = false
    if (audioElRef.current) {
      audioElRef.current.pause()
      audioElRef.current = null
    }
    window.speechSynthesis.cancel()
    void window.codey.voice.stopSpeaking()
  }, [])

  useEffect(() => {
    const off = window.codey.voice.onSpeakEvent((event: SpeakEvent) => {
      switch (event.type) {
        case 'start':
          serverTtsRef.current = event.tts === 'server'
          pendingTextRef.current.clear()
          streamDoneRef.current = false
          setState('speaking')
          break
        case 'text':
          // In server mode the audio for this seq is still coming; hold the
          // text back in case it never arrives.
          if (serverTtsRef.current) {
            if (event.seq != null && event.text) pendingTextRef.current.set(event.seq, event.text)
          } else if (event.text) {
            queueRef.current.push({ kind: 'speech', text: event.text })
            drainQueue()
          }
          break
        case 'audio': {
          if (event.seq != null) pendingTextRef.current.delete(event.seq)
          if (!event.dataBase64) break
          const bytes = Uint8Array.from(atob(event.dataBase64), c => c.charCodeAt(0))
          const url = URL.createObjectURL(new Blob([bytes], { type: 'audio/mpeg' }))
          queueRef.current.push({ kind: 'audio', url })
          drainQueue()
          break
        }
        case 'done': {
          // Anything that never got audio is read by the system voice, in
          // order, so no sentence is silently dropped.
          const leftovers = [...pendingTextRef.current.entries()].sort((a, b) => a[0] - b[0])
          leftovers.forEach(([, text]) => queueRef.current.push({ kind: 'speech', text }))
          pendingTextRef.current.clear()
          streamDoneRef.current = true
          drainQueue()
          break
        }
        case 'error':
          streamDoneRef.current = true
          fail(event.message ?? 'Speech failed')
          setState('idle')
          break
      }
    })
    return off
  }, [drainQueue, fail])

  const speak = useCallback(async (text: string, conversationId?: string) => {
    if (!text.trim()) return
    const res = await window.codey.voice.speak(text, conversationId)
    if (res && res.ok === false) fail(res.error ?? 'Speech failed')
  }, [fail])

  // ── Recording ─────────────────────────────────────────────────────

  const transcribe = useCallback(async (blob: Blob, mime: string) => {
    setState('transcribing')
    try {
      const cfgRes = await window.codey.config.get()
      const voice: any = cfgRes.ok ? (cfgRes.data?.voice ?? {}) : {}
      if (!voice.apiKey) {
        fail('Add a transcription API key in Settings → Voice.')
        setState('idle')
        return
      }
      const base = (voice.apiUrl || 'https://api.openai.com/v1').replace(/\/+$/, '')
      const fd = new FormData()
      fd.append('file', blob, mime.includes('webm') ? 'audio.webm' : 'audio.mp4')
      fd.append('model', voice.apiModel || 'gpt-4o-mini-transcribe')
      if (voice.language && voice.language !== 'auto') fd.append('language', voice.language)

      const resp = await fetch(`${base}/audio/transcriptions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${voice.apiKey}` },
        body: fd,
      })
      if (!resp.ok) throw new Error(`Transcription failed (${resp.status})`)
      const text = ((await resp.json())?.text ?? '').trim()
      setState('idle')
      if (text) onTranscript(text, modeRef.current)
      else fail('No speech detected.')
    } catch (err: any) {
      fail(err?.message ?? String(err))
      setState('idle')
    }
  }, [fail, onTranscript])

  const startRecording = useCallback(async () => {
    // Talking over a reply means barge-in: stop it and listen.
    stopPlayback()
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = stream
      const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : 'audio/webm'
      const rec = new MediaRecorder(stream, { mimeType: mime })
      chunksRef.current = []
      rec.ondataavailable = e => { if (e.data.size > 0) chunksRef.current.push(e.data) }
      rec.onstop = () => {
        streamRef.current?.getTracks().forEach(t => t.stop())
        streamRef.current = null
        const blob = new Blob(chunksRef.current, { type: mime })
        chunksRef.current = []
        void transcribe(blob, mime)
      }
      rec.start()
      recorderRef.current = rec
      setState('recording')
    } catch (err: any) {
      fail(err?.message ?? 'Microphone unavailable')
      setState('idle')
    }
  }, [fail, stopPlayback, transcribe])

  const stopRecording = useCallback(() => {
    try { recorderRef.current?.stop() } catch { /* already stopped */ }
  }, [])

  /**
   * One gesture per button: start, stop, or interrupt depending on state.
   * Pressing the other button mid-recording switches what that recording
   * will do with its transcript, which is friendlier than refusing.
   */
  const toggle = useCallback((next: ChatVoiceMode) => {
    setMode(next)
    modeRef.current = next
    switch (stateRef.current) {
      case 'idle': void startRecording(); break
      case 'recording': stopRecording(); break
      case 'speaking': stopPlayback(); void startRecording(); break
      case 'transcribing': break // in flight; a second tap would duplicate it
    }
  }, [startRecording, stopRecording, stopPlayback])

  useEffect(() => () => { stopPlayback(); stopRecording() }, [stopPlayback, stopRecording])

  return { state, mode, toggle, speak, stopPlayback }
}
