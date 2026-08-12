import React, { useEffect, useMemo, useRef, useState } from 'react'
import { C } from '../theme'
import { useGitBranches } from '../hooks/useGitBranches'
import { BranchNote, compactWorktreePath, currentFirst, describePullResult, filterBranches } from './branchPickerModel'
import { UIIcon } from './UIIcons'

interface Props {
  workingDir: string | undefined
  chatWorktree?: { name?: string; path: string }
  executionMode?: 'shared-checkout' | 'isolated-worktree'
  onCreateWorktree: (name: string) => Promise<void>
  onExecutionModeChange: (mode: 'shared-checkout' | 'isolated-worktree') => Promise<void>
}

type Mode = { kind: 'list' } | { kind: 'createBranch' } | { kind: 'createWorktree' } | { kind: 'dirty'; target: string }

export const BranchPicker: React.FC<Props> = ({
  workingDir, chatWorktree, executionMode = 'shared-checkout', onCreateWorktree, onExecutionModeChange,
}) => {
  const git = useGitBranches(workingDir)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [mode, setMode] = useState<Mode>({ kind: 'list' })
  const [newBranchName, setNewBranchName] = useState('')
  const [newWorktreeName, setNewWorktreeName] = useState('')
  const [note, setNote] = useState<BranchNote | null>(null)
  const [changingMode, setChangingMode] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const state = git.state
  const localBranches = useMemo(
    () => currentFirst(filterBranches(state?.local ?? [], query), branch => branch === state?.branch),
    [state, query],
  )
  const remoteBranches = useMemo(() => filterBranches(state?.remote ?? [], query), [state, query])
  const path = workingDir || ''
  const isolated = executionMode === 'isolated-worktree'
  const worktreeLabel = chatWorktree?.name || chatWorktree?.path.split('/').filter(Boolean).pop() || 'Isolated worktree'
  const branchLabel = state?.branch === 'HEAD' ? '—' : (state?.branch ?? '—')
  const pathLabel = compactWorktreePath(path)
  const checkoutLabel = isolated ? worktreeLabel : 'Current checkout'
  // One status line for the whole picker: an explicit note wins, otherwise the
  // last git failure surfaces in the same place instead of at the bottom.
  const banner: BranchNote | null = note ?? (git.error ? { tone: 'error', text: git.error } : null)

  const copyPath = async () => {
    if (!path) return
    try {
      await navigator.clipboard.writeText(path)
      setNote({ tone: 'ok', text: 'Worktree path copied' })
    } catch {
      setNote({ tone: 'error', text: 'Could not copy worktree path' })
    }
  }

  const switchBranch = async (name: string) => {
    const result = await git.checkout(name)
    if (result.ok) { setOpen(false); return }
    if (result.reason === 'dirty') setMode({ kind: 'dirty', target: name })
  }

  const switchRemoteBranch = async (name: string) => {
    const result = await git.checkout(name, { track: true })
    if (result.ok) { setOpen(false); return }
    if (result.reason === 'dirty') setMode({ kind: 'dirty', target: name.replace(/^[^/]+\//, '') })
  }

  const syncWithRemote = async () => {
    if (syncing) return
    setSyncing(true); setNote(null); git.setError(null)
    try {
      const result = await git.pull()
      setNote(describePullResult(result))
      git.setError(null) // the note already carries the failure reason
    } finally {
      setSyncing(false)
    }
  }

  const createBranch = async () => {
    const name = newBranchName.trim()
    if (!name) return
    const result = await git.createBranch(name)
    if (result.ok) setOpen(false)
  }

  const createWorktree = async () => {
    const name = newWorktreeName.trim()
    if (!name || changingMode) return
    setChangingMode(true); setNote(null)
    try {
      await onCreateWorktree(name)
      // Creation succeeded — dismiss the picker instead of dropping back to the
      // branch list; the pill itself now shows the new worktree and branch.
      setMode({ kind: 'list' })
      setOpen(false)
    } catch (error) {
      setNote({ tone: 'error', text: error instanceof Error ? error.message : 'Could not create worktree' })
    } finally {
      setChangingMode(false)
    }
  }

  const changeExecutionMode = async (nextMode: 'shared-checkout' | 'isolated-worktree') => {
    if (changingMode || nextMode === executionMode) return
    setChangingMode(true); setNote(null)
    try {
      await onExecutionModeChange(nextMode)
      setNote({
        tone: 'ok',
        text: nextMode === 'isolated-worktree'
          ? 'Using this chat’s worktree'
          : 'Using the current checkout; the isolated worktree is preserved',
      })
      setMode({ kind: 'list' })
    } catch (error) {
      setNote({ tone: 'error', text: error instanceof Error ? error.message : 'Could not switch checkout mode' })
    } finally {
      setChangingMode(false)
    }
  }

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        style={styles.pill}
        onClick={() => setOpen(value => {
          if (!value) { setNote(null); void git.refresh() }
          return !value
        })}
        title={path ? `${branchLabel}\n${path}` : 'Chat checkout unavailable'}
        aria-label={`Chat branch: ${branchLabel}, ${path || 'unavailable'}`}
        aria-expanded={open}
      >
        <UIIcon name="code" size={15} />
        <span style={styles.pillIdentity}>
          <span style={styles.pillBranch}>
            <span style={styles.ellipsis}>{branchLabel}</span>
            {state && state.dirty > 0 && <span style={styles.dirty}>+{state.dirty}</span>}
          </span>
          <span style={styles.pillPath} title={path}>{checkoutLabel}</span>
        </span>
        <span style={{ ...styles.caret, transform: open ? 'rotate(-90deg)' : 'rotate(90deg)' }}>
          <UIIcon name="chevron" size={12} />
        </span>
      </button>

      {open && (
        <div style={styles.menu}>
          <div style={styles.currentCheckout}>
            <div style={styles.currentRow}>
              <div style={styles.currentIdentity}>
                <div style={styles.currentBranch}>{branchLabel}</div>
                <div style={styles.currentPath} title={path}>{pathLabel}</div>
              </div>
              <button style={styles.iconButton} onClick={() => void copyPath()} title="Copy path" aria-label="Copy worktree path">
                <UIIcon name="copy" size={13} />
              </button>
              <button
                style={styles.iconButton}
                disabled={!workingDir || syncing}
                onClick={() => void syncWithRemote()}
                title={syncing ? 'Syncing…' : 'Sync: fetch and fast-forward this branch to its upstream'}
                aria-label="Sync with the latest upstream commits"
              >
                <style>{'@keyframes codey-branch-sync-spin { to { transform: rotate(360deg) } }'}</style>
                <span style={syncing ? styles.spinning : undefined}>
                  <UIIcon name="refresh" size={13} />
                </span>
              </button>
            </div>
            {/* Sync and checkout outcomes belong next to the branch they describe,
              * not buried under the branch list where they used to sit. */}
            {banner && (
              <div style={{ ...styles.banner, color: noteColors[banner.tone] }} role="status" title={banner.text}>
                <span style={styles.bannerIcon}><UIIcon name={banner.tone === 'ok' ? 'check' : 'alert'} size={12} /></span>
                <span style={styles.bannerText}>{banner.text}</span>
              </div>
            )}
          </div>

          <div style={styles.checkoutMode}>
            <span style={isolated ? styles.worktreeBadge : styles.modeLabel} title={chatWorktree?.path}>
              {isolated ? worktreeLabel : 'Current checkout'}
            </span>
            {!chatWorktree ? (
              <button style={styles.createWorktreeButton} onClick={() => { setNewWorktreeName(''); setMode({ kind: 'createWorktree' }) }}>
                + Create worktree
              </button>
            ) : (
              <button style={styles.ghost} disabled={changingMode} onClick={() => void changeExecutionMode(isolated ? 'shared-checkout' : 'isolated-worktree')}>
                {isolated ? 'Use current' : 'Use worktree'}
              </button>
            )}
          </div>

          {mode.kind === 'dirty' ? (
            <div style={styles.section}>
              <div style={styles.warn}>Switching would overwrite local changes.</div>
              <div style={styles.row}>
                <button style={styles.primary} onClick={async () => {
                  const result = await git.stashAndSwitch(mode.target)
                  if (result.ok) {
                    setNote({ tone: 'ok', text: 'Local changes stashed — restore with `git stash pop`' })
                    setMode({ kind: 'list' })
                  }
                }}>Stash & switch</button>
                <button style={styles.ghost} onClick={() => setMode({ kind: 'list' })}>Cancel</button>
              </div>
            </div>
          ) : mode.kind === 'createWorktree' ? (
            <div style={styles.section}>
              <div style={styles.sectionLabel}>Worktree name</div>
              <input
                autoFocus
                placeholder="feature-auth"
                value={newWorktreeName}
                onChange={event => setNewWorktreeName(event.target.value)}
                onKeyDown={event => { if (event.key === 'Enter') void createWorktree() }}
                style={styles.input}
              />
              <div style={styles.hint}>Creates a worktree and same-named branch from HEAD. Uncommitted changes stay in the current checkout.</div>
              <div style={styles.row}>
                <button style={styles.primary} disabled={!newWorktreeName.trim() || changingMode} onClick={() => void createWorktree()}>{changingMode ? 'Creating…' : 'Create worktree'}</button>
                <button style={styles.ghost} disabled={changingMode} onClick={() => setMode({ kind: 'list' })}>Cancel</button>
              </div>
            </div>
          ) : mode.kind === 'createBranch' ? (
            <div style={styles.section}>
              <div style={styles.sectionLabel}>Create branch in this checkout</div>
              <input
                autoFocus
                placeholder="new-branch-name"
                value={newBranchName}
                onChange={event => setNewBranchName(event.target.value)}
                onKeyDown={event => { if (event.key === 'Enter') void createBranch() }}
                style={styles.input}
              />
              <div style={styles.row}>
                <button style={styles.primary} onClick={() => void createBranch()}>Create</button>
                <button style={styles.ghost} onClick={() => setMode({ kind: 'list' })}>Cancel</button>
              </div>
            </div>
          ) : (
            <>
              <input placeholder="Filter branches…" value={query} onChange={event => setQuery(event.target.value)} style={styles.input} />
              <div style={styles.scroll}>
                {localBranches.length > 0 && <div style={styles.divider}>Local</div>}
                {localBranches.map(branch => (
                  <button key={branch} style={styles.item} disabled={branch === state?.branch} onClick={() => void switchBranch(branch)}>
                    <span style={styles.checkSlot}>{branch === state?.branch && <UIIcon name="check" size={13} />}</span>
                    <span style={styles.branchName}>{branch}</span>
                  </button>
                ))}
                {remoteBranches.length > 0 && <div style={styles.divider}>Remote</div>}
                {remoteBranches.map(branch => (
                  <button key={branch} style={styles.item} onClick={() => void switchRemoteBranch(branch)}>
                    <span style={styles.checkSlot} />
                    <span style={styles.branchName}>{branch}</span>
                  </button>
                ))}
                {localBranches.length === 0 && remoteBranches.length === 0 && <div style={styles.empty}>No branches found</div>}
              </div>
              <div style={styles.footer}>
                <button style={styles.ghost} onClick={() => { setNewBranchName(''); setMode({ kind: 'createBranch' }) }}>+ New branch</button>
                <button style={styles.ghost} onClick={() => void git.fetchRemote()}>Fetch</button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  pill: { display: 'inline-flex', alignItems: 'center', gap: 7, color: C.fg2, fontSize: 11, background: C.surface3, border: `1px solid ${C.border2}`, borderRadius: 7, padding: '5px 8px', cursor: 'pointer', flexShrink: 1, minWidth: 150, maxWidth: 310, overflow: 'hidden', textAlign: 'left' },
  pillIdentity: { display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0, flex: 1 },
  pillBranch: { display: 'flex', alignItems: 'center', gap: 5, minWidth: 0, fontFamily: 'SF Mono, Menlo, monospace' },
  pillPath: { color: C.fg3, fontSize: 9, fontFamily: 'SF Mono, Menlo, monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  ellipsis: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  dirty: { color: C.yellow, opacity: 0.85 },
  caret: { color: C.fg3, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 14, height: 14, flexShrink: 0, transformOrigin: 'center', transition: 'transform 0.15s ease' },
  menu: { position: 'absolute', top: 'calc(100% + 7px)', left: 0, zIndex: 20, width: 340, background: C.surface2, border: `1px solid ${C.border}`, borderRadius: 8, boxShadow: '0 14px 30px rgba(0,0,0,0.26)', padding: 8, display: 'flex', flexDirection: 'column', gap: 7 },
  currentCheckout: { display: 'flex', flexDirection: 'column', gap: 6, padding: '6px 7px 8px', borderBottom: `1px solid ${C.border}` },
  currentRow: { display: 'flex', alignItems: 'center', gap: 7 },
  banner: { display: 'flex', alignItems: 'flex-start', gap: 5, fontSize: 10, lineHeight: 1.35 },
  bannerIcon: { display: 'inline-flex', flexShrink: 0, paddingTop: 1 },
  bannerText: { minWidth: 0, overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' },
  currentIdentity: { minWidth: 0, flex: 1 },
  currentBranch: { color: C.fg, fontSize: 11, fontWeight: 600, fontFamily: 'SF Mono, Menlo, monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  currentPath: { color: C.fg3, fontSize: 9, fontFamily: 'SF Mono, Menlo, monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  iconButton: { width: 27, height: 27, padding: 0, border: `1px solid ${C.border2}`, borderRadius: 6, background: C.surface3, color: C.fg2, cursor: 'pointer', display: 'grid', placeItems: 'center', flexShrink: 0 },
  checkoutMode: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '1px 3px 2px' },
  modeLabel: { display: 'inline-flex', alignItems: 'center', gap: 5, color: C.fg3, fontSize: 10, paddingLeft: 3 },
  worktreeBadge: { display: 'inline-flex', alignItems: 'center', gap: 5, color: C.green, fontSize: 10, paddingLeft: 3, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  createWorktreeButton: { background: C.accentDim, color: C.accent, border: `1px solid ${C.accent}55`, borderRadius: 6, padding: '5px 8px', fontSize: 10, cursor: 'pointer' },
  section: { display: 'flex', flexDirection: 'column', gap: 8 },
  sectionLabel: { color: C.fg3, fontSize: 10 },
  scroll: { maxHeight: 260, overflowY: 'auto', display: 'flex', flexDirection: 'column' },
  item: { width: '100%', textAlign: 'left', background: 'transparent', border: 'none', color: C.fg, fontSize: 12, padding: '6px 8px', borderRadius: 6, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 5, minWidth: 0 },
  branchName: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  checkSlot: { width: 14, flexShrink: 0, display: 'inline-flex', alignItems: 'center' },
  empty: { color: C.fg3, fontSize: 11, padding: '14px 8px', textAlign: 'center' },
  hint: { color: C.fg3, fontSize: 10, lineHeight: 1.4 },
  divider: { fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.5, color: C.fg3, padding: '8px 8px 2px' },
  input: { background: C.surface3, border: `1px solid ${C.border2}`, borderRadius: 6, color: C.fg, fontSize: 12, padding: '5px 8px', outline: 'none' },
  row: { display: 'flex', gap: 6 },
  primary: { background: C.accent, color: C.onAccent, border: 'none', borderRadius: 6, padding: '5px 10px', fontSize: 12, cursor: 'pointer' },
  ghost: { background: 'transparent', color: C.fg2, border: `1px solid ${C.border2}`, borderRadius: 6, padding: '5px 10px', fontSize: 11, cursor: 'pointer' },
  footer: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderTop: `1px solid ${C.border}`, paddingTop: 6 },
  spinning: { display: 'inline-flex', animation: 'codey-branch-sync-spin 0.9s linear infinite' },
  warn: { fontSize: 12, color: C.yellow },
}

const noteColors: Record<BranchNote['tone'], string> = { ok: C.green, warn: C.yellow, error: C.red }
