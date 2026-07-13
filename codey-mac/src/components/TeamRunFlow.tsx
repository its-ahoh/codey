import { useMemo, useState, useEffect } from 'react'
import { ReactFlow, ReactFlowProvider, ConnectionMode, type Node, type Edge } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import type { ChatMessage } from '../types'
import type { TeamGraph } from '../../../packages/core/src/team-graph'
import { toFlow } from './flowEditorModel'
import { nodeTypes, edgeTypes, rfNodeType } from './flowGraph'
import { deriveWorkerRuns, deriveWorkerRunsFromGroup, synthesizeChainGraph, nodeStatuses, toolCallsForStep } from './teamRunModel'
import { ToolCallList } from './ToolCallList'
import { C, useEffectiveTheme } from '../theme'
import { Markdown } from './Markdown'
import { UIIcon } from './UIIcons'

interface Props {
  turn: ChatMessage
  isStreaming: boolean
  teamGraph?: TeamGraph
  askingWorker?: string
  /** Per-worker message group for this team run; when present, worker runs are
   *  derived from it instead of from the (legacy) combined transcript. */
  group?: ChatMessage[]
  onClose: () => void
}

const secondaryBtn = { fontSize: 12, background: C.surface3, color: C.fg2, border: `1px solid ${C.border2}`, borderRadius: 8, padding: '7px 11px', cursor: 'pointer' } as const

function TeamRunFlowInner({ turn, isStreaming, teamGraph, askingWorker, group, onClose }: Props) {
  const effectiveTheme = useEffectiveTheme()
  const runs = useMemo(
    () => (group && group.length > 0 ? deriveWorkerRunsFromGroup(group) : deriveWorkerRuns(turn, isStreaming)),
    [group, turn.content, turn.thinkingByStep, turn.toolCalls?.length, isStreaming],
  )
  const graph: TeamGraph = useMemo(() => teamGraph ?? synthesizeChainGraph(runs), [teamGraph, runs])
  const statuses = useMemo(() => nodeStatuses(graph, runs, askingWorker), [graph, runs, askingWorker])

  const runByWorker = useMemo(() => {
    const m = new Map<string, ReturnType<typeof deriveWorkerRuns>[number]>()
    for (const r of runs) m.set(r.worker, r) // latest wins
    return m
  }, [runs])

  const { nodes, edges } = useMemo(() => {
    const f = toFlow(graph)
    const rfNodes: Node[] = f.nodes.map(n => ({
      ...n,
      type: rfNodeType((n.data as any).type),
      data: { ...n.data, status: statuses[n.id] },
    })) as any
    const rfEdges: Edge[] = f.edges.map(e => ({ ...e, type: 'flowEdge' })) as any
    return { nodes: rfNodes, edges: rfEdges }
  }, [graph, statuses])

  // Default selection: the running worker, else the last run.
  const [selWorker, setSelWorker] = useState<string | null>(null)
  useEffect(() => {
    if (selWorker && runByWorker.has(selWorker)) return
    const running = runs.find(r => r.status === 'running')
    setSelWorker((running ?? runs[runs.length - 1])?.worker ?? null)
  }, [runs, selWorker, runByWorker])

  const sel = selWorker ? runByWorker.get(selWorker) : undefined
  // In group mode each worker message carries only its own tool calls, so scope
  // by the matching group message; otherwise attribute from the combined stream.
  const selToolCalls = useMemo(() => {
    if (!sel) return []
    if (group && group.length > 0) {
      const msg = group.find(m => m.step === sel.step && m.worker === sel.worker)
      return msg?.toolCalls ?? []
    }
    return toolCallsForStep(turn.toolCalls, sel.step)
  }, [sel, group, turn.toolCalls])
  const [showThinking, setShowThinking] = useState(false)

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(9,12,20,0.65)', backdropFilter: 'blur(10px)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div onClick={e => e.stopPropagation()} style={{ width: '90vw', height: '85vh', background: C.surface, border: `1px solid ${C.border2}`, borderRadius: 16, boxShadow: '0 30px 90px rgba(0,0,0,0.48)', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '13px 16px', borderBottom: `1px solid ${C.border}`, background: C.surface2 }}>
          <span style={{ width: 30, height: 30, borderRadius: 9, display: 'grid', placeItems: 'center', background: C.accentDim, color: C.accent }}><UIIcon name="activity" size={16} /></span>
          <div style={{ flex: 1 }}><div style={{ fontWeight: 750, color: C.fg }}>Team run</div><div style={{ fontSize: 11, color: C.fg3, marginTop: 2 }}>{runs.length} worker {runs.length === 1 ? 'step' : 'steps'} captured</div></div>
          <button onClick={onClose} style={secondaryBtn}>Close</button>
        </div>
        <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
          <div style={{ flex: 1.4, minWidth: 0, borderRight: `1px solid ${C.border}`, background: C.bg }}>
            <ReactFlow
              nodes={nodes} edges={edges}
              nodeTypes={nodeTypes} edgeTypes={edgeTypes}
              onNodeClick={(_, n) => { const w = (n.data as any)?.worker; if (w) setSelWorker(w) }}
              nodesDraggable={false} nodesConnectable={false} elementsSelectable
              connectionMode={ConnectionMode.Loose}
              fitView fitViewOptions={{ maxZoom: 1, padding: 0.2 }} minZoom={0.2} maxZoom={1.5}
              colorMode={effectiveTheme}
            />
          </div>
          <div style={{ flex: 1, minWidth: 280, padding: 18, overflowY: 'auto', background: C.surface }}>
            {sel ? (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 13 }}><span style={{ width: 30, height: 30, borderRadius: 9, display: 'grid', placeItems: 'center', background: sel.status === 'failed' ? C.dangerBg : C.accentDim, color: sel.status === 'failed' ? C.red : C.accent }}><UIIcon name={sel.status === 'failed' ? 'activity' : 'bot'} size={15} /></span><div><div style={{ fontWeight: 700, color: C.fg }}>{sel.worker}</div><div style={{ fontSize: 11, color: C.fg3 }}>Step {sel.step} · {sel.status}</div></div></div>
                <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.7, textTransform: 'uppercase', color: C.fg3, marginBottom: 7 }}>Output</div>
                <Markdown variant="assistant">{sel.output || '(no output yet)'}</Markdown>
                <div style={{ fontSize: 11, textTransform: 'uppercase', color: C.fg3, margin: '14px 0 6px' }}>Tool calls</div>
                <ToolCallList toolCalls={selToolCalls} emptyHint="(no tool calls)" minimal />
                {sel.thinking && (
                  <div style={{ marginTop: 14 }}>
                    <button onClick={() => setShowThinking(s => !s)} style={{ ...secondaryBtn, fontSize: 11 }}>
                      {showThinking ? 'Hide thinking' : 'Thinking ▸'}
                    </button>
                    {showThinking && <div style={{ marginTop: 8, fontSize: 12, color: C.fg2, whiteSpace: 'pre-wrap' }}>{sel.thinking}</div>}
                  </div>
                )}
              </>
            ) : (
              <div style={{ fontSize: 12, color: C.fg3 }}>Select a worker to see its output.</div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

export default function TeamRunFlow(props: Props) {
  return <ReactFlowProvider><TeamRunFlowInner {...props} /></ReactFlowProvider>
}
