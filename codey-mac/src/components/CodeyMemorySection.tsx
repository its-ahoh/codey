import { ArchivedMemories, MemoryConflictCard, MemoryHistory } from './MemoryManagement'
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { C } from '../theme'
import { Toggle, unwrap } from './settingsAtoms'
import type { CodeyMemoryItem, MemoryStoreScope, CoMemoConflictView, CoMemoDetails } from '../codey-api'

/** User/project notes are managed through Co-memo; old Codey files can be imported explicitly. */

const relative = (ms: number): string => {
  const mins = Math.round((Date.now() - ms) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

const typeBadge: React.CSSProperties = {
  fontSize: 10, fontWeight: 650, padding: '2px 6px', borderRadius: 5,
  background: C.surface3, color: C.fg3, textTransform: 'uppercase',
}

const smallButton = (danger?: boolean): React.CSSProperties => ({
  padding: '3px 8px', fontSize: 11, borderRadius: 6, cursor: 'pointer',
  background: 'transparent',
  color: danger ? C.red : C.fg2,
  border: `1px solid ${danger ? C.red + '66' : C.border2}`,
})

const EntryRow: React.FC<{
  entry: CodeyMemoryItem
  disabled: boolean
  onHistory: () => void
  onSave: (content: string) => Promise<boolean>
  onRemove: () => Promise<void>
}> = ({ entry, onSave, onRemove, disabled, onHistory }) => {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(entry.content)
  const [busy, setBusy] = useState(false)

  useEffect(() => { setDraft(entry.content) }, [entry.content])

  const save = async () => {
    if (busy || draft.trim() === entry.content.trim()) { setEditing(false); return }
    setBusy(true)
    try { if (await onSave(draft)) setEditing(false) } finally { setBusy(false) }
  }

  return (
    <div style={{ borderTop: `1px solid ${C.border}`, padding: '8px 0' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={typeBadge}>{entry.type}</span>
        <span style={{ color: C.fg, fontSize: 12, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {entry.label || entry.content.slice(0, 60)}
        </span>
        <span style={{ color: C.fg3, fontSize: 11 }} title={`from ${entry.source}, used ${entry.accessCount}x`}>
          {relative(entry.updatedAt)}
        </span>
        <button disabled={disabled} onClick={onHistory} style={smallButton()}>History</button>
        <button disabled={disabled} onClick={() => setEditing(e => !e)} style={smallButton()}>{editing ? 'Close' : 'Edit'}</button>
        <button disabled={disabled} onClick={() => void onRemove()} style={smallButton(true)} title="Archive this memory while keeping its history">Archive</button>
      </div>
      {editing && (
        <div style={{ marginTop: 6 }}>
          <textarea
            value={draft}
            onChange={e => setDraft(e.target.value)}
            spellCheck={false}
            style={{
              width: '100%', minHeight: 90, resize: 'vertical', boxSizing: 'border-box',
              background: C.surface3, color: C.fg, border: `1px solid ${C.border2}`, borderRadius: 8,
              padding: 8, fontSize: 12, outline: 'none',
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            }}
          />
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 6 }}>
            <button onClick={() => { setDraft(entry.content); setEditing(false) }} style={smallButton()}>Cancel</button>
            <button onClick={() => void save()} disabled={busy || disabled} style={{ ...smallButton(), color: C.accent, borderColor: C.accent }}>
              {busy ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

interface PanelProps {
  scope: MemoryStoreScope
  /** Required for the workspace scope; ignored for the global one. */
  workspace?: string
  /** Optional header title; omit it when an outer section already names the panel. */
  title?: string
  description: string
  /** Rendered between the header and the composer, e.g. a sharing switch. */
  banner?: React.ReactNode
}

export const MemoryPanel: React.FC<PanelProps> = ({ scope, workspace, title, description, banner }) => {
  const [entries, setEntries] = useState<CodeyMemoryItem[]>([])
  const [view, setView] = useState<'active' | 'archived' | 'conflicts'>('active')
  const [archived, setArchived] = useState<CodeyMemoryItem[]>([])
  const [conflicts, setConflicts] = useState<CoMemoConflictView[]>([])
  const [details, setDetails] = useState<CoMemoDetails | null>(null)
  const [mutating, setMutating] = useState(false)
  const running = useRef(false)
  const request = useRef(0)
  const [draft, setDraft] = useState('')
  const [legacyCount, setLegacyCount] = useState(0)
  const [notice, setNotice] = useState('')
  const [adding, setAdding] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    const generation = ++request.current
    setLoading(true)
    setError(null)
    try {
      const result = unwrap(await window.codey.memory.codey.list(scope, workspace))
      if (generation !== request.current) return
      setEntries(result.entries)
      setArchived(result.archived)
      setConflicts(result.conflicts)
      setLegacyCount(result.legacyCount ?? 0)
    } catch (e: any) { if (generation === request.current) setError(e?.message ?? String(e)) }
    finally { if (generation === request.current) setLoading(false) }
  }, [scope, workspace])

  useEffect(() => { void reload(); return () => { request.current++ } }, [reload])

  const run = async (fn: () => Promise<unknown>) => {
    if (running.current) return false
    running.current = true
    setMutating(true)
    setError(null)
    try { await fn(); setDetails(null); await reload(); return true }
    catch (e: any) { setError(e?.message ?? String(e)); return false }
    finally { running.current = false; setMutating(false) }
  }

  const showHistory = async (entry: CodeyMemoryItem) => {
    setError(null)
    try { setDetails(unwrap(await window.codey.memory.codey.details(scope, workspace, entry.id))) }
    catch (e: any) { setError(e?.message ?? String(e)) }
  }

  const add = async () => {
    if (adding || !draft.trim()) return
    setAdding(true)
    try {
      if (await run(async () => { unwrap(await window.codey.memory.codey.add(scope, workspace, draft)) })) setDraft('')
    } finally { setAdding(false) }
  }

  return (
    <div style={{ padding: 16, background: C.surface2, border: `1px solid ${C.border}`, borderRadius: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <div>
          {title && <div style={{ fontSize: 14, fontWeight: 600 }}>{title}</div>}
          <div style={{ color: C.fg3, fontSize: 11, marginTop: title ? 2 : 0 }}>{description}</div>
        </div>
        <button onClick={() => void reload()} disabled={loading} style={smallButton()}>
          {loading ? 'Reading…' : '↻ Refresh'}
        </button>
      </div>

      {error && (
        <div style={{ background: C.red + '22', color: C.red, padding: 8, borderRadius: 6, fontSize: 12, marginBottom: 8 }}>{error}</div>
      )}

      {banner}
      <button style={smallButton()} onClick={() => void run(async () => {
        unwrap(await window.codey.memory.codey.openConsole(scope, workspace))
      })}>Open Co-memo console</button>
      <nav aria-label="Memory views" style={{ display: 'flex', gap: 8, margin: '12px 0' }}>
        {(['active', 'archived', 'conflicts'] as const).map(tab => <button key={tab} aria-pressed={view === tab} onClick={() => { setView(tab); setDetails(null) }}>
          {tab} ({tab === 'active' ? entries.length : tab === 'archived' ? archived.length : conflicts.length})
        </button>)}
      </nav>
      {details && <MemoryHistory details={details} onClose={() => setDetails(null)} />}
      {view === 'archived' && <ArchivedMemories entries={archived} busy={mutating} history={entry => void showHistory(entry)} restore={entry => void run(async () => {
        unwrap(await window.codey.memory.codey.restore(scope, workspace, entry.id, entry.version!))
      })} />}
      {view === 'conflicts' && <section aria-label="Memory conflicts">
        {!conflicts.length && <p>No unresolved conflicts.</p>}
        {conflicts.map(conflict => <MemoryConflictCard key={conflict.revision} conflict={conflict} busy={mutating} resolve={choice => void run(async () => {
          unwrap(await window.codey.memory.codey.resolve(scope, workspace, conflict.id, conflict.revision, choice))
        })} />)}
      </section>}
      {notice && <p role="status" style={{ fontSize: 12 }}>{notice}</p>}
      {legacyCount > 0 && <div style={{ marginBottom: 12, color: C.fg3, fontSize: 12 }}>
        {legacyCount} previous Codey memories are available. Original files will be kept.
        <button disabled={loading || adding || mutating} style={smallButton()} onClick={() => void run(async () => {
          setAdding(true)
          try {
            const result = unwrap(await window.codey.memory.codey.importLegacy(scope, workspace))
            setNotice(`Imported ${result.imported}; skipped ${result.skipped}. ${result.errors.join(' ')}`)
          } finally { setAdding(false) }
        })}>Import into Co-memo</button>
      </div>}

      {view === 'active' && <div>
        <textarea
          value={draft}
          onChange={e => setDraft(e.target.value)}
          spellCheck={false}
          placeholder="Add something Codey should remember here…"
          style={{
            width: '100%', minHeight: 60, resize: 'vertical', boxSizing: 'border-box',
            background: C.bg, color: C.fg, border: `1px solid ${C.border2}`, borderRadius: 6,
            padding: 8, fontSize: 12, outline: 'none',
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          }}
        />
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 6 }}>
          <button
            onClick={() => void add()}
            disabled={adding || mutating || !draft.trim()}
            style={{ ...smallButton(), color: C.accent, borderColor: C.accent, opacity: (adding || !draft.trim()) ? 0.5 : 1 }}
          >{adding ? 'Saving…' : 'Save'}</button>
        </div>
      </div>}

      {view === 'active' && entries.length > 0 && (
        <div style={{ marginTop: 4 }}>
          {entries.map(entry => (
            <EntryRow
              key={entry.id}
              entry={entry}
              disabled={mutating}
              onHistory={() => void showHistory(entry)}
              onSave={content => run(async () => { unwrap(await window.codey.memory.codey.update(scope, workspace, entry.id, content, entry.version!)) })}
              onRemove={async () => { await run(async () => { unwrap(await window.codey.memory.codey.remove(scope, workspace, entry.id, entry.version!)) }) }}
            />
          ))}
        </div>
      )}
    </div>
  )
}

/** What Codey remembers about one workspace. */
export const CodeyMemorySection: React.FC<{ workspace: string }> = ({ workspace }) => {
  const [targets, setTargets] = useState<Array<{ id: string; label: string; path: string }>>([])
  const [selected, setSelected] = useState(workspace)
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    setSelected(workspace)
    setTargets([])
    setError('')
    window.codey.memory.codey.targets(workspace).then(result => {
      const next = unwrap(result)
      if (active) setTargets(next)
    }).catch(e => { if (active) setError(e.message) })
    return () => { active = false }
  }, [workspace])
  const target = targets.find(t => t.id === selected)
  return <div>
    {error && <p role="alert">{error}</p>}
    <label>Project directory <select aria-label="Memory project directory" value={selected} onChange={e => setSelected(e.target.value)}>
      {!targets.length && <option value={workspace}>{workspace}</option>}
      {targets.map(t => <option key={t.id} value={t.id}>{t.label} — {t.path}</option>)}
    </select></label>
    <MemoryPanel key={selected} scope="workspace" workspace={selected} title="Shared memory"
      description={target ? `Co-memo project: ${target.path}` : 'Project facts and decisions stored in Co-memo.'} />
  </div>
}

/** The two switches that decide whether Codey remembers anything at all. */
export const CodeyMemorySettings: React.FC = () => {
  const [enabled, setEnabled] = useState(true)
  const [autoExtract, setAutoExtract] = useState(true)
  const [paused, setPaused] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void (async () => {
      try {
        const s = unwrap(await window.codey.memory.codey.settings())
        setEnabled(s.enabled)
        setAutoExtract(s.autoExtract)
        setPaused(s.paused ?? false)
      } catch (e: any) { setError(e?.message ?? String(e)) }
    })()
  }, [])

  const patch = async (next: { enabled?: boolean; autoExtract?: boolean }) => {
    setError(null)
    const prev = { enabled, autoExtract }
    if (next.enabled !== undefined) setEnabled(next.enabled)
    if (next.autoExtract !== undefined) setAutoExtract(next.autoExtract)
    try {
      const s = unwrap(await window.codey.memory.codey.setSettings(next))
      setEnabled(s.enabled)
      setAutoExtract(s.autoExtract)
      setPaused(s.paused ?? false)
    } catch (e: any) {
      setEnabled(prev.enabled)
      setAutoExtract(prev.autoExtract)
      setError(e?.message ?? String(e))
    }
  }

  const row = (
    title: string,
    hint: string,
    on: boolean,
    onChange: (v: boolean) => void,
    disabled?: boolean,
  ) => (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '5px 0', opacity: disabled ? 0.5 : 1 }}>
      <div>
        <div style={{ color: C.fg, fontSize: 13 }}>{title}</div>
        <div style={{ color: C.fg3, fontSize: 11, marginTop: 2 }}>{hint}</div>
      </div>
      <Toggle on={on} onChange={v => { if (!disabled) onChange(v) }} label={title} />
    </div>
  )

  return (
    <div style={{ padding: '12px 16px', background: C.surface2, border: `1px solid ${C.border}`, borderRadius: 8, marginBottom: 12 }}>
      {error && (
        <div style={{ background: C.red + '22', color: C.red, padding: 8, borderRadius: 6, fontSize: 12, marginBottom: 8 }}>{error}</div>
      )}
      {paused && <p>Co-memo is paused. Resume it in Co-memo to read or save memories.</p>}
      {row('Use memory in prompts', 'Controls memory that Codey adds to new prompts; existing sessions and agent hooks may already contain notes.', enabled, v => void patch({ enabled: v }))}
      {row('Allow automatic memory saves', 'Applies to connected Co-memo agents. Agents select durable information. Playbook learning has its own Skills settings.', autoExtract, v => void patch({ autoExtract: v }), !enabled)}
    </div>
  )
}
