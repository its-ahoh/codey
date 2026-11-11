import React, { useEffect, useRef, useState } from 'react'
import type { ComputerDesktop, ComputerControlState } from '../../electron/computer-control'
import { C } from '../theme'

export const ComputerDesktopPanel: React.FC = () => {
  const [state, setState] = useState<ComputerControlState>()
  useEffect(() => {
    let alive = true
    void window.codey.computer.status().then(result => { if (alive && result.ok) setState(result.data) })
    const off = window.codey.computer.onChanged(setState)
    return () => { alive = false; off() }
  }, [])
  if (!state?.desktop) return null
  return <DesktopSurface key={`${state.desktop.sessionId}:${state.desktop.window}`} desktop={state.desktop} agent={state.active?.agent ?? 'Agent'} />
}

/**
 * Watch-only view of the window an agent is working in, which may sit on
 * another desktop. The video takes no input: clicking it jumps to the real
 * window, and the user works there after pausing the agent.
 */
export const DesktopSurface: React.FC<{ desktop: ComputerDesktop; agent: string }> = ({ desktop, agent }) => {
  const video = useRef<HTMLVideoElement>(null)
  const media = useRef<MediaStream>()
  const streamId = useRef('')
  const generation = useRef(0)
  const mounted = useRef(true)
  const [live, setLive] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [wide, setWide] = useState(false)
  const paused = desktop.controller === 'human' && !desktop.transitioning
  const button: React.CSSProperties = { padding: '7px 10px', border: `1px solid ${C.border}`, borderRadius: 7, background: C.surface2, color: C.fg, cursor: 'pointer' }
  const stopVideo = () => {
    generation.current++
    media.current?.getTracks().forEach(track => track.stop())
    media.current = undefined
    if (video.current) video.current.srcObject = null
    if (streamId.current) void window.codey.computer.streamStopped(streamId.current)
    streamId.current = ''
    if (mounted.current) setLive(false)
  }
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; stopVideo() }
  }, [])

  const startVideo = async () => {
    setBusy(true); setError('')
    const attempt = ++generation.current
    let grant = ''
    try {
      const result = await window.codey.computer.armStream(desktop.sessionId, desktop.window)
      if (!result.ok) throw new Error(result.error)
      grant = result.data
      if (!mounted.current || attempt !== generation.current) { await window.codey.computer.streamStopped(grant); return }
      const stream = await navigator.mediaDevices.getDisplayMedia({ audio: false, video: { frameRate: { ideal: 30, max: 30 } } })
      if (!mounted.current || attempt !== generation.current) {
        stream.getTracks().forEach(track => track.stop()); await window.codey.computer.streamStopped(grant); return
      }
      streamId.current = grant
      media.current = stream
      const element = video.current!
      element.srcObject = stream
      stream.getVideoTracks()[0].addEventListener('ended', () => {
        if (media.current === stream) { stopVideo(); if (mounted.current) setError('Live view ended. Start it again to continue.') }
      })
      await element.play()
      setLive(true)
    } catch (e) {
      if (grant) await window.codey.computer.streamStopped(grant)
      stopVideo()
      if (mounted.current) setError(e instanceof Error ? e.message : String(e))
    } finally { if (mounted.current) setBusy(false) }
  }
  const run = async (action: () => Promise<{ ok: true } | { ok: false; error: string }>) => {
    setBusy(true); setError('')
    try {
      const result = await action()
      if (!result.ok) throw new Error(result.error)
    } catch (e) { if (mounted.current) setError(e instanceof Error ? e.message : String(e)) }
    finally { if (mounted.current) setBusy(false) }
  }
  const reveal = () => run(() => window.codey.computer.reveal(desktop.sessionId, desktop.window))
  return <aside aria-label="Live application desktop" style={{ flex: `0 0 ${wide ? '65%' : '42%'}`, minWidth: 320, maxWidth: wide ? 1200 : 720,
    display: 'flex', flexDirection: 'column', borderLeft: `1px solid ${C.border}`, background: C.surface, color: C.fg, overflow: 'hidden' }}>
    <header style={{ padding: 14, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
      <strong style={{ flex: 1 }}>Desktop · {desktop.app}</strong>
      <button style={button} onClick={() => setWide(!wide)}>{wide ? 'Compact' : 'Expand'}</button>
      <button style={button} onClick={() => { stopVideo(); void window.codey.computer.stop().then(r => { if (!r.ok) setError(r.error) }) }}>Stop</button>
    </header>
    <div style={{ padding: '0 14px 12px', fontSize: 12, color: C.fg2, overflowWrap: 'anywhere' }}>{desktop.title || 'Untitled window'}</div>
    <div style={{ padding: '0 14px 12px', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
      <span role="status">{desktop.transitioning ? 'Switching…' : paused ? `${agent} is paused` : `${agent} is working`}</span>
      {!live ? <button style={button} disabled={busy} onClick={() => void startVideo()}>Start live view</button>
        : <button style={button} onClick={stopVideo}>Pause video</button>}
      <button style={button} disabled={busy || desktop.transitioning}
        onClick={() => void run(() => window.codey.computer.handoff(desktop.sessionId, desktop.window, !paused))}>{paused ? 'Resume agent' : 'Pause agent'}</button>
      <button style={button} disabled={busy} onClick={() => void reveal()}>Go to window</button>
    </div>
    <div style={{ flex: 1, minHeight: 160, position: 'relative', background: '#090b0e', display: 'flex', alignItems: 'center', overflow: 'hidden' }}>
      <video ref={video} muted playsInline aria-label="Live window video. Click to go to this window." title="Go to this window"
        onClick={() => { if (live && !busy) void reveal() }}
        style={{ width: '100%', height: '100%', objectFit: 'contain', cursor: live ? 'pointer' : 'default' }} />
      {!live && <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', color: '#adb3bc', pointerEvents: 'none' }}>Start live view to watch this window.</div>}
    </div>
    <footer style={{ padding: 14, fontSize: 12, color: C.fg2 }}>
      {paused ? 'The agent is paused. Use the window yourself, then resume the agent.' : 'Click the video to go to this window. Pause the agent before you use the window yourself.'}
      {error && <p role="alert" style={{ color: C.fg, marginBottom: 0 }}>{error}</p>}
    </footer>
  </aside>
}
