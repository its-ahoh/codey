import React, { useEffect, useRef, useState } from 'react'
import { C } from '../theme'
import {
  VOICE_RESULT_EVENT,
  VOICE_LEVEL_EVENT,
  VOICE_STATE_EVENT,
  VOICE_TOGGLE_EVENT,
  type VoiceInputState,
  type VoiceResultDetail,
  type VoiceLevelDetail,
  type VoiceStateDetail,
  type VoiceToggleDetail,
} from './voiceInputEvents'

interface VoiceCfg {
  enabled?: boolean
  language?: string
  apiUrl?: string
  apiKeyRef?: string
  apiModel?: string
}

export const VoiceRecorder: React.FC = () => {
  const [state, setState] = useState<VoiceInputState>('idle')
  const [globalLevels, setGlobalLevels] = useState<number[]>(() => Array(11).fill(0.08))
  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const streamRef = useRef<MediaStream | null>(null)
  const stateRef = useRef<VoiceInputState>('idle')
  const targetRef = useRef<string | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const levelFrameRef = useRef<number | null>(null)
  stateRef.current = state

  function updateState(next: VoiceInputState) {
    stateRef.current = next
    setState(next)
    window.dispatchEvent(new CustomEvent<VoiceStateDetail>(VOICE_STATE_EVENT, {
      detail: { state: next, targetId: targetRef.current },
    }))
  }

  function toggleRecording(targetId: string | null) {
    if (stateRef.current === 'idle') {
      targetRef.current = targetId
      void startRecording()
    } else if (stateRef.current === 'recording' && targetRef.current === targetId) {
      stopRecording()
    }
    // Ignore unrelated targets and taps while transcribing.
  }

  useEffect(() => {
    const off = window.codey.voice.onHotkey(() => toggleRecording(null))
    const onToggle = (event: Event) => {
      const { targetId } = (event as CustomEvent<VoiceToggleDetail>).detail
      toggleRecording(targetId)
    }
    window.addEventListener(VOICE_TOGGLE_EVENT, onToggle)
    return () => {
      off()
      window.removeEventListener(VOICE_TOGGLE_EVENT, onToggle)
      stopLevelMeter()
    }
  }, [])

  function startLevelMeter(stream: MediaStream) {
    stopLevelMeter()
    const targetId = targetRef.current

    const audioContext = new AudioContext()
    const analyser = audioContext.createAnalyser()
    analyser.fftSize = 512
    analyser.smoothingTimeConstant = 0.72
    audioContext.createMediaStreamSource(stream).connect(analyser)
    audioContextRef.current = audioContext
    void audioContext.resume()

    const bins = new Uint8Array(analyser.frequencyBinCount)
    // Log-ish bands covering the frequencies where speech carries most energy.
    const ranges = [[1, 2], [2, 3], [3, 4], [4, 6], [6, 8], [8, 11], [11, 15], [15, 20], [20, 27], [27, 35], [35, 45]]
    let lastSent = 0
    const sample = (time: number) => {
      if (time - lastSent >= 45) {
        analyser.getByteFrequencyData(bins)
        const levels = ranges.map(([start, end]) => {
          let total = 0
          for (let index = start; index < end; index++) total += bins[index]
          const average = total / (end - start)
          return Math.max(0.08, Math.min(1, (average - 8) / 92))
        })
        if (targetId) {
          window.dispatchEvent(new CustomEvent<VoiceLevelDetail>(VOICE_LEVEL_EVENT, {
            detail: { levels, targetId },
          }))
        } else {
          setGlobalLevels(levels)
        }
        lastSent = time
      }
      levelFrameRef.current = requestAnimationFrame(sample)
    }
    levelFrameRef.current = requestAnimationFrame(sample)
  }

  function stopLevelMeter() {
    if (levelFrameRef.current != null) cancelAnimationFrame(levelFrameRef.current)
    levelFrameRef.current = null
    const audioContext = audioContextRef.current
    audioContextRef.current = null
    if (audioContext) void audioContext.close().catch(() => {})
  }

  async function startRecording() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = stream
      const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : 'audio/webm'
      const rec = new MediaRecorder(stream, { mimeType: mime })
      chunksRef.current = []
      rec.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data) }
      rec.onstop = () => { void handleStop(mime) }
      rec.start()
      recorderRef.current = rec
      updateState('recording')
      try { startLevelMeter(stream) } catch { stopLevelMeter() }
    } catch (err: any) {
      stopLevelMeter()
      await window.codey.voice.showError(err?.message ?? 'Microphone unavailable')
      updateState('idle')
      targetRef.current = null
    }
  }

  function stopRecording() {
    try { recorderRef.current?.stop() } catch { /* already stopped */ }
  }

  async function handleStop(mime: string) {
    stopLevelMeter()
    updateState('transcribing')
    streamRef.current?.getTracks().forEach(t => t.stop())
    streamRef.current = null
    const blob = new Blob(chunksRef.current, { type: mime })
    chunksRef.current = []

    try {
      const cfgRes = await window.codey.config.get()
      const voice: VoiceCfg = (cfgRes.ok ? (cfgRes.data?.voice ?? {}) : {})
      const keysRes = await window.codey.apiKeys.list()
      const savedKey = keysRes.ok && voice.apiKeyRef
        ? keysRes.data.find(key => key.name === voice.apiKeyRef)
        : undefined
      const apiKey = savedKey?.apiKey

      if (!apiKey) {
        await window.codey.voice.showError('Add and select a Voice key in Settings → API Keys.')
        updateState('idle')
        targetRef.current = null
        return
      }

      const base = (savedKey?.openaiBaseUrl || voice.apiUrl || 'https://api.openai.com/v1').replace(/\/+$/, '')
      const fd = new FormData()
      fd.append('file', blob, 'audio.webm')
      fd.append('model', voice.apiModel || 'gpt-4o-mini-transcribe')
      if (voice.language && voice.language !== 'auto') fd.append('language', voice.language)

      const resp = await fetch(`${base}/audio/transcriptions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}` },
        body: fd,
      })
      if (!resp.ok) {
        const errText = await resp.text().catch(() => '')
        throw new Error(`API ${resp.status}: ${errText.slice(0, 200)}`)
      }
      const data = await resp.json()
      const text = (data?.text ?? '').trim()
      if (text) {
        const targetId = targetRef.current
        if (targetId) {
          window.dispatchEvent(new CustomEvent<VoiceResultDetail>(VOICE_RESULT_EVENT, {
            detail: { text, targetId },
          }))
        } else {
          await window.codey.voice.notifyTranscribed(text)
        }
      } else await window.codey.voice.showError('No speech detected.')
    } catch (err: any) {
      await window.codey.voice.showError(err?.message ?? String(err))
    } finally {
      updateState('idle')
      targetRef.current = null
    }
  }

  // Composer-triggered dictation renders inside that composer. The floating
  // capsule is reserved for system-wide hotkey recording.
  if (state === 'idle' || targetRef.current !== null) return null
  return (
    <div style={styles.capsule} role="status" aria-label={state === 'recording' ? 'Recording' : 'Transcribing'}>
      {state === 'recording' ? (
        <div style={styles.waveform} title="Recording">
          {globalLevels.map((level, index) => (
            <span key={index} style={{ ...styles.waveBar, height: 3 + Math.round(level * 11) }} />
          ))}
        </div>
      ) : (
        <>
          <span style={styles.transcribingDot} />
          <span style={{ color: C.fg }}>Transcribing</span>
        </>
      )}
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  capsule: {
    position: 'fixed', bottom: 18, right: 18, zIndex: 9999,
    minHeight: 40, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
    background: C.surface, border: `1px solid ${C.border2}`,
    padding: '7px 12px', borderRadius: 999, fontSize: 12,
    boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
  },
  waveform: {
    height: 24, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 2,
  },
  waveBar: {
    width: 2, minHeight: 3, maxHeight: 14, borderRadius: 2,
    background: C.red, transition: 'height 45ms linear',
  },
  transcribingDot: {
    width: 7, height: 7, borderRadius: '50%', background: C.accent,
    animation: 'codey-pulse 1.2s ease-in-out infinite',
  },
}
