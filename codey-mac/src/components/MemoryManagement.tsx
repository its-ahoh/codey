import React, { useState } from 'react'
import type { CodeyMemoryItem, CoMemoConflictView, CoMemoDetails } from '../codey-api'
import { C } from '../theme'

const text: React.CSSProperties = { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: 12 }

export function MemoryHistory({ details, onClose }: { details: CoMemoDetails; onClose: () => void }) {
  return <section aria-label="Memory history">
    <h4>Version history <button onClick={onClose}>Close</button></h4>
    {[...details.history].sort((a, b) => b.version - a.version).map(note => <article key={note.version}>
      <strong>Version {note.version}{note.deleted ? ' · Archived' : ''}</strong>
      <span> · {new Date(note.updatedAt).toLocaleString()}</span>
      <p style={text}>{note.content}</p>
    </article>)}
    {!details.history.length && <p>No revisions available.</p>}
  </section>
}

export function ArchivedMemories({ entries, busy, restore, history }: {
  entries: CodeyMemoryItem[]; busy: boolean; restore: (entry: CodeyMemoryItem) => void; history: (entry: CodeyMemoryItem) => void
}) {
  return <section aria-label="Archived memories">
    {!entries.length && <p>No archived memories.</p>}
    {entries.map(entry => <article key={entry.id}>
      <p style={text}>{entry.content}</p>
      <button disabled={busy} onClick={() => restore(entry)}>Restore</button>{' '}
      <button disabled={busy} onClick={() => history(entry)}>History</button>
    </article>)}
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
  return <article style={{ borderTop: `1px solid ${C.border}`, padding: '12px 0' }}>
    <h4>Conflicting memory</h4>
    <p>This memory is withheld from recall until you choose a version or save a merge.</p>
    {options.map(option => <div key={option.id}>
      <strong>{option.label}</strong>
      <p style={text}>{option.content ?? '(Archived)'}</p>
      <button disabled={busy} onClick={() => resolve({ take: option.id })}>Use {option.label.toLowerCase()}</button>
    </div>)}
    <label>Merged content<textarea aria-label="Merged memory content" value={merged} onChange={e => setMerged(e.target.value)} style={{ width: '100%', minHeight: 80 }} /></label>
    <button disabled={busy || !merged.trim()} onClick={() => resolve({ content: merged })}>Save merge</button>
  </article>
}
