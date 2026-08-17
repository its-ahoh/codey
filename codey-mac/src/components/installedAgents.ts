import { useEffect, useSyncExternalStore } from 'react'

export type InstallStatus = { installed: boolean; path?: string }
export type InstalledAgentsState = {
  /** null until the first probe answers — callers must not treat it as "nothing installed". */
  status: Record<string, InstallStatus> | null
  checking: boolean
}

// The single renderer-side mirror of the main process's CLI probe (which is
// itself cached there for the app's lifetime). Every consumer reads this store
// instead of keeping its own copy, so a "Recheck" in the Agents tab also
// updates the chat agent picker, and mounting N chats fires one probe, not N.
let snapshot: InstalledAgentsState = { status: null, checking: false }
const listeners = new Set<() => void>()
let inFlight: Promise<void> | null = null

const publish = (next: InstalledAgentsState) => {
  snapshot = next
  for (const l of listeners) l()
}

const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => { listeners.delete(l) }
}

/**
 * Fetch install status into the shared store. Without `force` this is a no-op
 * once a probe has landed; with `force` it re-probes even if cached.
 */
export function refreshInstalledAgents(force = false): Promise<void> {
  // A forced request that lands mid-probe waits its turn rather than riding
  // along on a call that may have been served from the cache.
  if (inFlight) return force ? inFlight.then(() => refreshInstalledAgents(true)) : inFlight
  if (!force && snapshot.status) return Promise.resolve()
  publish({ ...snapshot, checking: true })
  inFlight = (async () => {
    try {
      const r = await window.codey.agents.checkInstalled(force)
      if (r.ok) { publish({ status: r.data, checking: false }); return }
    } catch { /* keep whatever snapshot we already had */ }
    publish({ ...snapshot, checking: false })
  })().finally(() => { inFlight = null })
  return inFlight
}

/** Subscribe to the shared store, kicking off the first probe when enabled. */
export function useInstalledAgents(enabled = true): InstalledAgentsState {
  const state = useSyncExternalStore(subscribe, () => snapshot)
  useEffect(() => { if (enabled) void refreshInstalledAgents() }, [enabled])
  return state
}
