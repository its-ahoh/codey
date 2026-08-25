import { useEffect, useSyncExternalStore } from 'react'

export type InstallStatus = { installed: boolean; path?: string; version?: string }
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
// A probe that failed (timed out, shell broke) left `status` null, so every
// subsequent mount would retry it. Space those retries out rather than letting
// N mounting components each pay for a dotfile-sourcing shell.
let lastFailedAt = 0
const FAILED_PROBE_COOLDOWN_MS = 30_000

const publish = (next: InstalledAgentsState) => {
  snapshot = next
  for (const l of listeners) l()
}

const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => { listeners.delete(l) }
}

/**
 * Push a status the app already knows to be current — the re-probe an update
 * just paid for — into the shared store, so every consumer sees the new
 * version without a second trip through the login shell.
 */
export function publishInstalledAgents(status: Record<string, InstallStatus>): void {
  publish({ ...snapshot, status })
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
  if (!force && Date.now() - lastFailedAt < FAILED_PROBE_COOLDOWN_MS) return Promise.resolve()
  publish({ ...snapshot, checking: true })
  inFlight = (async () => {
    try {
      const r = await window.codey.agents.checkInstalled(force)
      // An inconclusive probe is not evidence that nothing is installed, so it
      // is discarded: `status` stays null and the UI keeps saying "unknown"
      // instead of greying out every agent until the user hits Recheck.
      if (r.ok && r.data.conclusive) { publish({ status: r.data.status, checking: false }); return }
    } catch { /* keep whatever snapshot we already had */ }
    lastFailedAt = Date.now()
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
