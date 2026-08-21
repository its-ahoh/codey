import React, { useCallback, useEffect, useState } from 'react'
import { C } from '../theme'
import { Toggle, unwrap } from './settingsAtoms'
import type { CodeyMemoryItem, MemoryStoreScope } from '../codey-api'

/**
 * Codey's own memory: the entries it injects into prompts. Two scopes share
 * this panel — the user-global store (`~/.codey/memory`), which applies in
 * every project, and a workspace's own store. The global store had no UI at
 * all before: only `/remember --global` in chat could write to it, so it sat
 * empty.
 *
 * These live in the store's `index.json`. The `memory.md` beside it is a
 * rendered view the store rewrites whenever an entry changes, which is why
 * this panel edits entries rather than that file — text typed into the old
 * memory.md editor was silently overwritten by the next recorded entry.
 */

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
  onSave: (content: string) => Promise<void>
  onRemove: () => Promise<void>
}> = ({ entry, onSave, onRemove }) => {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(entry.content)
  const [busy, setBusy] = useState(false)

  useEffect(() => { setDraft(entry.content) }, [entry.content])

  const save = async () => {
    if (busy || draft.trim() === entry.content.trim()) { setEditing(false); return }
    setBusy(true)
    try { await onSave(draft); setEditing(false) } finally { setBusy(false) }
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
        <button onClick={() => setEditing(e => !e)} style={smallButton()}>{editing ? 'Close' : 'Edit'}</button>
        <button onClick={() => void onRemove()} style={smallButton(true)} title="Forget this memory">Forget</button>
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
            <button onClick={() => void save()} disabled={busy} style={{ ...smallButton(), color: C.accent, borderColor: C.accent }}>
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
  title: string
  description: string
  /** Rendered between the header and the composer, e.g. a sharing switch. */
  banner?: React.ReactNode
}

export const MemoryPanel: React.FC<PanelProps> = ({ scope, workspace, title, description, banner }) => {
  const [entries, setEntries] = useState<CodeyMemoryItem[]>([])
  const [draft, setDraft] = useState('')
  const [adding, setAdding] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setEntries(unwrap(await window.codey.memory.codey.list(scope, workspace)).entries)
    } catch (e: any) { setError(e?.message ?? String(e)) } finally { setLoading(false) }
  }, [scope, workspace])

  useEffect(() => { void reload() }, [reload])

  const run = async (fn: () => Promise<unknown>) => {
    setError(null)
    try { await fn(); await reload() } catch (e: any) { setError(e?.message ?? String(e)) }
  }

  const add = async () => {
    if (adding || !draft.trim()) return
    setAdding(true)
    try {
      await run(async () => { unwrap(await window.codey.memory.codey.add(scope, workspace, draft)) })
      setDraft('')
    } finally { setAdding(false) }
  }

  return (
    <div style={{ padding: 16, background: C.surface2, border: `1px solid ${C.border}`, borderRadius: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 600 }}>{title}</div>
          <div style={{ color: C.fg3, fontSize: 11, marginTop: 2 }}>{description}</div>
        </div>
        <button onClick={() => void reload()} disabled={loading} style={smallButton()}>
          {loading ? 'Reading…' : '↻ Refresh'}
        </button>
      </div>

      {error && (
        <div style={{ background: C.red + '22', color: C.red, padding: 8, borderRadius: 6, fontSize: 12, marginBottom: 8 }}>{error}</div>
      )}

      {banner}

      <div>
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
            disabled={adding || !draft.trim()}
            style={{ ...smallButton(), color: C.accent, borderColor: C.accent, opacity: (adding || !draft.trim()) ? 0.5 : 1 }}
          >{adding ? 'Saving…' : 'Remember'}</button>
        </div>
      </div>

      {entries.length === 0 && !loading ? (
        <div style={{ color: C.fg3, fontSize: 12, marginTop: 8 }}>Nothing remembered yet.</div>
      ) : (
        <div style={{ marginTop: 4 }}>
          {entries.map(entry => (
            <EntryRow
              key={entry.id}
              entry={entry}
              onSave={async content => { unwrap(await window.codey.memory.codey.update(scope, workspace, entry.id, content)); await reload() }}
              onRemove={async () => { unwrap(await window.codey.memory.codey.remove(scope, workspace, entry.id)); await reload() }}
            />
          ))}
        </div>
      )}
    </div>
  )
}

/** What Codey remembers about one workspace. */
export const CodeyMemorySection: React.FC<{ workspace: string }> = ({ workspace }) => (
  <MemoryPanel
    scope="workspace"
    workspace={workspace}
    title="Memory"
    description="What Codey remembers about this workspace and adds to its prompts."
  />
)

/** The two switches that decide whether Codey remembers anything at all. */
export const CodeyMemorySettings: React.FC = () => {
  const [enabled, setEnabled] = useState(true)
  const [autoExtract, setAutoExtract] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void (async () => {
      try {
        const s = unwrap(await window.codey.memory.codey.settings())
        setEnabled(s.enabled)
        setAutoExtract(s.autoExtract)
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
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginTop: 10, opacity: disabled ? 0.5 : 1 }}>
      <div>
        <div style={{ color: C.fg, fontSize: 13 }}>{title}</div>
        <div style={{ color: C.fg3, fontSize: 11, marginTop: 2 }}>{hint}</div>
      </div>
      <Toggle on={on} onChange={v => { if (!disabled) onChange(v) }} label={title} />
    </div>
  )

  return (
    <div style={{ padding: 16, background: C.surface2, border: `1px solid ${C.border}`, borderRadius: 8, marginBottom: 12 }}>
      <div style={{ fontSize: 14, fontWeight: 600 }}>Codey memory</div>
      {error && (
        <div style={{ background: C.red + '22', color: C.red, padding: 8, borderRadius: 6, fontSize: 12, marginTop: 8 }}>{error}</div>
      )}
      {row('Use memory in prompts', 'Off means nothing remembered is sent to the agents.', enabled, v => void patch({ enabled: v }))}
      {row('Record memories automatically', 'Off means only what you add by hand is kept.', autoExtract, v => void patch({ autoExtract: v }), !enabled)}
    </div>
  )
}
