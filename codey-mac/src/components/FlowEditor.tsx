import { useCallback, useMemo, useState } from 'react'
import {
  ReactFlow, Background, Controls, addEdge, applyNodeChanges, applyEdgeChanges,
  type Node, type Edge, type Connection,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { TeamGraph, validateGraph } from '../../../packages/core/src/team-graph'
import { toFlow, fromFlow, newNodeId } from './flowEditorModel'
import { C } from '../theme'

interface Props {
  teamName: string
  workerNames: string[]
  graph: TeamGraph
  onSave: (graph: TeamGraph) => void
  onClose: () => void
}

export default function FlowEditor({ teamName, workerNames, graph, onSave, onClose }: Props) {
  const initial = useMemo(() => toFlow(graph), [])
  const [nodes, setNodes] = useState<Node[]>(initial.nodes as unknown as Node[])
  const [edges, setEdges] = useState<Edge[]>(initial.edges as unknown as Edge[])
  const [maxHops, setMaxHops] = useState(graph.maxHops)
  const [selEdge, setSelEdge] = useState<string | null>(null)
  const [showRaw, setShowRaw] = useState(false)

  const current = (): TeamGraph =>
    fromFlow(nodes as any, edges as any, graph.entry, maxHops)
  const problems = validateGraph(current(), workerNames)

  const onNodesChange = useCallback((cs: any) => setNodes(ns => applyNodeChanges(cs, ns)), [])
  const onEdgesChange = useCallback((cs: any) => setEdges(es => applyEdgeChanges(cs, es)), [])
  const onConnect = useCallback((c: Connection) =>
    setEdges(es => addEdge({ ...c, id: `e_${Date.now()}`, data: {} } as any, es)), [])

  const addWorker = (worker: string) => {
    const id = newNodeId(nodes.map(n => n.id))
    setNodes(ns => [...ns, { id, position: { x: 200, y: 60 + ns.length * 70 }, data: { label: worker, type: 'worker', worker } } as any])
  }
  const updateEdge = (id: string, patch: any) =>
    setEdges(es => es.map(e => e.id === id ? { ...e, data: { ...(e as any).data, ...patch }, label: patch.isDefault ? 'default' : patch.condition ?? (e as any).data?.condition } : e))

  const save = () => onSave(current())

  const sel = edges.find(e => e.id === selEdge) as any

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div onClick={e => e.stopPropagation()} style={{ width: '90vw', height: '85vh', background: C.bg, border: `1px solid ${C.border}`, borderRadius: 10, display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px', borderBottom: `1px solid ${C.border}` }}>
          <strong style={{ flex: 1 }}>Flow — {teamName}</strong>
          <label style={{ fontSize: 12, color: C.fg3 }}>max hops <input type="number" min={1} value={maxHops} onChange={e => setMaxHops(Math.max(1, Number(e.target.value) || 1))} style={{ width: 56, marginLeft: 6 }} /></label>
          <button onClick={() => setShowRaw(s => !s)} style={{ fontSize: 12 }}>{showRaw ? 'Canvas' : 'Raw config'}</button>
          <button onClick={save} style={{ fontSize: 12, color: C.onAccent, background: C.accent, border: 'none', borderRadius: 6, padding: '4px 12px' }}>Save</button>
          <button onClick={onClose} style={{ fontSize: 12 }}>Close</button>
        </div>
        {problems.length > 0 && (
          <div style={{ background: C.dangerBg, color: C.dangerFg, fontSize: 11, padding: '4px 12px' }}>{problems.join(' · ')}</div>
        )}
        <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
          {!showRaw && (
            <div style={{ width: 160, borderRight: `1px solid ${C.border}`, padding: 10, overflowY: 'auto' }}>
              <div style={{ fontSize: 11, color: C.fg3, marginBottom: 6 }}>Workers</div>
              {workerNames.map(w => (
                <button key={w} onClick={() => addWorker(w)} style={{ display: 'block', width: '100%', textAlign: 'left', marginBottom: 4, fontSize: 12, padding: '4px 6px', background: C.surface2, border: `1px solid ${C.border}`, borderRadius: 6, cursor: 'pointer' }}>+ {w}</button>
              ))}
            </div>
          )}
          {showRaw ? (
            <pre style={{ flex: 1, margin: 0, padding: 14, overflow: 'auto', fontSize: 12, color: C.fg }}>{JSON.stringify(current(), null, 2)}</pre>
          ) : (
            <div style={{ flex: 1, position: 'relative' }}>
              <ReactFlow nodes={nodes} edges={edges} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={onConnect} onEdgeClick={(_, e) => setSelEdge(e.id)} fitView>
                <Background />
                <Controls />
              </ReactFlow>
            </div>
          )}
          {!showRaw && sel && (
            <div style={{ width: 220, borderLeft: `1px solid ${C.border}`, padding: 10 }}>
              <div style={{ fontSize: 11, color: C.fg3, marginBottom: 6 }}>Edge condition</div>
              <textarea value={sel.data?.condition ?? ''} onChange={e => updateEdge(sel.id, { condition: e.target.value, isDefault: false })} placeholder='e.g. "tests pass"' style={{ width: '100%', minHeight: 70, fontSize: 12, padding: 6, background: C.surface2, color: C.fg, border: `1px solid ${C.border}`, borderRadius: 6 }} />
              <label style={{ fontSize: 12, display: 'block', marginTop: 8 }}>
                <input type="checkbox" checked={!!sel.data?.isDefault} onChange={e => updateEdge(sel.id, { isDefault: e.target.checked, condition: e.target.checked ? undefined : sel.data?.condition })} /> default (else) edge
              </label>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
