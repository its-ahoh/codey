import { describe, expect, it } from 'vitest'
import { addMissingAgentSessions, adoptTerminalSession, type TerminalLayout } from './terminalAgentLayout'

let n = 0
const id = () => `t${++n}`
const layout = (): TerminalLayout => ({
  tabs: [
    { id: 'a', sessions: ['s1'], activeSessionId: 's1' },
    { id: 'b', sessions: ['s2', 's3'], activeSessionId: 's2', splitDirection: 'row' },
  ],
  activeTabId: 'a',
})

describe('adoptTerminalSession', () => {
  it('adds a new agent session as the active last tab', () => {
    const next = adoptTerminalSession(layout(), 'agent-1', () => 'new')
    expect(next.tabs.at(-1)).toEqual({ id: 'new', sessions: ['agent-1'], activeSessionId: 'agent-1' })
    expect(next.activeTabId).toBe('new')
  })

  it('focuses the tab and split that already hold the session', () => {
    const next = adoptTerminalSession(layout(), 's3', id)
    expect(next.activeTabId).toBe('b')
    expect(next.tabs[1].activeSessionId).toBe('s3')
    expect(next.tabs).toHaveLength(2)
  })

  it('returns the same layout when the session is already in front', () => {
    const current = layout()
    expect(adoptTerminalSession(current, 's1', id)).toBe(current)
  })
})

describe('addMissingAgentSessions', () => {
  it('adds only live agent sessions that are not shown, keeping the active tab', () => {
    const next = addMissingAgentSessions(layout(), [
      { sessionId: 's1', alive: true, agent: true },
      { sessionId: 'agent-live', alive: true, agent: true },
      { sessionId: 'agent-dead', alive: false, agent: true },
      { sessionId: 'user-shell', alive: true, agent: false },
    ], () => 'added')
    expect(next.tabs.map(tab => tab.sessions)).toEqual([['s1'], ['s2', 's3'], ['agent-live']])
    expect(next.activeTabId).toBe('a')
  })

  it('returns the same layout when nothing is missing', () => {
    const current = layout()
    expect(addMissingAgentSessions(current, [{ sessionId: 's2', alive: true, agent: true }], id)).toBe(current)
  })
})
