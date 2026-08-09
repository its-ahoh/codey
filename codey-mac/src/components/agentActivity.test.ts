import { describe, it, expect } from 'vitest'
import { activityForTool, ACTIVITY_LABEL, type AgentActivity } from './agentActivity'

describe('activityForTool', () => {
  it('maps claude-code tool names', () => {
    expect(activityForTool('Read')).toBe('reading')
    expect(activityForTool('Edit')).toBe('editing')
    expect(activityForTool('Write')).toBe('editing')
    expect(activityForTool('Bash')).toBe('running')
    expect(activityForTool('Grep')).toBe('searching')
    expect(activityForTool('Glob')).toBe('searching')
    expect(activityForTool('WebFetch')).toBe('browsing')
    expect(activityForTool('WebSearch')).toBe('searching')
    expect(activityForTool('Task')).toBe('delegating')
  })

  it('maps lowercased opencode/codex tool names', () => {
    expect(activityForTool('read')).toBe('reading')
    expect(activityForTool('glob')).toBe('searching')
    expect(activityForTool('shell')).toBe('running')
  })

  it('maps MCP-prefixed browser tools', () => {
    expect(activityForTool('mcp__codey-browser__browser_open')).toBe('browsing')
    expect(activityForTool('mcp__codey-browser__browser_navigate')).toBe('browsing')
  })

  it('falls back to working for unknown or missing tools', () => {
    expect(activityForTool(undefined)).toBe('working')
    expect(activityForTool('')).toBe('working')
    expect(activityForTool('SomeNovelTool')).toBe('working')
  })

  it('labels every activity', () => {
    const all: AgentActivity[] = ['idle', 'thinking', 'reading', 'searching', 'editing', 'running', 'browsing', 'delegating', 'working', 'writing']
    for (const a of all) expect(ACTIVITY_LABEL[a]).toBeTruthy()
  })
})
