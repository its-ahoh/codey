/** What the agent is doing right now, as shown in the shimmering status line.
 *  Finer than "working": the tool a turn is currently running says far more
 *  about the wait than a generic spinner does. */
export type AgentActivity =
  | 'idle'
  | 'thinking'
  | 'reading'
  | 'searching'
  | 'editing'
  | 'running'
  | 'browsing'
  | 'delegating'
  | 'working'
  | 'writing'

export const ACTIVITY_LABEL: Record<AgentActivity, string> = {
  idle: 'Idle',
  thinking: 'Thinking',
  reading: 'Reading',
  searching: 'Searching',
  editing: 'Editing',
  running: 'Running',
  browsing: 'Browsing',
  delegating: 'Delegating',
  working: 'Working',
  writing: 'Writing',
}

/** Tool names differ per agent (`Read` in claude-code, `read` in opencode,
 *  `mcp__codey-browser__browser_open` for MCP), so match loosely on substrings
 *  rather than an exact table that silently degrades to "Working". */
export function activityForTool(tool?: string): AgentActivity {
  const t = (tool ?? '').toLowerCase()
  if (!t) return 'working'
  if (t.includes('browser') || t.includes('webfetch') || t.includes('fetch')) return 'browsing'
  if (t.includes('websearch') || t.includes('grep') || t.includes('glob') || t.includes('search')) return 'searching'
  if (t.includes('edit') || t.includes('write') || t.includes('patch') || t.includes('apply')) return 'editing'
  if (t.includes('read') || t.includes('view') || t.includes('cat')) return 'reading'
  if (t.includes('bash') || t.includes('shell') || t.includes('exec') || t.includes('command') || t.includes('terminal')) return 'running'
  if (t.includes('task') || t.includes('agent') || t.includes('worker')) return 'delegating'
  return 'working'
}
