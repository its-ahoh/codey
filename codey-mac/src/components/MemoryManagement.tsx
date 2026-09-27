import React, { useEffect, useState } from 'react'
import type { CodeyMemoryItem, CoMemoConflictView, CoMemoDetails } from '../codey-api'
import './memory.css'

export function MemoryHistory({ details, onClose }: { details: CoMemoDetails; onClose: () => void }) {
  return <section className="memory-detail" aria-label="Memory history">
    <div className="memory-header"><div><h4 className="memory-title">Version history</h4><p className="memory-hint">Previous versions are kept for reference.</p></div><button className="memory-button quiet" onClick={onClose}>Close</button></div>
    <div className="memory-versions">{[...details.history].sort((a, b) => b.version - a.version).map(note => <article className="memory-version" key={note.version}>
      <div className="memory-meta"><strong>Version {note.version}</strong>{note.deleted && <span className="memory-badge">Archived</span>}<span>{new Date(note.updatedAt).toLocaleString()}</span></div>
      <p className="memory-body">{note.content}</p>
    </article>)}</div>
    {!details.history.length && <p className="memory-hint">No revisions available.</p>}
  </section>
}

function ArchivedCard({ entry, busy, restore, history, purge }: { entry: CodeyMemoryItem; busy: boolean; restore: () => void; history: () => void; purge?: () => void }) {
  const [confirm, setConfirm] = useState(false)
  useEffect(() => { setConfirm(false) }, [entry.version])
  return <article className="memory-card">
    <div className="memory-meta"><span className="memory-badge">{entry.type}</span><span>Archived</span></div>
    <p className="memory-body">{entry.content}</p>
    <div className="memory-actions"><button className="memory-button quiet" disabled={busy} onClick={history}>History</button><button className="memory-button" disabled={busy} onClick={restore}>Restore</button>{purge && <button className="memory-button quiet danger" disabled={busy} onClick={() => setConfirm(true)}>Delete…</button>}</div>
    {confirm && <div className="memory-confirm" role="alert"><strong>Delete this memory permanently?</strong><p className="memory-hint">The memory and its version history will be removed. This cannot be undone.</p><div className="memory-actions"><button className="memory-button" disabled={busy} onClick={() => setConfirm(false)}>Keep memory</button><button className="memory-button danger" disabled={busy} onClick={purge}>Delete permanently</button></div></div>}
  </article>
}
export function ArchivedMemories({ entries, busy, restore, history, purge }: {
  entries: CodeyMemoryItem[]; busy: boolean; restore: (entry: CodeyMemoryItem) => void; history: (entry: CodeyMemoryItem) => void; purge?: (entry: CodeyMemoryItem) => void
}) {
  return <section className="memory-list" aria-label="Archived memories">
    {!entries.length && <div className="memory-empty">No archived memories.</div>}
    {entries.map(entry => <ArchivedCard key={entry.id} entry={entry} busy={busy} restore={() => restore(entry)} history={() => history(entry)} purge={purge ? () => purge(entry) : undefined} />)}
  </section>
}

export function MemoryConflictCard({ conflict, busy, resolve }: {
  conflict: CoMemoConflictView; busy: boolean; resolve: (choice: { take: string } | { content: string }) => void
}) {
  const [merged, setMerged] = useState('')
  const options = [
    { id: 'current', label: `Current version ${conflict.currentVersion}`, content: conflict.currentContent },
    ...conflict.proposals.map(p => ({ id: p.replicaId, label: `${p.agent ?? 'Agent file'} proposal`, content: p.content })),
    ...conflict.candidates.map(c => ({ id: c.id, label: 'Suggested replacement', content: c.content })),
  ]
  return <article className="memory-card">
    <h4 className="memory-title">Review conflicting versions</h4>
    <p className="memory-hint">This memory is excluded from recall until you choose a version or save a merge.</p>
    <div className="memory-conflict-options">{options.map(option => <div className="memory-card" key={option.id}>
      <div className="memory-meta"><strong>{option.label}</strong></div><p className="memory-body">{option.content ?? '(Archived)'}</p>
      <div className="memory-actions"><button className="memory-button" disabled={busy} onClick={() => resolve({ take: option.id })}>Use {option.label.toLowerCase()}</button></div>
    </div>)}</div>
    <label className="memory-hint">Or combine the versions<textarea className="memory-input" disabled={busy} aria-label="Merged memory content" placeholder="Write the version to keep…" value={merged} maxLength={32000} onChange={e => setMerged(e.target.value)} /></label>
    <div className="memory-actions"><button className="memory-button primary" disabled={busy || !merged.trim()} onClick={() => resolve({ content: merged })}>Save merge</button></div>
  </article>
}
