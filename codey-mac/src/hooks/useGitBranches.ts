import { useState, useEffect, useCallback } from 'react'
import type { Worktree } from '../components/branchPickerModel'

export interface BranchState {
  branch: string
  dirty: number
  local: string[]
  remote: string[]
  worktrees: Worktree[]
}

export function useGitBranches(workingDir: string | undefined) {
  const [state, setState] = useState<BranchState | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (!workingDir) { setState(null); return }
    try {
      const [s, b, w] = await Promise.all([
        window.codey.git.status(workingDir),
        window.codey.git.branches(workingDir),
        window.codey.git.worktrees(workingDir),
      ])
      if (!s.ok || !s.data) { setState(null); return }
      const br = b.ok ? b.data : { current: s.data.branch, local: [], remote: [] }
      const wl = w.ok ? w.data.list : []
      setState({ branch: s.data.branch, dirty: s.data.dirty, local: br.local, remote: br.remote, worktrees: wl })
    } catch { setState(null) }
  }, [workingDir])

  useEffect(() => { void refresh() }, [refresh])

  // Live updates: watch .git and re-pull on change. Polling fallback every 5s.
  useEffect(() => {
    if (!workingDir) return
    void window.codey.git.watch(workingDir)
    const off = window.codey.git.onChanged(ev => { if (ev.workingDir === workingDir) void refresh() })
    const onFocus = () => void refresh()
    window.addEventListener('focus', onFocus)
    const poll = setInterval(() => void refresh(), 5000)
    return () => {
      off()
      window.removeEventListener('focus', onFocus)
      clearInterval(poll)
      void window.codey.git.unwatch(workingDir)
    }
  }, [workingDir, refresh])

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

  const addWorktree = useCallback(async (name: string, path: string) => {
    if (!workingDir) return { ok: false }
    const r = await window.codey.git.worktreeAdd(workingDir, { name, path })
    if (r.ok && r.data.ok) { await refresh(); return { ok: true, path: r.data.path } }
    setError((r.ok ? r.data.error : r.error) || 'worktree add failed'); return { ok: false }
  }, [workingDir, refresh])

  return { state, error, setError, refresh, checkout, stashAndSwitch, createBranch, fetchRemote, addWorktree }
}
