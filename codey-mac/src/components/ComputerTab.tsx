import React, { useEffect, useState } from 'react'
import { C } from '../theme'
import type { ComputerControlState, ComputerPreview, ComputerReply } from '../../electron/computer-control'

export const ComputerTab: React.FC<{ onOpenDesktop?: () => void }> = ({ onOpenDesktop }) => {
  const [state, setState] = useState<ComputerControlState>()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [preview, setPreview] = useState<ComputerPreview | null>(null)
  const [windows, setWindows] = useState<NonNullable<ComputerReply['windows']>>([])
  const [selected, setSelected] = useState('')
  const refresh = async () => {
    const result = await window.codey.computer.status()
    if (result.ok) setState(result.data); else setError(result.error)
  }
  useEffect(() => {
    void refresh()
    const off = window.codey.computer.onChanged(next => { setState(next); if (!next.active) { setWindows([]); setSelected(''); setPreview(null) } })
    let alive = true
    const updatePreview = async () => {
      const result = await window.codey.computer.preview()
      if (alive && result.ok) setPreview(result.data)
    }
    void updatePreview()
    const timer = setInterval(() => { void updatePreview() }, 1000)
    const focus = () => { void refresh() }
    window.addEventListener('focus', focus)
    return () => { alive = false; clearInterval(timer); off(); window.removeEventListener('focus', focus) }
  }, [])
  const run = async (action: () => Promise<void>) => {
    setBusy(true); setError('')
    try { await action() } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }
  const configure = async (enabled: boolean, apps = state?.apps ?? []) => {
    const result = await window.codey.computer.configure(enabled, apps)
    if (!result.ok) throw new Error(result.error)
    setState(result.data)
  }
  const ready = state?.available && state.accessibility && state.screenRecording && state.apps.length > 0
  const button: React.CSSProperties = { padding: '8px 12px', border: `1px solid ${C.border}`, borderRadius: 8,
    background: C.surface2, color: C.fg, cursor: 'pointer' }
  return <section style={{ maxWidth: 1000, color: C.fg }}>
    <h3>Computer control</h3>
    <p style={{ color: C.fg2 }}>View Mac application windows in Codey. Agents use Codey to observe and operate the same windows, with your approval on first use.</p>
    <p>Driver: {state?.available ? 'Ready' : 'Not bundled in this build'}</p>
    <p>Accessibility: {state?.accessibility ? 'Allowed' : 'Required'} · Screen Recording: {state?.screenRecording ? 'Allowed' : 'Required'}</p>
    <button style={button} disabled={busy} onClick={() => void run(async () => {
      const r = await window.codey.computer.permissions()
      if (!r.ok) throw new Error(r.error)
      setState(r.data)
    })}>Set up permissions</button>{' '}
    <button style={button} disabled={busy} onClick={() => void run(refresh)}>Check again</button>
    <h4>Applications</h4>
    <p style={{ color: C.fg2 }}>These apps can be offered for task approval. Changing the list stops current computer control. Browser work continues through Codey's existing browser tools.</p>
    {state?.apps.map(item => <div key={item.bundleId} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 0' }}>
      <span style={{ flex: 1 }}>{item.name} <small style={{ color: C.fg2 }}>{item.bundleId}</small></span>
      <button style={button} disabled={busy} onClick={() => void run(() => configure(false, state.apps.filter(a => a.bundleId !== item.bundleId)))}>Remove</button>
    </div>)}
    <button style={button} disabled={busy || (state?.apps.length ?? 0) >= 16} onClick={() => void run(async () => {
      const r = await window.codey.computer.pickApp()
      if (!r.ok) throw new Error(r.error)
      if (r.data && !state?.apps.some(a => a.bundleId === r.data?.bundleId)) await configure(false, [...(state?.apps ?? []), r.data])
    })}>Add application</button>
    <div style={{ marginTop: 24 }}>
      <label><input type="checkbox" checked={state?.enabled ?? false} disabled={busy || (!state?.enabled && !ready)}
        onChange={e => void run(() => configure(e.target.checked))} /> Enable for new tasks</label>
      <p style={{ color: C.fg2 }}>Off by default at launch. Ordinary coding tasks do not request access. Codey asks when an agent first uses computer tools. One task controls applications at a time.</p>
    </div>
    <h4>Application desktop</h4>
    <p style={{ color: C.fg2 }}>Choose a window to open the desktop panel beside your chat. Start live view there to watch it and take over mouse and keyboard control.</p>
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      {state?.apps.map(item => <button key={item.bundleId} style={button} disabled={busy || !state.enabled || (!!state.active && state.active.agent !== 'Codey preview')}
        onClick={() => void run(async () => {
          const r = await window.codey.computer.view({ action: 'windows', bundleId: item.bundleId })
          if (!r.ok) throw new Error(r.error)
          setWindows(r.data.windows ?? []); setSelected('')
          if (!r.data.windows?.length) setError(r.data.text ?? 'No visible windows')
        })}>View {item.name}</button>)}
    </div>
    {windows.length > 0 && <div style={{ marginTop: 12 }}>
      <select aria-label="Application window" value={selected} onChange={e => setSelected(e.target.value)}>
        <option value="">Choose a window</option>
        {windows.map(w => <option key={w.id} value={w.id}>{w.app}: {w.title || 'Untitled'}</option>)}
      </select>{' '}
      <button style={button} disabled={busy || !selected || state?.active?.agent !== 'Codey preview'} onClick={() => void run(async () => {
        const r = await window.codey.computer.view({ action: 'observe', window: selected })
        if (!r.ok) throw new Error(r.error)
        setPreview({ updatedAt: Date.now(), window: selected, reply: r.data })
        if (!r.data.isError) onOpenDesktop?.()
      })}>Open desktop</button>
    </div>}
    {preview ? <div style={{ marginTop: 16 }}>
      <small style={{ color: C.fg2 }}>Window {preview.window} · Observed {new Date(preview.updatedAt).toLocaleTimeString()}</small>
      {preview.reply.images?.map((img, index) => <img key={index} alt="Observed application window" src={`data:${img.mimeType};base64,${img.dataBase64}`}
        style={{ display: 'block', width: '100%', maxHeight: 600, objectFit: 'contain', marginTop: 8, background: C.surface2, borderRadius: 8 }} />)}
      {preview.reply.isError && <p role="alert">Window observation failed. Refresh before continuing.</p>}
      <details><summary>Window content</summary><pre style={{ whiteSpace: 'pre-wrap', maxHeight: 240, overflow: 'auto' }}>{preview.reply.text}</pre></details>
    </div> : <p style={{ color: C.fg2 }}>No window observed yet.</p>}
    {error && <p role="alert" style={{ color: C.fg }}>{error}</p>}
  </section>
}

/** Kept outside the Tools overlay so control can always be stopped. */
export const ComputerControlIndicator: React.FC = () => {
  const [state, setState] = useState<ComputerControlState>()
  const [error, setError] = useState('')
  useEffect(() => {
    void window.codey.computer.status().then(r => { if (r.ok) setState(r.data) })
    return window.codey.computer.onChanged(setState)
  }, [])
  if (!state?.active && !state?.queued) return null
  return <div role="status" style={{ position: 'fixed', bottom: 16, right: 16, zIndex: 10000,
    padding: 12, borderRadius: 10, border: `1px solid ${C.border}`, background: C.surface2, color: C.fg }}>
    <span>{state.active?.agent}: {state.active?.phase === 'waiting' ? 'Waiting for approval' : state.active?.phase === 'starting' ? 'Starting computer control' : 'Computer control active'}{state.queued ? ` · ${state.queued} queued` : ''}</span>{' '}
    <button onClick={() => { void window.codey.computer.stop().then(r => { if (!r.ok) setError(r.error) }) }}>Stop computer control</button>
    {error && <span role="alert">{error}</span>}
  </div>
}
