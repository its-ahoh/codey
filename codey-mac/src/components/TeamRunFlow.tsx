import { useMemo, useState, useEffect } from 'react'
import { ReactFlow, ReactFlowProvider, ConnectionMode, type Node, type Edge } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import type { ChatMessage } from '../types'
import type { TeamGraph } from '../../../packages/core/src/team-graph'
import { toFlow } from './flowEditorModel'
import { nodeTypes, edgeTypes, rfNodeType } from './flowGraph'
import { deriveWorkerRuns, synthesizeChainGraph, nodeStatuses, toolCallsForStep } from './teamRunModel'
import { ToolCallList } from './ToolCallList'
import { C, useEffectiveTheme } from '../theme'
import { Markdown } from './Markdown'

interface Props {
  turn: ChatMessage
  isStreaming: boolean
  teamGraph?: TeamGraph
  askingWorker?: string
  onClose: () => void
}

const secondaryBtn = { fontSize: 12, background: C.surface2, color: C.fg, border: `1px solid ${C.border2}`, borderRadius: 6, padding: '4px 12px', cursor: 'pointer' } as const

function TeamRunFlowInner({ turn, isStreaming, teamGraph, askingWorker, onClose }: Props) {
  const effectiveTheme = useEffectiveTheme()
  const runs = useMemo(() => deriveWorkerRuns(turn, isStreaming), [turn.content, turn.thinkingByStep, turn.toolCalls?.length, isStreaming])
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
  const [showThinking, setShowThinking] = useState(false)

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div onClick={e => e.stopPropagation()} style={{ width: '90vw', height: '85vh', background: C.bg, border: `1px solid ${C.border}`, borderRadius: 10, display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px', borderBottom: `1px solid ${C.border}` }}>
          <strong style={{ flex: 1 }}>Workflow run</strong>
          <button onClick={onClose} style={secondaryBtn}>Close</button>
        </div>
        <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
          <div style={{ flex: 1.4, minWidth: 0, borderRight: `1px solid ${C.border}` }}>
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
          <div style={{ flex: 1, minWidth: 260, padding: 16, overflowY: 'auto' }}>
            {sel ? (
              <>
                <div style={{ fontWeight: 600, color: C.fg, marginBottom: 2 }}>{sel.worker}</div>
                <div style={{ fontSize: 11, color: C.fg2, marginBottom: 12 }}>Step {sel.step} · {sel.status}</div>
                <div style={{ fontSize: 11, textTransform: 'uppercase', color: C.fg3, marginBottom: 6 }}>Output</div>
                <Markdown variant="assistant">{sel.output || '(no output yet)'}</Markdown>
                <div style={{ fontSize: 11, textTransform: 'uppercase', color: C.fg3, margin: '14px 0 6px' }}>Tool calls</div>
                <ToolCallList toolCalls={toolCallsForStep(turn.toolCalls, sel.step)} emptyHint="(no tool calls)" />
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
