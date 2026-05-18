import React, { useEffect, useRef, useState } from 'react'
import { C } from '../theme'

interface VoiceCfg {
  enabled?: boolean
  language?: string
  apiUrl?: string
  apiKey?: string
  apiModel?: string
}

type State = 'idle' | 'recording' | 'transcribing'

export const VoiceRecorder: React.FC = () => {
  const [state, setState] = useState<State>('idle')
  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const streamRef = useRef<MediaStream | null>(null)
  const stateRef = useRef<State>('idle')
  stateRef.current = state

  useEffect(() => {
    const off = window.codey.voice.onHotkey(() => {
      if (stateRef.current === 'idle') void startRecording()
      else if (stateRef.current === 'recording') stopRecording()
      // ignore taps while transcribing
    })
    return off
  }, [])

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
      setState('recording')
    } catch (err: any) {
      await window.codey.voice.showError(err?.message ?? 'Microphone unavailable')
      setState('idle')
    }
  }

  function stopRecording() {
    try { recorderRef.current?.stop() } catch { /* already stopped */ }
  }

  async function handleStop(mime: string) {
    setState('transcribing')
    streamRef.current?.getTracks().forEach(t => t.stop())
    streamRef.current = null
    const blob = new Blob(chunksRef.current, { type: mime })
    chunksRef.current = []

    try {
      const cfgRes = await window.codey.config.get()
      const voice: VoiceCfg = (cfgRes.ok ? (cfgRes.data?.voice ?? {}) : {})

      if (!voice.apiKey) {
        await window.codey.voice.showError('Add an API key in Settings → Whisper.')
        setState('idle')
        return
      }

      const base = (voice.apiUrl || 'https://api.openai.com/v1').replace(/\/+$/, '')
      const fd = new FormData()
      fd.append('file', blob, 'audio.webm')
      fd.append('model', voice.apiModel || 'whisper-1')
      if (voice.language && voice.language !== 'auto') fd.append('language', voice.language)

      const resp = await fetch(`${base}/audio/transcriptions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${voice.apiKey}` },
        body: fd,
      })
      if (!resp.ok) {
        const errText = await resp.text().catch(() => '')
        throw new Error(`API ${resp.status}: ${errText.slice(0, 200)}`)
      }
      const data = await resp.json()
      const text = (data?.text ?? '').trim()
      if (text) await window.codey.voice.notifyTranscribed(text)
      else await window.codey.voice.showError('No speech detected.')
    } catch (err: any) {
      await window.codey.voice.showError(err?.message ?? String(err))
    } finally {
      setState('idle')
    }
  }

  if (state === 'idle') return null
  return (
    <div style={{
      position: 'fixed', bottom: 18, right: 18, zIndex: 9999,
      display: 'flex', alignItems: 'center', gap: 8,
      background: C.surface, border: `1px solid ${C.border2}`,
      padding: '8px 12px', borderRadius: 8, fontSize: 12,
      boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
    }}>
      <span style={{
        width: 8, height: 8, borderRadius: '50%',
        background: state === 'recording' ? C.red : C.accent,
        animation: 'codey-pulse 1.2s ease-in-out infinite',
      }}/>
      <span style={{ color: C.fg }}>
        {state === 'recording' ? 'Recording — press hotkey to stop' : 'Transcribing…'}
      </span>
    </div>
  )
}
