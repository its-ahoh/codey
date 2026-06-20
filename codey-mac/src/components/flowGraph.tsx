import {
  Handle, Position, NodeResizer,
  BaseEdge, EdgeLabelRenderer, getBezierPath,
  type NodeProps, type EdgeProps,
} from '@xyflow/react'
import { C } from '../theme'
import type { NodeRunStatus } from './teamRunModel'

export const EDGE_COLOR = C.accent

export const resolveColor = (cssVar: string) =>
  getComputedStyle(document.documentElement).getPropertyValue(cssVar.slice(4, -1)).trim()

const HANDLE_IDS = ['t', 'r', 'b', 'l'] as const
const HANDLE_POS = { t: Position.Top, r: Position.Right, b: Position.Bottom, l: Position.Left }

function NodeHandles() {
  return (
    <>
      {HANDLE_IDS.map(id => (
        <Handle key={id} type="source" id={id} position={HANDLE_POS[id]} style={{ width: 9, height: 9, background: C.accent }} />
      ))}
    </>
  )
}

function ring(selected?: boolean, bad?: boolean): string | undefined {
  if (selected) return `0 0 0 3px ${C.accent}, 0 0 14px 2px ${C.accent}`
  if (bad) return `0 0 0 1px ${C.red}`
  return undefined
}

// Status-driven accents for the read-only run view. Returns undefined for
// authoring (no status) so FlowEditor renders exactly as before.
function statusBorder(status?: NodeRunStatus): string | undefined {
  switch (status) {
    case 'done': return C.green
    case 'running': return C.accent
    case 'failed': return C.red
    case 'askedUser': return C.accent
    default: return undefined
  }
}
function statusGlow(status?: NodeRunStatus): string | undefined {
  if (status === 'running') return `0 0 12px 1px ${C.accent}`
  return undefined
}
const STATUS_ICON: Record<NodeRunStatus, string> = {
  done: '✓', running: '◐', failed: '✕', askedUser: '？', pending: '○',
}

export function WorkerNodeView({ data, selected }: NodeProps) {
  const d = data as { label: string; role?: string; bad?: boolean; status?: NodeRunStatus }
  const sBorder = statusBorder(d.status)
  return (
    <div style={{ minWidth: 100, padding: '8px 12px', borderRadius: 8, background: C.surface2, border: `1px solid ${d.bad ? C.red : sBorder ?? C.border}`, color: C.fg, boxSizing: 'border-box', boxShadow: ring(selected, d.bad) ?? statusGlow(d.status), opacity: d.status === 'pending' ? 0.5 : 1 }}>
      <NodeResizer isVisible={selected} minWidth={100} minHeight={44} />
      <div style={{ fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap' }}>
        {d.status && <span style={{ marginRight: 6, color: sBorder ?? C.fg2 }}>{STATUS_ICON[d.status]}</span>}
        {d.label}
      </div>
      {d.role && <div style={{ fontSize: 11, color: C.fg2, marginTop: 2, maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.role}</div>}
      <NodeHandles />
    </div>
  )
}

export function ConditionNodeView({ data, selected }: NodeProps) {
  const d = data as { condition?: string; bad?: boolean }
  const text = d.condition?.trim() || 'condition?'
  return (
    <div style={{ width: 130, height: 130, display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative' }}>
      <div style={{ position: 'absolute', inset: 19, transform: 'rotate(45deg)', background: C.surface2, border: `1px solid ${d.bad ? C.red : C.accent}`, borderRadius: 8, boxShadow: ring(selected, d.bad) }} />
      <span style={{ position: 'relative', fontSize: 10, lineHeight: 1.25, color: C.fg, width: 78, textAlign: 'center', display: '-webkit-box', WebkitLineClamp: 5, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{text}</span>
      <NodeHandles />
    </div>
  )
}

export function TerminalNodeView({ data, selected }: NodeProps) {
  const d = data as { label: string; bad?: boolean }
  return (
    <div style={{ padding: '10px 22px', borderRadius: 999, background: C.bg, border: `1px solid ${d.bad ? C.red : C.border}`, color: C.fg, fontSize: 14, fontWeight: 600, boxShadow: ring(selected, d.bad) }}>
      {d.label}
      <NodeHandles />
    </div>
  )
}

export const nodeTypes = { workerNode: WorkerNodeView, conditionNode: ConditionNodeView, terminalNode: TerminalNodeView }

export function FlowEdgeView({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd, label, data, selected }: EdgeProps) {
  const [edgePath, labelX, labelY] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition })
  const running = (data as any)?.running
  const stroke = selected ? C.accent : running ? EDGE_COLOR : C.fg2
  return (
    <>
      {selected && <path d={edgePath} fill="none" stroke={C.accent} strokeWidth={9} strokeLinecap="round" style={{ opacity: 0.25 }} />}
      <BaseEdge id={id} path={edgePath} markerEnd={markerEnd} style={{ stroke, strokeWidth: selected ? 3.5 : 1.5 }} />
      {running && (
        <circle r={4} fill={stroke}>
          <animateMotion dur="1.6s" repeatCount="indefinite" path={edgePath} rotate="auto" />
        </circle>
      )}
      {label != null && label !== '' && (
        <EdgeLabelRenderer>
          <div style={{
            position: 'absolute', transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            background: C.bg, color: C.fg2, fontSize: 10, padding: '1px 5px', borderRadius: 4,
            border: `1px solid ${C.border}`, pointerEvents: 'none',
          }}>{String(label)}</div>
        </EdgeLabelRenderer>
      )}
    </>
  )
}

export const edgeTypes = { flowEdge: FlowEdgeView }

// data.type -> React Flow node type (mirrors the inline mapping FlowEditor used).
export const rfNodeType = (t: string): string =>
  t === 'worker' ? 'workerNode' : t === 'condition' ? 'conditionNode' : 'terminalNode'
