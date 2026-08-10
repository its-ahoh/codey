import React, { useMemo, useRef, useState, useEffect } from 'react'
import { C } from '../theme'
import { useGitBranches } from '../hooks/useGitBranches'
import { compactWorktreePath, currentFirst, defaultWorktreePath, filterBranches, partitionWorktrees } from './branchPickerModel'
import { UIIcon } from './UIIcons'

interface Props {
  workingDir: string | undefined
  repoRoot: string | undefined           // for default worktree path; falls back to workingDir
  boundWorktreePath?: string             // chat.workingDirOverride
  gitContext?: { branch: string; worktreePath: string }
  onBindWorktree: (path: string | null) => void
  onOpenTerminal?: () => void
}

type Mode = { kind: 'list' } | { kind: 'create' } | { kind: 'dirty'; target: string }
type PickerView = 'branches' | 'worktrees'

export const BranchPicker: React.FC<Props> = ({ workingDir, repoRoot, boundWorktreePath, gitContext, onBindWorktree, onOpenTerminal }) => {
  const git = useGitBranches(workingDir)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [view, setView] = useState<PickerView>('branches')
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
  const localFiltered = useMemo(
    () => currentFirst(filterBranches(s?.local ?? [], query), branch => branch === s?.branch),
    [s, query],
  )
  const remoteFiltered = useMemo(() => filterBranches(s?.remote ?? [], query), [s, query])
  const repo = repoRoot || workingDir || ''
  const worktreePath = gitContext?.worktreePath || boundWorktreePath || workingDir || ''
  const branchLabel = s?.branch || gitContext?.branch || '—'
  const branchDrift = !!gitContext && !!s?.branch && s.branch !== gitContext.branch
  const orderedWorktrees = useMemo(
    () => currentFirst(
      [...(main ? [main] : []), ...others],
      worktree => boundWorktreePath ? worktree.path === boundWorktreePath : worktree.isMain,
    ),
    [main, others, boundWorktreePath],
  )
  const previewPath = useWorktree && newName ? defaultWorktreePath(repo, newName) : ''

  const copyWorktreePath = async () => {
    const value = worktreePath
    if (!value) return
    try {
      await navigator.clipboard.writeText(value)
      setNote('Worktree path copied')
    } catch {
      setNote('Could not copy worktree path')
    }
  }

  const doSwitch = async (name: string) => {
    const r = await git.checkout(name)
    if (r.ok) { setOpen(false); return }
    if (r.reason === 'dirty') setMode({ kind: 'dirty', target: name })
  }

  const doSwitchRemote = async (b: string) => {
    // `git checkout --track` needs the remote-tracking ref (origin/foo), not the local name.
    const r = await git.checkout(b, { track: true })
    if (r.ok) { setOpen(false); return }
    // On retry after stash, plain `git checkout foo` DWIMs to a tracking branch.
    if (r.reason === 'dirty') setMode({ kind: 'dirty', target: b.replace(/^[^/]+\//, '') })
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
      <button style={styles.pill} onClick={() => setOpen(o => {
        if (!o) {
          setNote(null)
          // A branch may have been created by Codex/Terminal while the app was
          // in the background. Refresh at the moment the user opens the menu
          // instead of relying only on the .git watcher or 5s polling fallback.
          void git.refresh()
        }
        return !o
      })}
        title={worktreePath ? `${branchLabel}\n${worktreePath}` : 'Chat workspace unavailable'}
        aria-label={`Chat workspace: ${branchLabel}, ${worktreePath || 'unavailable'}`}
        aria-expanded={open}
      >
        <UIIcon name="code" size={15} />
        <span style={styles.pillIdentity}>
          <span style={styles.pillBranch}>
            <span style={styles.ellipsis}>{branchLabel}</span>
            {s && s.dirty > 0 && <span style={styles.dirty}>+{s.dirty}</span>}
          </span>
          <span style={styles.pillPath}>{compactWorktreePath(worktreePath)}</span>
        </span>
        <span style={{ ...styles.caret, transform: open ? 'rotate(-90deg)' : 'rotate(90deg)' }}>
          <UIIcon name="chevron" size={12} />
        </span>
      </button>

      {open && (
        <div style={styles.menu}>
          <div style={styles.currentWorkspace}>
            <UIIcon name="workspace" size={15} />
            <div style={styles.currentIdentity}>
              <div style={styles.currentBranch}>{branchLabel}</div>
              <div style={styles.currentPath} title={worktreePath}>{compactWorktreePath(worktreePath)}</div>
            </div>
            <button style={styles.iconButton} onClick={() => void copyWorktreePath()} title="Copy worktree path" aria-label="Copy worktree path">
              <UIIcon name="copy" size={13} />
            </button>
            {onOpenTerminal && (
              <button style={styles.iconButton} onClick={() => { onOpenTerminal(); setOpen(false) }} disabled={!worktreePath} title="Open Terminal here" aria-label="Open Terminal in this worktree">
                <UIIcon name="terminal" size={14} />
              </button>
            )}
          </div>
          {gitContext ? (
            <div style={branchDrift ? styles.driftNote : styles.dedicatedNote}>
              <UIIcon name={branchDrift ? 'activity' : 'check'} size={13} />
              {branchDrift ? `Expected ${gitContext.branch}` : 'Dedicated to this chat'}
            </div>
          ) : (
            <>
              <div style={styles.sharedNote}>Shared workspace</div>
              {mode.kind === 'dirty' ? (
            <div style={styles.section}>
              <div style={styles.warn}>Switching would overwrite local changes.</div>
              <div style={styles.row}>
                <button style={styles.primary} onClick={async () => {
                  const r = await git.stashAndSwitch(mode.target)
                  // Keep the menu open so the stash note is actually visible.
                  if (r.ok) { setNote('Local changes stashed — restore with `git stash pop`'); setMode({ kind: 'list' }) }
                }}>Stash & switch</button>
                <button style={styles.ghost} onClick={() => setMode({ kind: 'list' })}>Cancel</button>
              </div>
            </div>
              ) : mode.kind === 'create' ? (
            <div style={styles.section}>
              <input autoFocus placeholder="new-branch-name" value={newName}
                onChange={e => setNewName(e.target.value)} style={styles.input} />
              <div style={styles.toggle}>
                <button style={useWorktree ? styles.segOn : styles.seg} onClick={() => setUseWorktree(true)}>Worktree</button>
                <button style={!useWorktree ? styles.segOn : styles.seg} onClick={() => setUseWorktree(false)}>Branch</button>
              </div>
              {previewPath && <div style={styles.preview}>{previewPath}</div>}
              <div style={styles.row}>
                <button style={styles.primary} onClick={doCreate}>Create</button>
                <button style={styles.ghost} onClick={() => setMode({ kind: 'list' })}>Cancel</button>
              </div>
            </div>
              ) : (
            <>
              <div style={styles.viewTabs} role="tablist" aria-label="Workspace choices">
                <button role="tab" aria-selected={view === 'branches'} style={view === 'branches' ? styles.viewTabActive : styles.viewTab} onClick={() => setView('branches')}>Branches</button>
                <button role="tab" aria-selected={view === 'worktrees'} style={view === 'worktrees' ? styles.viewTabActive : styles.viewTab} onClick={() => setView('worktrees')}>Worktrees</button>
              </div>
              {view === 'branches' && (
                <input placeholder="Filter branches…" value={query}
                  onChange={e => setQuery(e.target.value)} style={styles.input} />
              )}
              <div style={styles.scroll}>
                {view === 'branches' ? (
                  <>
                    {localFiltered.length > 0 && <div style={styles.divider}>Local</div>}
                    {localFiltered.map(b => (
                      <button key={b} style={styles.item} disabled={b === s?.branch} onClick={() => doSwitch(b)}>
                        <span style={styles.checkSlot}>{b === s?.branch && <UIIcon name="check" size={13} />}</span>{b}
                      </button>
                    ))}
                    {remoteFiltered.length > 0 && <div style={styles.divider}>Remote</div>}
                    {remoteFiltered.map(b => (
                      <button key={b} style={styles.item} onClick={() => doSwitchRemote(b)}>
                        <span style={styles.checkSlot} />{b}
                      </button>
                    ))}
                  </>
                ) : (
                  <>
                    {orderedWorktrees.map(w => {
                      const isCurrent = boundWorktreePath ? w.path === boundWorktreePath : w.isMain
                      return (
                        <button key={w.path} style={styles.worktreeItem} onClick={() => { onBindWorktree(w.isMain ? null : w.path); setOpen(false) }}>
                          <span style={styles.checkSlot}>{isCurrent && <UIIcon name="check" size={13} />}</span>
                          <span style={styles.worktreeIdentity}>
                            <span>{w.branch} {w.isMain && <span style={styles.mainLabel}>main</span>}</span>
                            <span style={styles.worktreePath} title={w.path}>{compactWorktreePath(w.path)}</span>
                          </span>
                        </button>
                      )
                    })}
                    {orderedWorktrees.length === 0 && <div style={styles.empty}>No worktrees found</div>}
                  </>
                )}
              </div>
              {git.error && <div style={styles.err}>{git.error}</div>}
              {note && <div style={styles.noteBox} role="status">{note}</div>}
              <div style={styles.footer}>
                <button style={styles.ghost} onClick={() => { setNewName(''); setUseWorktree(view === 'worktrees'); setMode({ kind: 'create' }) }}>+ New…</button>
                {view === 'branches' && <button style={styles.ghost} onClick={() => git.fetchRemote()}>Fetch</button>}
              </div>
            </>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  pill: { display: 'inline-flex', alignItems: 'center', gap: 7, color: C.fg2, fontSize: 11,
    background: C.surface3, border: `1px solid ${C.border2}`, borderRadius: 7, padding: '5px 8px',
    cursor: 'pointer', flexShrink: 1, minWidth: 150, maxWidth: 310,
    overflow: 'hidden', textAlign: 'left' },
  pillIdentity: { display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0, flex: 1 },
  pillBranch: { display: 'flex', alignItems: 'center', gap: 5, minWidth: 0, fontFamily: 'SF Mono, Menlo, monospace' },
  pillPath: { color: C.fg3, fontSize: 9, fontFamily: 'SF Mono, Menlo, monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  ellipsis: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  dirty: { color: C.yellow, opacity: 0.85 },
  caret: {
    color: C.fg3,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 14,
    height: 14,
    flexShrink: 0,
    transformOrigin: 'center',
    transition: 'transform 0.15s ease',
  },
  menu: { position: 'absolute', top: 'calc(100% + 7px)', left: 0, zIndex: 20, width: 340,
    background: C.surface2, border: `1px solid ${C.border}`, borderRadius: 8,
    boxShadow: '0 14px 30px rgba(0,0,0,0.26)', padding: 8, display: 'flex', flexDirection: 'column', gap: 6 },
  currentWorkspace: { display: 'flex', alignItems: 'center', gap: 7, padding: '6px 7px 8px', borderBottom: `1px solid ${C.border}` },
  currentIdentity: { minWidth: 0, flex: 1 },
  currentBranch: { color: C.fg, fontSize: 11, fontWeight: 600, fontFamily: 'SF Mono, Menlo, monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  currentPath: { color: C.fg3, fontSize: 9, fontFamily: 'SF Mono, Menlo, monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  iconButton: { width: 27, height: 27, padding: 0, border: `1px solid ${C.border2}`, borderRadius: 6, background: C.surface3, color: C.fg2, cursor: 'pointer', display: 'grid', placeItems: 'center', flexShrink: 0 },
  dedicatedNote: { display: 'flex', alignItems: 'center', gap: 6, color: C.green, fontSize: 10, padding: '5px 7px 2px' },
  driftNote: { display: 'flex', alignItems: 'center', gap: 6, color: C.red, fontSize: 10, padding: '5px 7px 2px', fontFamily: 'SF Mono, Menlo, monospace', overflow: 'hidden' },
  sharedNote: { color: C.yellow, fontSize: 9, fontWeight: 600, padding: '3px 7px 0' },
  viewTabs: { display: 'flex', padding: 2, borderRadius: 6, background: C.surface3 },
  viewTab: { flex: 1, border: 'none', borderRadius: 5, padding: '5px 8px', background: 'transparent', color: C.fg3, cursor: 'pointer', fontSize: 11 },
  viewTabActive: { flex: 1, border: `1px solid ${C.border2}`, borderRadius: 5, padding: '4px 8px', background: C.surface2, color: C.fg, cursor: 'pointer', fontSize: 11, fontWeight: 600 },
  section: { display: 'flex', flexDirection: 'column', gap: 8 },
  scroll: { maxHeight: 260, overflowY: 'auto', display: 'flex', flexDirection: 'column' },
  item: { textAlign: 'left', background: 'transparent', border: 'none', color: C.fg, fontSize: 12,
    padding: '6px 8px', borderRadius: 6, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 5 },
  checkSlot: { width: 14, flexShrink: 0, display: 'inline-flex', alignItems: 'center' },
  worktreeItem: { width: '100%', textAlign: 'left', background: 'transparent', border: 'none', color: C.fg, padding: '6px 8px', borderRadius: 6, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 5 },
  worktreeIdentity: { minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1, fontSize: 12 },
  worktreePath: { color: C.fg3, fontSize: 9, fontFamily: 'SF Mono, Menlo, monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  mainLabel: { color: C.fg3, fontSize: 9, fontWeight: 500 },
  empty: { color: C.fg3, fontSize: 11, padding: '14px 8px', textAlign: 'center' },
  divider: { fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.5, color: C.fg3, padding: '8px 8px 2px' },
  input: { background: C.surface3, border: `1px solid ${C.border2}`, borderRadius: 6, color: C.fg,
    fontSize: 12, padding: '5px 8px', outline: 'none' },
  toggle: { display: 'flex', gap: 4 },
  seg: { flex: 1, background: C.surface3, border: `1px solid ${C.border2}`, color: C.fg2, fontSize: 11,
    padding: '5px 6px', borderRadius: 6, cursor: 'pointer' },
  segOn: { flex: 1, background: C.accent, border: `1px solid ${C.accent}`, color: C.onAccent, fontSize: 11,
    padding: '5px 6px', borderRadius: 6, cursor: 'pointer' },
  preview: { fontSize: 10, color: C.fg3, fontFamily: 'SF Mono, Menlo, monospace', wordBreak: 'break-all' },
  row: { display: 'flex', gap: 6 },
  primary: { background: C.accent, color: C.onAccent, border: 'none', borderRadius: 6, padding: '5px 10px', fontSize: 12, cursor: 'pointer' },
  ghost: { background: 'transparent', color: C.fg2, border: `1px solid ${C.border2}`, borderRadius: 6, padding: '5px 10px', fontSize: 12, cursor: 'pointer' },
  footer: { display: 'flex', justifyContent: 'space-between', borderTop: `1px solid ${C.border}`, paddingTop: 6 },
  warn: { fontSize: 12, color: C.yellow },
  err: { fontSize: 11, color: C.red, padding: '2px 4px' },
  noteBox: { fontSize: 11, color: C.fg3, padding: '2px 4px' },
}
