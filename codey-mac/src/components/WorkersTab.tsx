import { useEffect, useState, useCallback } from 'react'
import { apiService, WorkerDto } from '../services/api'
import { C } from '../theme'

type Mode = { kind: 'idle' } | { kind: 'select'; name: string } | { kind: 'create' }

export default function WorkersTab() {
  const [workers, setWorkers] = useState<WorkerDto[]>([])
  const [mode, setMode] = useState<Mode>({ kind: 'idle' })
  const [loading, setLoading] = useState(false)

  const reload = useCallback(async () => {
    setWorkers(await apiService.listWorkers())
  }, [])

  useEffect(() => { reload() }, [reload])

  const selected = mode.kind === 'select' ? workers.find(w => w.name === mode.name) : undefined

  return (
    <div style={{ display: 'flex', height: '100%', background: C.bg, color: C.fg }}>
      <div style={{ width: 240, borderRight: `1px solid ${C.border}`, display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: 12, fontSize: 12, color: C.fg3, textTransform: 'uppercase', letterSpacing: 0.5 }}>Workers</div>
        <div style={{ overflowY: 'auto', flex: 1 }}>
          {workers.map(w => (
            <button key={w.name} onClick={() => setMode({ kind: 'select', name: w.name })}
              style={{ display: 'block', width: '100%', textAlign: 'left', padding: '10px 12px', background: mode.kind === 'select' && mode.name === w.name ? C.surface2 : 'transparent', border: 'none', color: C.fg, cursor: 'pointer' }}>
              <div style={{ fontWeight: 600 }}>{w.name}</div>
              <div style={{ fontSize: 11, color: C.fg3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{w.personality.role}</div>
              <div style={{ fontSize: 10, color: C.fg3, marginTop: 2 }}>{w.config.codingAgent} · {w.config.model}</div>
            </button>
          ))}
        </div>
        <button onClick={() => setMode({ kind: 'create' })} style={{ margin: 12, padding: '8px 12px', background: C.accent, color: 'white', border: 'none', borderRadius: 6, cursor: 'pointer', fontWeight: 600 }}>+ New Worker</button>
      </div>

      <div style={{ flex: 1, overflowY: 'auto' }}>
        {mode.kind === 'idle' && <EmptyState />}
        {mode.kind === 'create' && <CreatePanel loading={loading} setLoading={setLoading} onCreated={async (w) => { await reload(); setMode({ kind: 'select', name: w.name }) }} onCancel={() => setMode({ kind: 'idle' })} />}
        {mode.kind === 'select' && selected && <EditorPanel worker={selected} onSaved={reload} onDeleted={async () => { await reload(); setMode({ kind: 'idle' }) }} />}
      </div>
    </div>
  )
}

function EmptyState() {
  return <div style={{ padding: 40, color: C.fg3 }}>Select a worker on the left, or create a new one.</div>
}

function CreatePanel({ loading, setLoading, onCreated, onCancel }: { loading: boolean; setLoading: (b: boolean) => void; onCreated: (w: WorkerDto) => void; onCancel: () => void }) {
  const [prompt, setPrompt] = useState('')
  const [error, setError] = useState<string | null>(null)

  const submit = async () => {
    if (!prompt.trim() || loading) return
    setLoading(true); setError(null)
    try {
      const worker = await apiService.generateWorker(prompt)
      onCreated(worker)
    } catch (err: any) {
      setError(err.message || String(err))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={{ padding: 24, maxWidth: 640 }}>
      <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 8 }}>Describe the worker</div>
      <div style={{ fontSize: 12, color: C.fg3, marginBottom: 12 }}>The active coding agent will generate a personality and config from your description.</div>
      {error && <div style={{ background: '#3a1a1a', border: '1px solid #6a2a2a', color: '#ff8080', padding: 10, borderRadius: 6, marginBottom: 12, fontSize: 12 }}>{error}</div>}
      <textarea value={prompt} onChange={e => setPrompt(e.target.value)} placeholder="e.g. A reviewer that audits PRs for security issues, leans on Opus, uses file-system and git tools."
        style={{ width: '100%', minHeight: 160, padding: 12, background: C.surface2, color: C.fg, border: `1px solid ${C.border}`, borderRadius: 6, fontFamily: 'inherit', fontSize: 14, resize: 'vertical' }} />
      <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
        <button onClick={submit} disabled={loading || !prompt.trim()}
          style={{ padding: '8px 16px', background: loading ? C.fg3 : C.accent, color: 'white', border: 'none', borderRadius: 6, cursor: loading ? 'wait' : 'pointer', fontWeight: 600 }}>
          {loading ? 'Generating\u2026' : 'Create'}
        </button>
        <button onClick={onCancel} disabled={loading}
          style={{ padding: '8px 16px', background: 'transparent', color: C.fg, border: `1px solid ${C.border}`, borderRadius: 6, cursor: 'pointer' }}>Cancel</button>
      </div>
    </div>
  )
}

function EditorPanel({ worker, onSaved, onDeleted }: { worker: WorkerDto; onSaved: () => void; onDeleted: () => void }) {
  const [role, setRole] = useState(worker.personality.role)
  const [soul, setSoul] = useState(worker.personality.soul)
  const [instructions, setInstructions] = useState(worker.personality.instructions)
  const [codingAgent, setCodingAgent] = useState(worker.config.codingAgent)
  const [model, setModel] = useState(worker.config.model)
  const [toolsText, setToolsText] = useState(worker.config.tools.join(', '))
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setRole(worker.personality.role); setSoul(worker.personality.soul); setInstructions(worker.personality.instructions)
    setCodingAgent(worker.config.codingAgent); setModel(worker.config.model); setToolsText(worker.config.tools.join(', '))
    setSaved(false); setError(null)
  }, [worker.name])

  const save = async () => {
    setSaving(true); setError(null)
    try {
      await apiService.updateWorker(worker.name, {
        personality: { role, soul, instructions },
        config: { codingAgent, model, tools: toolsText.split(',').map(s => s.trim()).filter(Boolean) },
      })
      setSaved(true); setTimeout(() => setSaved(false), 1500); onSaved()
    } catch (err: any) {
      setError(err.message || String(err))
    } finally {
      setSaving(false)
    }
  }

  const confirmDelete = async () => {
    if (!confirm(`Delete worker "${worker.name}"? This also removes it from any team that references it.`)) return
    try { await apiService.deleteWorker(worker.name); onDeleted() } catch (err: any) { setError(err.message || String(err)) }
  }

  const fieldStyle = { width: '100%', padding: 10, background: C.surface2, color: C.fg, border: `1px solid ${C.border}`, borderRadius: 6, fontFamily: 'inherit', fontSize: 13, resize: 'vertical' as const }
  const labelStyle = { display: 'block', fontSize: 11, color: C.fg3, textTransform: 'uppercase' as const, letterSpacing: 0.5, marginTop: 16, marginBottom: 6 }

  return (
    <div style={{ padding: 24, maxWidth: 720 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <div style={{ fontSize: 18, fontWeight: 600 }}>{worker.name}</div>
        <button onClick={confirmDelete} style={{ background: 'transparent', color: '#ff6060', border: `1px solid #6a2a2a`, padding: '6px 10px', borderRadius: 6, cursor: 'pointer', fontSize: 12 }}>Delete</button>
      </div>
      {error && <div style={{ background: '#3a1a1a', border: '1px solid #6a2a2a', color: '#ff8080', padding: 10, borderRadius: 6, fontSize: 12 }}>{error}</div>}

      <label style={labelStyle}>Role</label>
      <textarea value={role} onChange={e => setRole(e.target.value)} style={{ ...fieldStyle, minHeight: 60 }} />

      <label style={labelStyle}>Soul</label>
      <textarea value={soul} onChange={e => setSoul(e.target.value)} style={{ ...fieldStyle, minHeight: 90 }} />

      <label style={labelStyle}>Instructions</label>
      <textarea value={instructions} onChange={e => setInstructions(e.target.value)} style={{ ...fieldStyle, minHeight: 140 }} />

      <label style={labelStyle}>Coding Agent</label>
      <select value={codingAgent} onChange={e => setCodingAgent(e.target.value as any)} style={fieldStyle}>
        <option value="claude-code">claude-code</option>
        <option value="opencode">opencode</option>
        <option value="codex">codex</option>
      </select>

      <label style={labelStyle}>Model</label>
      <input value={model} onChange={e => setModel(e.target.value)} style={fieldStyle} />

      <label style={labelStyle}>Tools (comma-separated)</label>
      <input value={toolsText} onChange={e => setToolsText(e.target.value)} style={fieldStyle} />

      <div style={{ marginTop: 20 }}>
        <button onClick={save} disabled={saving}
          style={{ padding: '8px 20px', background: saved ? C.green : C.accent, color: 'white', border: 'none', borderRadius: 6, cursor: saving ? 'wait' : 'pointer', fontWeight: 600 }}>
          {saving ? 'Saving\u2026' : saved ? '\u2713 Saved' : 'Save'}
        </button>
      </div>
    </div>
  )
}
