// Pure layout helpers for terminals an agent opens through the Terminal
// plugin. Kept apart from TerminalPanel so they can be tested without xterm.

export type TerminalTab = { id: string; sessions: string[]; activeSessionId: string; splitDirection?: 'row' | 'column' }
export type TerminalLayout = { tabs: TerminalTab[]; activeTabId: string }

/**
 * Bring `sessionId` to the front of `layout`: focus the tab that already holds
 * it, or add it as a new tab at the end. Returns the same object when nothing
 * changes, so callers can skip a re-render.
 */
export function adoptTerminalSession(layout: TerminalLayout, sessionId: string, newTabId: () => string): TerminalLayout {
  const holder = layout.tabs.find(tab => tab.sessions.includes(sessionId))
  if (holder) {
    if (layout.activeTabId === holder.id && holder.activeSessionId === sessionId) return layout
    return {
      activeTabId: holder.id,
      tabs: layout.tabs.map(tab => tab.id === holder.id ? { ...tab, activeSessionId: sessionId } : tab),
    }
  }
  const tab = { id: newTabId(), sessions: [sessionId], activeSessionId: sessionId }
  return { tabs: [...layout.tabs, tab], activeTabId: tab.id }
}

/** Add every listed agent session the layout does not show yet, without
 *  changing which tab is active. Used when a panel mounts after an agent
 *  opened tabs in the background. */
export function addMissingAgentSessions(
  layout: TerminalLayout,
  listed: Array<{ sessionId: string; alive: boolean; agent?: boolean }>,
  newTabId: () => string,
): TerminalLayout {
  const shown = new Set(layout.tabs.flatMap(tab => tab.sessions))
  const missing = listed.filter(item => item.agent && item.alive && !shown.has(item.sessionId))
  if (missing.length === 0) return layout
  return {
    ...layout,
    tabs: [...layout.tabs, ...missing.map(item => ({ id: newTabId(), sessions: [item.sessionId], activeSessionId: item.sessionId }))],
  }
}
