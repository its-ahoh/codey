import { useState, useEffect, useCallback } from 'react'

export interface GitStatus {
  branch: string
  dirty: number
}

export function useGitStatus(workingDir: string | undefined) {
  const [status, setStatus] = useState<GitStatus | null>(null)

  const refresh = useCallback(async () => {
    if (!workingDir) { setStatus(null); return }
    setStatus(null)
    try {
      const r = await window.codey.git.status(workingDir)
      if (r.ok) setStatus(r.data)
      else setStatus(null)
    } catch { /* ignore */ }
  }, [workingDir])

  useEffect(() => { void refresh() }, [refresh])

  useEffect(() => {
    const onFocus = () => void refresh()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [refresh])

  return { status, refresh }
}
