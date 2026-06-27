import React, { useMemo, useRef, useState, useEffect } from 'react'
import { C } from '../theme'
import { useGitBranches } from '../hooks/useGitBranches'
import { filterBranches, defaultWorktreePath, partitionWorktrees } from './branchPickerModel'

interface Props {
  workingDir: string | undefined
  repoRoot: string | undefined           // for default worktree path; falls back to workingDir
  boundWorktreePath?: string             // chat.workingDirOverride
  onBindWorktree: (path: string | null) => void
}

type Mode = { kind: 'list' } | { kind: 'create' } | { kind: 'dirty'; target: string }

export const BranchPicker: React.FC<Props> = ({ workingDir, repoRoot, boundWorktreePath, onBindWorktree }) => {
  const git = useGitBranches(workingDir)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [mode, setMode] = useState<Mode>({ kind: 'list' })
  const [newName, setNewName] = useState('')
  const [useWorktree, setUseWorktree] = useState(true)   // worktree is the DEFAULT
  const [note, setNote] = useState<string | null>(null)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [open])

  const s = git.state
  const { main, others } = useMemo(() => partitionWorktrees(s?.worktrees ?? []), [s])
  const localFiltered = useMemo(() => filterBranches(s?.local ?? [], query), [s, query])
  const remoteFiltered = useMemo(() => filterBranches(s?.remote ?? [], query), [s, query])
  const repo = repoRoot || workingDir || ''
  const previewPath = useWorktree && newName ? defaultWorktreePath(repo, newName) : ''
  const boundLabel = others.find(w => w.path === boundWorktreePath)?.branch

  const doSwitch = async (name: string) => {
    const r = await git.checkout(name)
    if (r.ok) { setOpen(false); return }
    if (r.reason === 'dirty') setMode({ kind: 'dirty', target: name })
  }

  const doCreate = async () => {
    if (!newName.trim()) return
    if (useWorktree) {
      const r = await git.addWorktree(newName.trim(), defaultWorktreePath(repo, newName.trim()))
      if (r.ok && r.path) { onBindWorktree(r.path); setOpen(false) }
    } else {
      const r = await git.createBranch(newName.trim())
      if (r.ok) { setOpen(false) }
    }
  }

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button style={styles.pill} onClick={() => setOpen(o => !o)} title="Branch & worktree">
        <span>⎇ {s?.branch ?? '—'}</span>
        {s && s.dirty > 0 && <span style={styles.dirty}>+{s.dirty}</span>}
        {boundLabel && <span style={styles.wt}>🌳 {boundLabel}</span>}
        <span style={styles.caret}>▾</span>
      </button>

      {open && (
        <div style={styles.menu}>
          {mode.kind === 'dirty' ? (
            <div style={styles.section}>
              <div style={styles.warn}>Switching would overwrite local changes.</div>
              <div style={styles.row}>
                <button style={styles.primary} onClick={async () => {
                  const r = await git.stashAndSwitch(mode.target)
                  if (r.ok) { setNote('Local changes stashed — restore with `git stash pop`'); setMode({ kind: 'list' }); setOpen(false) }
                }}>Stash & switch</button>
                <button style={styles.ghost} onClick={() => setMode({ kind: 'list' })}>Cancel</button>
              </div>
            </div>
          ) : mode.kind === 'create' ? (
            <div style={styles.section}>
              <input autoFocus placeholder="new-branch-name" value={newName}
                onChange={e => setNewName(e.target.value)} style={styles.input} />
              <div style={styles.toggle}>
                <button style={useWorktree ? styles.segOn : styles.seg} onClick={() => setUseWorktree(true)}>In a new worktree</button>
                <button style={!useWorktree ? styles.segOn : styles.seg} onClick={() => setUseWorktree(false)}>On current checkout</button>
              </div>
              {previewPath && <div style={styles.preview}>{previewPath}</div>}
              <div style={styles.row}>
                <button style={styles.primary} onClick={doCreate}>Create</button>
                <button style={styles.ghost} onClick={() => setMode({ kind: 'list' })}>Cancel</button>
              </div>
            </div>
          ) : (
            <>
              <input placeholder="Filter branches…" value={query}
                onChange={e => setQuery(e.target.value)} style={styles.input} />
              <div style={styles.scroll}>
                {localFiltered.map(b => (
                  <button key={b} style={styles.item} disabled={b === s?.branch} onClick={() => doSwitch(b)}>
                    {b === s?.branch ? '✓ ' : ''}{b}
                  </button>
                ))}
                {remoteFiltered.length > 0 && <div style={styles.divider}>Remote</div>}
                {remoteFiltered.map(b => (
                  <button key={b} style={styles.item} onClick={() => git.checkout(b.replace(/^[^/]+\//, ''), { track: true }).then(() => setOpen(false))}>
                    {b}
                  </button>
                ))}
                {others.length > 0 && <div style={styles.divider}>Worktrees</div>}
                {main && (
                  <button style={styles.item} onClick={() => { onBindWorktree(null); setOpen(false) }}>
                    {!boundWorktreePath ? '✓ ' : ''}{main.branch} (main)
                  </button>
                )}
                {others.map(w => (
                  <button key={w.path} style={styles.item} onClick={() => { onBindWorktree(w.path); setOpen(false) }}>
                    {w.path === boundWorktreePath ? '✓ ' : ''}🌳 {w.branch}
                  </button>
                ))}
              </div>
              {git.error && <div style={styles.err}>{git.error}</div>}
              {note && <div style={styles.noteBox}>{note}</div>}
              <div style={styles.footer}>
                <button style={styles.ghost} onClick={() => { setNewName(''); setUseWorktree(true); setMode({ kind: 'create' }) }}>+ New branch…</button>
                <button style={styles.ghost} onClick={() => git.fetchRemote()}>Fetch remote</button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  pill: { display: 'inline-flex', alignItems: 'center', gap: 6, color: C.fg2, fontSize: 11,
    background: C.surface3, border: `1px solid ${C.border2}`, borderRadius: 4, padding: '2px 6px',
    fontFamily: 'SF Mono, Menlo, monospace', cursor: 'pointer', flexShrink: 0, maxWidth: 260,
    overflow: 'hidden', whiteSpace: 'nowrap' },
  dirty: { color: C.yellow, opacity: 0.85 },
  wt: { color: C.green },
  caret: { color: C.fg3 },
  menu: { position: 'absolute', top: 'calc(100% + 4px)', left: 0, zIndex: 20, width: 280,
    background: C.surface2, border: `1px solid ${C.border}`, borderRadius: 8,
    boxShadow: '0 8px 24px rgba(0,0,0,0.35)', padding: 8, display: 'flex', flexDirection: 'column', gap: 6 },
  section: { display: 'flex', flexDirection: 'column', gap: 8 },
  scroll: { maxHeight: 260, overflowY: 'auto', display: 'flex', flexDirection: 'column' },
  item: { textAlign: 'left', background: 'transparent', border: 'none', color: C.fg, fontSize: 12,
    padding: '6px 8px', borderRadius: 6, cursor: 'pointer' },
  divider: { fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.5, color: C.fg3, padding: '8px 8px 2px' },
  input: { background: C.surface3, border: `1px solid ${C.border2}`, borderRadius: 6, color: C.fg,
    fontSize: 12, padding: '5px 8px', outline: 'none' },
  toggle: { display: 'flex', gap: 4 },
  seg: { flex: 1, background: C.surface3, border: `1px solid ${C.border2}`, color: C.fg2, fontSize: 11,
    padding: '5px 6px', borderRadius: 6, cursor: 'pointer' },
  segOn: { flex: 1, background: C.accent, border: `1px solid ${C.accent}`, color: '#fff', fontSize: 11,
    padding: '5px 6px', borderRadius: 6, cursor: 'pointer' },
  preview: { fontSize: 10, color: C.fg3, fontFamily: 'SF Mono, Menlo, monospace', wordBreak: 'break-all' },
  row: { display: 'flex', gap: 6 },
  primary: { background: C.accent, color: '#fff', border: 'none', borderRadius: 6, padding: '5px 10px', fontSize: 12, cursor: 'pointer' },
  ghost: { background: 'transparent', color: C.fg2, border: `1px solid ${C.border2}`, borderRadius: 6, padding: '5px 10px', fontSize: 12, cursor: 'pointer' },
  footer: { display: 'flex', justifyContent: 'space-between', borderTop: `1px solid ${C.border}`, paddingTop: 6 },
  warn: { fontSize: 12, color: C.yellow },
  err: { fontSize: 11, color: C.red, padding: '2px 4px' },
  noteBox: { fontSize: 11, color: C.fg3, padding: '2px 4px' },
}
