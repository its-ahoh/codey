import React, { useCallback, useEffect, useId, useRef, useState } from 'react'
import { ArchivedMemories, MemoryConflictCard, MemoryHistory } from './MemoryManagement'
import { unwrap } from './settingsAtoms'
import { UIIcon } from './UIIcons'
import type { CodeyMemoryItem, MemoryPanelScope, CoMemoConflictView, CoMemoDetails } from '../codey-api'
import './memory.css'

const message = (error: unknown) => (error instanceof Error ? error.message : String(error)).replace(/co-memo/gi, 'Memory service')
const relative = (ms: number) => {
  const days = Math.floor(Math.max(0, Date.now() - ms) / 86400000)
  return days ? `${days}d ago` : 'Today'
}

function MemoryToggle({ on, disabled, label, onChange }: { on: boolean; disabled: boolean; label: string; onChange: (value: boolean) => void }) {
  return <button type="button" role="switch" aria-checked={on} aria-label={label} className="memory-switch" disabled={disabled} onClick={() => onChange(!on)}><span /></button>
}

function EntryRow({ entry, disabled, onHistory, onSave, onRemove }: {
  entry: CodeyMemoryItem; disabled: boolean; onHistory: () => void
  onSave: (content: string, version: number) => Promise<boolean>; onRemove: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(entry.content)
  const [version, setVersion] = useState(entry.version!)
  const edit = () => { setDraft(entry.content); setVersion(entry.version!); setEditing(true) }
  return <article className="memory-card">
    <div className="memory-meta"><span className="memory-badge">{entry.type}</span><span title={new Date(entry.updatedAt).toLocaleString()}>{relative(entry.updatedAt)}</span></div>
    {editing ? <div>
      <textarea aria-label="Edit memory" className="memory-input" disabled={disabled} value={draft} maxLength={32000} onChange={e => setDraft(e.target.value)} />
      {entry.version !== version && <p className="memory-hint">This memory changed while you were editing. Cancel to load the latest version.</p>}
      <div className="memory-actions"><button className="memory-button quiet" disabled={disabled} onClick={() => setEditing(false)}>Cancel</button><button className="memory-button primary" disabled={disabled || !draft.trim() || entry.version !== version} onClick={async () => { if (await onSave(draft, version)) setEditing(false) }}>Save changes</button></div>
    </div> : <>
      <button className="memory-preview" aria-expanded={expanded} onClick={() => setExpanded(!expanded)} title={expanded ? 'Collapse memory' : 'Read full memory'}><p className={`memory-body ${expanded ? '' : 'collapsed'}`}>{entry.content}</p></button>
      <div className="memory-actions"><button className="memory-button quiet" disabled={disabled} onClick={onHistory}>History</button><button className="memory-button" disabled={disabled} onClick={edit}>Edit</button><button className="memory-button quiet" disabled={disabled} onClick={onRemove} title="Keep this memory in the archive">Archive</button></div>
    </>}
  </article>
}

interface PanelProps { scope: MemoryPanelScope; workspace?: string; title?: string; description: string }
export function MemoryPanel({ scope, workspace, title, description }: PanelProps) {
  const composerId = useId()
  const [entries, setEntries] = useState<CodeyMemoryItem[]>([])
  const [archived, setArchived] = useState<CodeyMemoryItem[]>([])
  const [conflicts, setConflicts] = useState<CoMemoConflictView[]>([])
  const [view, setView] = useState<'active' | 'archived' | 'conflicts'>('active')
  const [query, setQuery] = useState('')
  const [details, setDetails] = useState<CoMemoDetails | null>(null)
  const [composing, setComposing] = useState(false)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [paused, setPaused] = useState(false)
  const [pausedByUser, setPausedByUser] = useState(false)
  const [error, setError] = useState('')
  const running = useRef(false)
  const request = useRef(0)
  const historyRequest = useRef(0)
  const reload = useCallback(async () => {
    const generation = ++request.current
    setLoading(true); setError('')
    try {
      const data = unwrap(await window.codey.memory.codey.list(scope, workspace))
      if (generation !== request.current) return
      setEntries(data.entries); setArchived(data.archived); setConflicts(data.conflicts)
      setPaused(data.paused ?? false); setPausedByUser(data.pausedByUser ?? false)
    } catch (e) { if (generation === request.current) setError(message(e)) }
    finally { if (generation === request.current) setLoading(false) }
  }, [scope, workspace])
  useEffect(() => {
    void reload()
    const refresh = () => { historyRequest.current++; setDetails(null); void reload() }
    window.addEventListener('memory-settings-changed', refresh)
    return () => { request.current++; historyRequest.current++; window.removeEventListener('memory-settings-changed', refresh) }
  }, [reload])
  const run = async (fn: () => Promise<unknown>) => {
    if (running.current) return false
    running.current = true; setBusy(true); setError(''); historyRequest.current++; setDetails(null)
    try { await fn(); await reload(); return true }
    catch (e) { setError(message(e)); return false }
    finally { running.current = false; setBusy(false) }
  }
  const showHistory = async (entry: CodeyMemoryItem) => {
    const generation = ++historyRequest.current
    setError(''); setDetails(null)
    try {
      const data = unwrap(await window.codey.memory.codey.details(scope, workspace, entry.id))
      if (generation === historyRequest.current) setDetails(data)
    } catch (e) { if (generation === historyRequest.current) setError(message(e)) }
  }
  const matches = (content: string) => content.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())
  const visible = entries.filter(e => matches(e.content))
  const visibleArchive = archived.filter(e => matches(e.content))
  const visibleConflicts = conflicts.filter(c => [c.currentContent, ...c.proposals.map(p => p.content), ...c.candidates.map(p => p.content)].some(content => matches(content ?? '')))
  return <section className="memory-panel" aria-label={title ?? 'Personal memory'}>
    <div className="memory-header"><div><h3 className="memory-title">{title ?? 'Personal memory'}</h3><p className="memory-hint">{description}</p></div><button className="memory-button quiet" disabled={loading || busy} onClick={() => void reload()}><UIIcon name="refresh" size={13} />{loading ? 'Loading…' : 'Refresh'}</button></div>
    {error && <div className="memory-alert" role="alert">{error}</div>}
    {paused ? <div className="memory-notice">Memory is paused. Your saved notes are kept.
      {pausedByUser ? <p className="memory-hint">Resume memory in Settings → Memory.</p> : <div className="memory-actions"><button className="memory-button" disabled={busy} onClick={() => void run(async () => { unwrap(await window.codey.memory.codey.setPaused(scope, workspace, false)) })}>Resume project memory</button></div>}
    </div> : <>
      <div className="memory-toolbar"><nav className="memory-tabs" aria-label="Memory views">{(['active', 'archived', 'conflicts'] as const).map(tab => <button key={tab} aria-pressed={view === tab} onClick={() => { setView(tab); historyRequest.current++; setDetails(null) }}>{tab === 'active' ? 'Saved' : tab === 'archived' ? 'Archived' : 'Conflicts'}<span className="memory-count">{tab === 'active' ? entries.length : tab === 'archived' ? archived.length : conflicts.length}</span></button>)}</nav>
        <button className="memory-button primary" disabled={busy || loading} onClick={() => { setView('active'); setComposing(true) }}>+ Add memory</button></div>
      <input className="memory-input memory-search" type="search" aria-label="Search memories" placeholder="Search memories…" value={query} onChange={e => setQuery(e.target.value)} />
      {view === 'active' && composing && <form className="memory-composer" onSubmit={async e => { e.preventDefault(); if (!draft.trim()) return; if (await run(async () => { unwrap(await window.codey.memory.codey.add(scope, workspace, draft)) })) { setDraft(''); setComposing(false) } }}>
        <label className="memory-meta" htmlFor={composerId}>What should Codey remember?</label><textarea autoFocus className="memory-input" id={composerId} placeholder="A preference, project decision, or useful fact…" value={draft} disabled={busy} maxLength={32000} onChange={e => setDraft(e.target.value)} />
        <div className="memory-actions"><span className="memory-hint">{draft.length.toLocaleString()} / 32,000</span><button type="button" className="memory-button quiet" disabled={busy} onClick={() => setComposing(false)}>Cancel</button><button className="memory-button primary" disabled={busy || !draft.trim()}>{busy ? 'Saving…' : 'Save memory'}</button></div>
      </form>}
      {details && <MemoryHistory details={details} onClose={() => { historyRequest.current++; setDetails(null) }} />}
      {loading && !entries.length && !archived.length && !conflicts.length ? <div className="memory-empty" role="status">Loading your memories…</div> : <>
        {view === 'active' && <div className="memory-list" role="region" aria-label="Saved memories" tabIndex={0}>{!visible.length && <div className="memory-empty">{query ? 'No memories match your search.' : 'No saved memories yet. Add a preference or a useful fact to get started.'}</div>}{visible.map(entry => <EntryRow key={entry.id} entry={entry} disabled={busy} onHistory={() => void showHistory(entry)} onSave={(content, version) => run(async () => { unwrap(await window.codey.memory.codey.update(scope, workspace, entry.id, content, version)) })} onRemove={() => void run(async () => { unwrap(await window.codey.memory.codey.remove(scope, workspace, entry.id, entry.version!)) })} />)}</div>}
        {view === 'archived' && <ArchivedMemories entries={visibleArchive} busy={busy} history={entry => void showHistory(entry)} restore={entry => void run(async () => { unwrap(await window.codey.memory.codey.restore(scope, workspace, entry.id, entry.version!)) })} purge={entry => void run(async () => { unwrap(await window.codey.memory.codey.purge(scope, workspace, entry.id, entry.version!)) })} />}
        {view === 'conflicts' && <div className="memory-list" role="region" aria-label="Memory conflicts" tabIndex={0}>{!visibleConflicts.length && <div className="memory-empty">{query ? 'No conflicts match your search.' : 'All clear. No conflicting memories.'}</div>}{visibleConflicts.map(conflict => <MemoryConflictCard key={conflict.revision} conflict={conflict} busy={busy} resolve={choice => void run(async () => { unwrap(await window.codey.memory.codey.resolve(scope, workspace, conflict.id, conflict.revision, choice)) })} />)}</div>}
      </>}
    </>}
  </section>
}

