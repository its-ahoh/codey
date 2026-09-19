import { useEffect, useState, useCallback } from 'react'
import { apiService, WorkerDto } from '../services/api'
import { AvatarPicker } from './AvatarPicker'
import { WorkerAvatar } from './WorkerAvatar'
import { resolveWorkerAvatar } from './workerAvatarModel'
import { C } from '../theme'

type Mode = { kind: 'idle' } | { kind: 'select'; name: string } | { kind: 'create' }

export default function WorkersTab({ initialName }: { initialName?: string }) {
  const [workers, setWorkers] = useState<WorkerDto[]>([])
  const [mode, setMode] = useState<Mode>(initialName ? { kind: 'select', name: initialName } : { kind: 'idle' })
  const [loading, setLoading] = useState(false)

  const reload = useCallback(async () => {
    setWorkers(await apiService.listWorkers())
  }, [])

  useEffect(() => { reload() }, [reload])

  const selected = mode.kind === 'select' ? workers.find(w => w.name === mode.name) : undefined

  return (
    <div style={{ display: 'flex', height: '100%', background: C.bg, color: C.fg }}>
      <div style={{ width: 240, borderRight: `1px solid ${C.border}`, display: 'flex', flexDirection: 'column' }}>
        <div style={{ overflowY: 'auto', flex: 1 }}>
          {workers.map(w => (
            <button key={w.name} onClick={() => setMode({ kind: 'select', name: w.name })}
              style={{ display: 'block', width: '100%', textAlign: 'left', padding: '10px 12px', background: mode.kind === 'select' && mode.name === w.name ? C.surface2 : 'transparent', border: 'none', color: C.fg, cursor: 'pointer' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><WorkerAvatar name={w.name} config={w.config.avatar} /><strong>{w.name}</strong></div>
              <div style={{ fontSize: 11, color: C.fg3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{w.personality.role}</div>
            </button>
          ))}
        </div>
        <button onClick={() => setMode({ kind: 'create' })} style={{ margin: 12, padding: '8px 12px', background: C.accent, color: C.onAccent, border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 600 }}>+ New Bot</button>
      </div>

      <div style={{ flex: 1, overflowY: 'auto' }}>
        {mode.kind === 'idle' && <EmptyState />}
        {mode.kind === 'create' && <CreatePanel loading={loading} setLoading={setLoading} onCreated={async (w) => { await reload(); setMode({ kind: 'select', name: w.name }) }} onCancel={() => setMode({ kind: 'idle' })} />}
        {mode.kind === 'select' && selected && <EditorPanel key={selected.name} worker={selected}
          onSaved={async (name) => { await reload(); setMode({ kind: 'select', name }) }}
          onDeleted={async () => { await reload(); setMode({ kind: 'idle' }) }} />}
      </div>
    </div>
  )
}

function EmptyState() {
  return <div style={{ padding: 40, color: C.fg3 }}>Select a bot on the left, or create a new one.</div>
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
    <div style={{ padding: 20, maxWidth: 640 }}>
      <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 8 }}>Describe the bot</div>
      <div style={{ fontSize: 12, color: C.fg3, marginBottom: 12 }}>Describe its role, working style, and instructions.</div>
      {error && <div style={{ background: C.dangerBg, border: `1px solid ${C.dangerBorder}`, color: C.dangerFg, padding: 10, borderRadius: 6, marginBottom: 12, fontSize: 12 }}>{error}</div>}
      <textarea value={prompt} onChange={e => setPrompt(e.target.value)} placeholder="e.g. A reviewer that audits PRs for security issues and explains actionable fixes."
        style={{ width: '100%', minHeight: 160, padding: 12, background: C.surface2, color: C.fg, border: `1px solid ${C.border}`, borderRadius: 6, fontFamily: 'inherit', fontSize: 14, resize: 'vertical' }} />
      <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
        <button onClick={submit} disabled={loading || !prompt.trim()}
          style={{ padding: '8px 16px', background: loading ? C.fg3 : C.accent, color: C.onAccent, border: 'none', borderRadius: 6, cursor: loading ? 'wait' : 'pointer', fontWeight: 600 }}>
          {loading ? 'Generating\u2026' : 'Create'}
        </button>
        <button onClick={onCancel} disabled={loading}
          style={{ padding: '8px 16px', background: 'transparent', color: C.fg, border: `1px solid ${C.border}`, borderRadius: 6, cursor: 'pointer' }}>Cancel</button>
      </div>
    </div>
  )
}

function EditorPanel({ worker, onSaved, onDeleted }: { worker: WorkerDto; onSaved: (name: string) => void; onDeleted: () => void }) {
  const [avatar, setAvatar] = useState(() => resolveWorkerAvatar(worker.name, worker.config.avatar))
  const [name, setName] = useState(worker.name)
  const [editingName, setEditingName] = useState(false)
  const [role, setRole] = useState(worker.personality.role)
  const [soul, setSoul] = useState(worker.personality.soul)
  const [instructions, setInstructions] = useState(worker.personality.instructions)
  const [toolsText, setToolsText] = useState(worker.config.tools.join(', '))
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setRole(worker.personality.role); setSoul(worker.personality.soul); setInstructions(worker.personality.instructions)
    setToolsText(worker.config.tools.join(', '))
    setAvatar(resolveWorkerAvatar(worker.name, worker.config.avatar))
    setName(worker.name); setEditingName(false)
    setSaved(false); setError(null)
  }, [worker.name])

  const save = async () => {
    setSaving(true); setError(null)
    const nextName = name.trim()
    try {
      if (nextName !== worker.name) await apiService.renameWorker(worker.name, nextName)
      await apiService.updateWorker(nextName, {
        personality: { role, soul, instructions },
        config: {
          ...worker.config,
          avatar,
          tools: toolsText.split(',').map(s => s.trim()).filter(Boolean),
        },
      })
      window.dispatchEvent(new Event('codey:workers-changed'))
      setSaved(true); setTimeout(() => setSaved(false), 1500); onSaved(nextName)
    } catch (err: any) {
      setError(err.message || String(err))
    } finally {
      setSaving(false)
    }
  }

  const confirmDelete = async () => {
    if (!confirm(`Delete bot "${worker.name}"? This also removes it from any team that references it.`)) return
    try { await apiService.deleteWorker(worker.name); onDeleted() } catch (err: any) { setError(err.message || String(err)) }
  }

  const fieldStyle = { width: '100%', padding: 10, background: C.surface2, color: C.fg, border: `1px solid ${C.border}`, borderRadius: 6, fontFamily: 'inherit', fontSize: 13, resize: 'vertical' as const }
  const labelStyle = { display: 'block', fontSize: 11, color: C.fg3, textTransform: 'uppercase' as const, letterSpacing: 0.5, marginTop: 16, marginBottom: 6 }

  return (
    <div style={{ padding: 20, maxWidth: 720 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, minWidth: 0 }}>
          <AvatarPicker name={name.trim() || worker.name} value={avatar} onChange={setAvatar} />
          {editingName
            ? <input autoFocus value={name} aria-label="Bot name"
                onChange={e => setName(e.target.value)}
                onBlur={() => { setEditingName(false); if (!name.trim()) setName(worker.name) }}
                onKeyDown={e => {
                  if (e.key === 'Enter') e.currentTarget.blur()
                  if (e.key === 'Escape') { setName(worker.name); setEditingName(false) }
                }}
                style={{ fontSize: 18, fontWeight: 600, padding: '2px 6px', background: C.surface2, color: C.fg, border: `1px solid ${C.accent}`, borderRadius: 6, fontFamily: 'inherit', minWidth: 0 }} />
            : <button type="button" onClick={() => setEditingName(true)} title="Rename" aria-label={`Rename ${name}`}
                style={{ fontSize: 18, fontWeight: 600, padding: '2px 6px', margin: '0 -6px', background: 'transparent', color: C.fg, border: 'none', borderRadius: 6, cursor: 'text', fontFamily: 'inherit', textAlign: 'left' }}>
                {name}</button>}
        </div>
        <button onClick={confirmDelete} style={{ background: 'transparent', color: C.dangerFg, border: `1px solid ${C.dangerBorder}`, padding: '6px 10px', borderRadius: 6, cursor: 'pointer', fontSize: 12 }}>Delete</button>
      </div>
      {error && <div style={{ background: C.dangerBg, border: `1px solid ${C.dangerBorder}`, color: C.dangerFg, padding: 10, borderRadius: 6, fontSize: 12 }}>{error}</div>}

      <label style={labelStyle}>Role</label>
      <textarea value={role} onChange={e => setRole(e.target.value)} style={{ ...fieldStyle, minHeight: 60 }} />

      <label style={labelStyle}>Soul</label>
      <textarea value={soul} onChange={e => setSoul(e.target.value)} style={{ ...fieldStyle, minHeight: 90 }} />

      <label style={labelStyle}>Instructions</label>
      <textarea value={instructions} onChange={e => setInstructions(e.target.value)} style={{ ...fieldStyle, minHeight: 140 }} />

      <label style={labelStyle}>Tools (comma-separated)</label>
      <input value={toolsText} onChange={e => setToolsText(e.target.value)} style={fieldStyle} />

      <div style={{ marginTop: 20 }}>
        <button onClick={save} disabled={saving}
          style={{ padding: '8px 20px', background: saved ? C.green : C.accent, color: C.onAccent, border: 'none', borderRadius: 6, cursor: saving ? 'wait' : 'pointer', fontWeight: 600 }}>
          {saving ? 'Saving\u2026' : saved ? '\u2713 Saved' : 'Save'}
        </button>
      </div>
    </div>
  )
}
