import React from 'react'
import { C } from '../theme'
import { ToolDetail } from './toolFormat'
import type { ToolCallEntry } from '../types'

/**
 * Renders a stream of ToolCallEntry items as an expandable timeline.
 * Shared by the single-agent TOOLS tab (`ToolTimeline`) and the team run-flow
 * worker drawer, so both surfaces present tool calls identically.
 *
 * Returns null when there are no rows and no `emptyHint` is given (matches the
 * single-agent panel, which hides the section entirely when empty).
 */
export const ToolCallList: React.FC<{ toolCalls: ToolCallEntry[]; emptyHint?: string }> = ({ toolCalls, emptyHint }) => {
  const [expanded, setExpanded] = React.useState<Set<string>>(new Set())

  type Row =
    | { kind: 'call'; id: string; tool?: string; input?: Record<string, unknown>; output?: string; done: boolean; message: string }
    | { kind: 'info'; id: string; message: string }
  const rows: Row[] = []
  const startIdxById = new Map<string, number>()
  for (const tc of toolCalls) {
    if (tc.type === 'info') {
      rows.push({ kind: 'info', id: tc.id, message: tc.message })
      continue
    }
    if (tc.type === 'tool_start') {
      const idx = rows.push({
        kind: 'call', id: tc.id, tool: tc.tool, input: tc.input,
        done: false, message: tc.message,
      }) - 1
      startIdxById.set(tc.id, idx)
    } else { // tool_end
      const idx = startIdxById.get(tc.id)
      if (idx != null) {
        const row = rows[idx] as Extract<Row, { kind: 'call' }>
        row.done = true
        if (tc.output) row.output = tc.output
        if (tc.message) row.message = tc.message
        startIdxById.delete(tc.id)
      } else {
        rows.push({
          kind: 'call', id: tc.id, tool: tc.tool, output: tc.output,
          done: true, message: tc.message,
        })
      }
    }
  }

  if (rows.length === 0) return emptyHint ? <div style={timelineStyles.emptyHint}>{emptyHint}</div> : null
  return (
    <div style={timelineStyles.list}>
      {rows.map(r => {
        if (r.kind === 'info') {
          return (
            <div key={r.id} style={timelineStyles.infoRow}>
              <span style={timelineStyles.iconInfo}>ⓘ</span>
              <span>{r.message}</span>
            </div>
          )
        }
        const isOpen = expanded.has(r.id)
        const hasDetail = !!r.input || !!r.output
        const toggle = () => setExpanded(prev => {
          const next = new Set(prev)
          next.has(r.id) ? next.delete(r.id) : next.add(r.id)
          return next
        })
        const icon = isOpen ? '▾' : '▶'
        return (
          <div key={r.id}>
            <div
              style={{ ...timelineStyles.callRow, cursor: hasDetail ? 'pointer' : 'default' }}
              onClick={hasDetail ? toggle : undefined}
            >
              <span style={r.done ? timelineStyles.iconDone : timelineStyles.iconRunning}>{icon}</span>
              <span style={timelineStyles.tool}>{r.tool ?? '(tool)'}</span>
              <span style={timelineStyles.callMsg}>{r.message}</span>
            </div>
            {hasDetail && isOpen && (
              <div style={timelineStyles.detail}>
                <ToolDetail rawTool={r.tool} input={r.input ?? {}} output={r.output} />
                {!r.done && !r.output && (
                  <div style={timelineStyles.detailLabel}>(no result yet)</div>
                )}
                {r.done && !r.output && !r.input && (
                  <div style={timelineStyles.detailLabel}>(no result)</div>
                )}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

const timelineStyles: Record<string, React.CSSProperties> = {
  list: { display: 'flex', flexDirection: 'column', gap: 4 },
  emptyHint: { color: C.fg3, fontSize: 11 },
  infoRow: {
    display: 'flex', alignItems: 'flex-start', gap: 6,
    color: C.fg3, fontSize: 11, fontStyle: 'italic',
  },
  callRow: {
    display: 'flex', alignItems: 'flex-start', gap: 6,
    fontSize: 12, fontFamily: 'Menlo, Monaco, "Courier New", monospace',
    padding: '2px 0',
  },
  tool: { color: C.fg2, flexShrink: 0 },
  callMsg: { color: C.fg2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  iconRunning: { color: C.accent, width: 12, flexShrink: 0 },
  iconDone: { color: C.green, width: 12, flexShrink: 0 },
  iconInfo: { color: C.fg3, width: 12, flexShrink: 0 },
  detail: {
    marginLeft: 18, marginTop: 4, marginBottom: 6,
    padding: 8, background: 'rgba(0,0,0,0.3)',
    border: `1px solid ${C.border}`, borderRadius: 6,
    maxHeight: 280, overflowY: 'auto',
  },
  detailLabel: { color: C.fg3, fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 4 },
}