export function CodeyMemorySection({ workspace }: { workspace: string }) {
  const [targets, setTargets] = useState<Array<{ id: string; label: string; path: string }>>([])
  const [selected, setSelected] = useState(workspace)
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    setSelected(workspace); setTargets([]); setError('')
    window.codey.memory.codey.targets(workspace).then(result => { if (active) setTargets(unwrap(result)) }).catch(e => { if (active) setError(message(e)) })
    return () => { active = false }
  }, [workspace])
  const target = targets.find(t => t.id === selected)
  return <div>
    {error && <div className="memory-alert" role="alert">{error}</div>}
    <div className="memory-project"><label htmlFor={`memory-directory-${workspace}`}>Project directory</label><select id={`memory-directory-${workspace}`} value={selected} onChange={e => setSelected(e.target.value)}>{!targets.length && <option value={workspace}>{workspace}</option>}{targets.map(t => <option key={t.id} value={t.id}>{t.label} — {t.path}</option>)}</select></div>
    <MemoryPanel key={`${workspace}:${selected}`} scope="workspace" workspace={selected} title="Project memory" description={target?.path ?? 'Facts and decisions for this project.'} />
  </div>
}

export function CodeyMemorySettings() {
  const [settings, setSettings] = useState({ enabled: true, autoExtract: true, paused: false })
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState('')
  const running = useRef(false)
  useEffect(() => { let active = true; window.codey.memory.codey.settings().then(result => { if (active) { const data = unwrap(result); setSettings({ ...data, paused: data.paused ?? false }) } }).catch(e => { if (active) setError(message(e)) }).finally(() => { if (active) setBusy(false) }); return () => { active = false } }, [])
  const patch = async (next: Partial<typeof settings>) => {
    if (running.current) return
    running.current = true; setBusy(true); setError('')
    try { const data = unwrap(await window.codey.memory.codey.setSettings(next)); setSettings({ ...data, paused: data.paused ?? false }); window.dispatchEvent(new Event('memory-settings-changed')) }
    catch (e) { setError(message(e)) }
    finally { running.current = false; setBusy(false) }
  }
  return <section className="memory-panel" style={{ marginBottom: 12 }} aria-label="Memory settings">
    {error && <div className="memory-alert" role="alert">{error}</div>}
    <div className="memory-header"><div><h3 className="memory-title">Memory settings</h3><p className="memory-hint">Choose how Codey remembers and uses what it learns.</p></div><button className="memory-button" disabled={busy} onClick={() => void patch({ paused: !settings.paused })}>{settings.paused ? 'Resume memory' : 'Pause memory'}</button></div>
    {settings.paused && <div className="memory-notice">Memory is paused. Reading and saving will resume when you turn it back on.</div>}
    <div aria-busy={busy} style={{ opacity: busy || settings.paused ? .5 : 1, pointerEvents: busy || settings.paused ? 'none' : undefined }}>
      <div className="memory-setting"><div><div>Use memory in conversations</div><p className="memory-hint">Include relevant preferences and project facts in new prompts.</p></div><MemoryToggle disabled={busy || settings.paused} on={settings.enabled} label="Use memory in conversations" onChange={enabled => { if (!busy && !settings.paused) void patch({ enabled }) }} /></div>
      <div className="memory-setting"><div><div>Save useful information automatically</div><p className="memory-hint">Keep durable preferences and decisions. You can still save memories manually.</p></div><MemoryToggle disabled={busy || settings.paused} on={settings.autoExtract} label="Save useful information automatically" onChange={autoExtract => { if (!busy && !settings.paused) void patch({ autoExtract }) }} /></div>
    </div>
  </section>
}
