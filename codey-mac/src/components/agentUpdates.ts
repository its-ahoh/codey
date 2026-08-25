import { useEffect, useSyncExternalStore } from 'react'

/**
 * The shared answer to "is a newer version of any agent CLI published?".
 *
 * It lives outside the Agents tab because the point of it is the dot on the
 * sidebar row, which has to be right before that tab is ever opened. Main
 * caches both halves (the install probe and the registry lookup), so the extra
 * consumer costs nothing: opening Settings and then the tab is one lookup, not
 * two.
 */

export type Availability = {
  current?: string
  latest?: string
  updateAvailable: boolean
  /** Could not find out — offline, registry down. Not the same as current. */
  unknown: boolean
}

/** null until the first check answers — not "nothing to update". */
export type AgentUpdatesState = { updates: Record<string, Availability> | null }

let snapshot: AgentUpdatesState = { updates: null }
const listeners = new Set<() => void>()
let inFlight: Promise<void> | null = null

const publish = (next: AgentUpdatesState) => {
  snapshot = next
  for (const l of listeners) l()
}

const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => { listeners.delete(l) }
}

/** True when at least one agent has a genuinely newer version published.
 *  `unknown` deliberately does not count: a dot means "there is something",
 *  and a failed lookup is not something. */
export function hasAgentUpdate(updates: Record<string, Availability> | null): boolean {
  if (!updates) return false
  return Object.values(updates).some(u => u.updateAvailable)
}

/** Push an answer the app already paid for — the re-check after an update. */
export function publishAgentUpdates(updates: Record<string, Availability>): void {
  publish({ updates })
}

/** Fetch into the shared store. Without `force`, once is enough per session;
 *  main's own cache decides when the lookup really goes out again. */
export function refreshAgentUpdates(force = false): Promise<void> {
  if (inFlight) return force ? inFlight.then(() => refreshAgentUpdates(true)) : inFlight
  if (!force && snapshot.updates) return Promise.resolve()
  inFlight = (async () => {
    try {
      const r = await window.codey.agents.updateStatus(force)
      if (r.ok) publish({ updates: r.data.updates })
    } catch { /* an update check is not worth an error banner anywhere */ }
  })().finally(() => { inFlight = null })
  return inFlight
}

export function useAgentUpdates(enabled = true): AgentUpdatesState {
  const state = useSyncExternalStore(subscribe, () => snapshot)
  useEffect(() => { if (enabled) void refreshAgentUpdates() }, [enabled])
  return state
}
