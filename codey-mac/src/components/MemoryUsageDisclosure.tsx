import type { ChatMessage } from '../types'
import { C } from '../theme'

/** Keep historical prompt snapshots readable after retiring the Bot memory store. */
export function MemoryUsageDisclosure({ entries }: { entries?: ChatMessage['memoryUsed'] }) {
  if (!entries?.length) return null
  return <details style={{ margin: '6px 0', fontSize: 12, color: C.fg3 }}>
    <summary style={{ cursor: 'pointer' }}>Memory included · {entries.length}</summary>
    <p>These notes were included in this turn. This does not mean the model relied on every note.</p>
    {entries.map(memory => <div key={`${memory.botName}:${memory.id}:${memory.version}`} style={{ padding: '8px 0', borderTop: `1px solid ${C.border}` }}>
      <div>{memory.botName || 'Main chat'} · {memory.projectName || 'All projects'} · {memory.audience === 'private' ? 'Archived Bot memory' : memory.audience === 'global' ? 'User memory' : 'Project memory'}</div>
      <p style={{ whiteSpace: 'pre-wrap', color: C.fg }}>{memory.content}</p>
      <details><summary>Source</summary><blockquote style={{ whiteSpace: 'pre-wrap' }}>{memory.source}</blockquote></details>
    </div>)}
    <p>This is a historical snapshot. Manage current user memory in Settings and project memory in Workspaces.</p>
  </details>
}
