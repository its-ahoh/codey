import React, { useEffect, useRef, useState } from 'react'
import type { ComputerDesktop, ComputerControlState } from '../../electron/computer-control'
import { C } from '../theme'
import { desktopKey, windowPoint } from './computerDesktopInput'

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

export const DesktopSurface: React.FC<{ desktop: ComputerDesktop; agent: string }> = ({ desktop, agent }) => {
  const video = useRef<HTMLVideoElement>(null)
  const keyboard = useRef<HTMLTextAreaElement>(null)
  const media = useRef<MediaStream>()
  const streamId = useRef('')
  const generation = useRef(0)
  const mounted = useRef(true)
  const lastFrame = useRef(-Infinity)
  const gesture = useRef<{ x: number; y: number; button: number }>()
  const composing = useRef(false)
  const compositionTimer = useRef<ReturnType<typeof setTimeout>>()
  const textTimer = useRef<ReturnType<typeof setTimeout>>()
  const textBuffer = useRef('')
  const inputEpoch = useRef(0)
  const inputs = useRef<Promise<void>>(Promise.resolve())
  const pendingInputs = useRef(0)
  const [live, setLive] = useState(false)
  const [fresh, setFresh] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [wide, setWide] = useState(false)
  const human = desktop.controller === 'human' && !desktop.transitioning
  const current = useRef({ desktop, human, fresh })
  current.current = { desktop, human, fresh }
  const button: React.CSSProperties = { padding: '7px 10px', border: `1px solid ${C.border}`, borderRadius: 7, background: C.surface2, color: C.fg, cursor: 'pointer' }
  const stopVideo = () => {
    generation.current++
    media.current?.getTracks().forEach(track => track.stop())
    media.current = undefined
    if (video.current) video.current.srcObject = null
    if (streamId.current) void window.codey.computer.streamStopped(streamId.current)
    streamId.current = ''
    gesture.current = undefined
    inputEpoch.current++
    textBuffer.current = ''
    clearTimeout(textTimer.current); clearTimeout(compositionTimer.current)
    lastFrame.current = -Infinity
    if (mounted.current) { setLive(false); setFresh(false) }
  }
  useEffect(() => {
    mounted.current = true
    const timer = setInterval(() => setFresh(!!media.current && performance.now() - lastFrame.current < 1500), 300)
    return () => { mounted.current = false; clearInterval(timer); stopVideo() }
  }, [])
  useEffect(() => {
    gesture.current = undefined
    inputEpoch.current++
    textBuffer.current = ''
    clearTimeout(textTimer.current); clearTimeout(compositionTimer.current)
    if (keyboard.current) keyboard.current.value = ''
  }, [desktop.controller, desktop.transitioning])

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
      const frame = () => {
        if (media.current !== stream || !mounted.current) return
        lastFrame.current = performance.now()
        element.requestVideoFrameCallback(frame)
      }
      element.requestVideoFrameCallback(frame)
      setLive(true)
    } catch (e) {
      if (grant) await window.codey.computer.streamStopped(grant)
      stopVideo()
      if (mounted.current) setError(e instanceof Error ? e.message : String(e))
    } finally { if (mounted.current) setBusy(false) }
  }
  const handoff = async (take: boolean) => {
    setBusy(true); setError('')
    gesture.current = undefined
    try {
      if (!take) { flushText(); await inputs.current }
      const result = await window.codey.computer.handoff(desktop.sessionId, desktop.window, take, streamId.current)
      if (!result.ok) throw new Error(result.error)
      if (take) keyboard.current?.focus({ preventScroll: true })
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { if (mounted.current) setBusy(false) }
  }
  const send = (args: Record<string, unknown>) => {
    if (!current.current.human || !current.current.fresh || !streamId.current || !video.current) return
    if (pendingInputs.current >= 12) { setError('Input is busy. Wait for it to finish.'); return }
    if (args.tool !== 'type_text') flushText()
    const expectedEpoch = inputEpoch.current
    const expected = current.current.desktop
    const id = streamId.current
    const dimensions = { frameWidth: video.current.videoWidth, frameHeight: video.current.videoHeight, frameAt: Date.now() - (performance.now() - lastFrame.current) }
    pendingInputs.current++
    inputs.current = inputs.current.then(async () => {
      if (!mounted.current || !current.current.human || !current.current.fresh || streamId.current !== id ||
        current.current.desktop.controlVersion !== expected.controlVersion || inputEpoch.current !== expectedEpoch) return
      const result = await window.codey.computer.input(expected.sessionId, expected.window, { ...args, ...dimensions }, id, expected.controlVersion)
      if (!result.ok) throw new Error(result.error)
      if (result.data.isError) throw new Error(result.data.text ?? 'The application refused this input')
    }).catch(e => { inputEpoch.current++; if (mounted.current) setError(e instanceof Error ? e.message : String(e)) })
      .finally(() => { pendingInputs.current-- })
  }
  const point = (x: number, y: number) => {
    const element = video.current
    return element ? windowPoint(element.getBoundingClientRect(), element.videoWidth, element.videoHeight, x, y) : null
  }
  const flushText = () => {
    clearTimeout(textTimer.current)
    const text = textBuffer.current; textBuffer.current = ''
    if (text) send({ tool: 'type_text', text })
  }
  const insert = (text: string) => {
    textBuffer.current += text
    clearTimeout(textTimer.current)
    textTimer.current = setTimeout(flushText, 100)
  }
  return <aside aria-label="Live application desktop" style={{ flex: `0 0 ${wide ? '65%' : '42%'}`, minWidth: 320, maxWidth: wide ? 1200 : 720,
    display: 'flex', flexDirection: 'column', borderLeft: `1px solid ${C.border}`, background: C.surface, color: C.fg, overflow: 'hidden' }}>
    <header style={{ padding: 14, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
      <strong style={{ flex: 1 }}>Desktop · {desktop.app}</strong>
      <button style={button} onClick={() => setWide(!wide)}>{wide ? 'Compact' : 'Expand'}</button>
      <button style={button} onClick={() => { stopVideo(); void window.codey.computer.stop().then(r => { if (!r.ok) setError(r.error) }) }}>Stop</button>
    </header>
    <div style={{ padding: '0 14px 12px', fontSize: 12, color: C.fg2, overflowWrap: 'anywhere' }}>{desktop.title || 'Untitled window'}</div>
    <div style={{ padding: '0 14px 12px', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
      <span role="status">{desktop.transitioning ? 'Switching control…' : human ? 'You have control' : `${agent} has control`}</span>
      {!live ? <button style={button} disabled={busy} onClick={() => void startVideo()}>Start live view</button>
        : <button style={button} onClick={stopVideo}>Pause video</button>}
      <button style={button} disabled={busy || desktop.transitioning || (!human && (!live || !fresh))} onClick={() => void handoff(!human)}>{human ? 'Return control' : 'Take control'}</button>
    </div>
    <div style={{ flex: 1, minHeight: 160, position: 'relative', background: '#090b0e', display: 'flex', alignItems: 'center', overflow: 'hidden' }}
      onContextMenu={event => event.preventDefault()}
      onPointerDown={event => {
        if (!human || !fresh || (event.button !== 0 && event.button !== 2)) return
        const p = point(event.clientX, event.clientY)
        if (!p) return
        event.preventDefault(); keyboard.current?.focus({ preventScroll: true })
        gesture.current = { ...p, button: event.button }; event.currentTarget.setPointerCapture(event.pointerId)
      }}
      onPointerCancel={() => { gesture.current = undefined }}
      onPointerUp={event => {
        const start = gesture.current; gesture.current = undefined
        if (!start || !human || !fresh) return
        const end = point(event.clientX, event.clientY)
        if (!end) return
        if (Math.hypot((start.x - end.x) * (video.current?.videoWidth ?? 0), (start.y - end.y) * (video.current?.videoHeight ?? 0)) > 5 && start.button === 0) {
          send({ tool: 'drag', from_x: start.x, from_y: start.y, to_x: end.x, to_y: end.y })
        } else send({ tool: 'click', x: end.x, y: end.y, button: start.button === 2 ? 'right' : 'left' })
      }}
      onWheel={event => {
        if (!human || !fresh) return
        const p = point(event.clientX, event.clientY)
        if (p) send({ tool: 'scroll', ...p, direction: Math.abs(event.deltaX) > Math.abs(event.deltaY) ? (event.deltaX > 0 ? 'right' : 'left') : (event.deltaY > 0 ? 'down' : 'up'), amount: Math.min(6, Math.max(1, Math.round(Math.max(Math.abs(event.deltaX), Math.abs(event.deltaY)) / 80))) })
      }}>
      <video ref={video} muted playsInline aria-label="Live window video" style={{ width: '100%', height: '100%', objectFit: 'contain', cursor: human ? 'crosshair' : 'default' }} />
      {!live && <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', color: '#adb3bc', pointerEvents: 'none' }}>Start live view to watch this window.</div>}
      {live && !fresh && <div role="status" style={{ position: 'absolute', bottom: 12, left: 12, color: '#fff', background: '#252525', padding: 8 }}>Waiting for fresh video · input paused</div>}
      <textarea ref={keyboard} aria-label="Keyboard input for the application" disabled={!human || !fresh}
        style={{ position: 'absolute', width: 1, height: 1, opacity: 0, pointerEvents: 'none' }}
        onBlur={() => { gesture.current = undefined }}
        onCompositionStart={() => { clearTimeout(compositionTimer.current); compositionTimer.current = undefined; composing.current = true }}
        onCompositionEnd={() => {
          composing.current = false
          compositionTimer.current = setTimeout(() => {
            compositionTimer.current = undefined
            if (keyboard.current) { insert(keyboard.current.value); keyboard.current.value = '' }
          }, 20)
        }}
        onInput={event => { if (!composing.current && !compositionTimer.current) { insert(event.currentTarget.value); event.currentTarget.value = '' } }}
        onPaste={event => { event.preventDefault(); insert(event.clipboardData.getData('text/plain')) }}
        onKeyDown={event => {
          event.stopPropagation()
          if (composing.current || event.nativeEvent.isComposing) return
          if (event.ctrlKey && event.shiftKey && event.key === 'Escape') { event.preventDefault(); void handoff(false); return }
          const action = desktopKey(event)
          if (action) { event.preventDefault(); send(action) }
        }} />
    </div>
    <footer style={{ padding: 14, fontSize: 12, color: C.fg2 }}>
      {human ? 'Click the video to type. Drag, right-click and scroll directly. Ctrl+Shift+Esc returns control.' : 'Take control to use the mouse and keyboard. Agent input pauses until you return control.'}
      {error && <p role="alert" style={{ color: C.fg, marginBottom: 0 }}>{error}</p>}
    </footer>
  </aside>
}
