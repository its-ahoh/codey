import { useState, useEffect, useCallback } from 'react'
import { pollWhileVisible } from './pollWhileVisible'

export interface BranchState {
  branch: string
  dirty: number
  local: string[]
  remote: string[]
  worktrees: { branch: string; path: string; isMain: boolean }[]
}

export interface PullOutcome {
  ok: boolean
  updated?: number
  upstream?: string
  error?: string
  reason?: 'dirty' | 'diverged' | 'no-upstream'
}

export function useGitBranches(workingDir: string | undefined, repositoryDir?: string) {
  const [state, setState] = useState<BranchState | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    const topologyDir = repositoryDir || workingDir
    if (!topologyDir) { setState(null); return }
    try {
      const [s, b, w] = await Promise.all([
        workingDir ? window.codey.git.status(workingDir) : Promise.resolve({ ok: true as const, data: null }),
        window.codey.git.branches(topologyDir),
        window.codey.git.worktrees(topologyDir),
      ])
      const br = b.ok ? b.data : { current: '', local: [], remote: [] }
      if (!s.ok && !b.ok && !w.ok) { setState(null); return }
      setState({
        // A missing selected checkout must not masquerade as the repository's
        // main branch. Keep topology available so the user can recover by
        // selecting another worktree, but render the active branch as unknown.
        branch: s.ok && s.data ? s.data.branch : 'HEAD',
        dirty: s.ok && s.data ? s.data.dirty : 0,
        local: br.local,
        remote: br.remote,
        worktrees: w.ok ? w.data.list : [],
      })
    } catch { setState(null) }
  }, [workingDir, repositoryDir])

  useEffect(() => { void refresh() }, [refresh])

  // Live updates: watch .git and re-pull on change. Polling fallback every 5s.
  useEffect(() => {
    const watchedDirs = Array.from(new Set([workingDir, repositoryDir].filter((dir): dir is string => Boolean(dir))))
    if (watchedDirs.length === 0) return
    for (const dir of watchedDirs) void window.codey.git.watch(dir)
    const off = window.codey.git.onChanged(ev => { if (watchedDirs.includes(ev.workingDir)) void refresh() })
    const onFocus = () => void refresh()
    window.addEventListener('focus', onFocus)
    // Each refresh spawns ~7 git subprocesses, so skip it while the window is
    // hidden; pollWhileVisible catches up on return, and the .git watcher above
    // still fires on real changes.
    const stopPoll = pollWhileVisible(() => void refresh(), 5000)
    return () => {
      off()
      window.removeEventListener('focus', onFocus)
      stopPoll()
      for (const dir of watchedDirs) void window.codey.git.unwatch(dir)
    }
  }, [workingDir, repositoryDir, refresh])

  const checkout = useCallback(async (name: string, opts?: { create?: boolean; track?: boolean }) => {
    if (!workingDir) return { ok: false, error: 'no dir' }
    setError(null)
    const r = await window.codey.git.checkout(workingDir, name, opts)
    if (!r.ok) { setError(r.error || 'checkout failed'); return { ok: false, error: r.error } }
    const d = r.data
    if (d.ok) { await refresh(); return { ok: true } }
    if (d.reason !== 'dirty') setError(d.error || 'checkout failed')
    return { ok: false, error: d.error, reason: d.reason }
  }, [workingDir, refresh])

  const stashAndSwitch = useCallback(async (name: string) => {
    if (!workingDir) return { ok: false }
    const st = await window.codey.git.stash(workingDir, `codey-mac: switch to ${name}`)
    if (!st.ok || !st.data.ok) { setError((st.ok ? st.data.error : st.error) || 'stash failed'); return { ok: false } }
    const co = await window.codey.git.checkout(workingDir, name)
    if (co.ok && co.data.ok) { await refresh(); return { ok: true } }
    setError((co.ok ? co.data.error : co.error) || 'checkout failed'); return { ok: false }
  }, [workingDir, refresh])

  const createBranch = useCallback(async (name: string) => checkout(name, { create: true }), [checkout])

  const fetchRemote = useCallback(async () => {
    if (!workingDir) return
    const r = await window.codey.git.fetch(workingDir)
    if (r.ok && r.data.ok) await refresh()
    else setError((r.ok ? r.data.error : r.error) || 'fetch failed')
  }, [workingDir, refresh])

  const pull = useCallback(async (): Promise<PullOutcome> => {
    if (!workingDir) return { ok: false, error: 'no dir' }
    setError(null)
    const r = await window.codey.git.pull(workingDir)
    if (!r.ok) { setError(r.error || 'pull failed'); return { ok: false, error: r.error } }
    const d = r.data
    if (d.ok) { await refresh(); return { ok: true, updated: d.updated ?? 0, upstream: d.upstream } }
    return { ok: false, error: d.error, reason: d.reason }
  }, [workingDir, refresh])

  return { state, error, setError, refresh, checkout, stashAndSwitch, createBranch, fetchRemote, pull }
}
