import { useCallback, useMemo, useState } from 'react'
import {
  ReactFlow, Background, Controls, addEdge, applyNodeChanges, applyEdgeChanges,
  ReactFlowProvider, useReactFlow, ConnectionMode, MarkerType,
  type Node, type Edge, type Connection,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { TeamGraph, validateGraph } from '../../../packages/core/src/team-graph'
import { toFlow, fromFlow, newNodeId } from './flowEditorModel'
import { nodeTypes, edgeTypes, EDGE_COLOR, resolveColor, rfNodeType } from './flowGraph'
import { C, useEffectiveTheme } from '../theme'

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface Props {
  teamName: string
  workerNames: string[]
  workerRoles?: Record<string, string>
  graph: TeamGraph
  onSave: (graph: TeamGraph) => void
  onClose: () => void
}

function FlowEditorInner({ teamName, workerNames, workerRoles = {}, graph, onSave, onClose }: Props) {
  const effectiveTheme = useEffectiveTheme()
  const withTypes = (ns: Node[]): Node[] => ns.map(n => {
    const t = (n.data as any).type
    const rfType = rfNodeType(t)
    const role = t === 'worker' ? workerRoles[(n.data as any).worker] : undefined
    return { ...n, type: rfType, data: { ...n.data, role } }
  })

  const initial = useMemo(() => toFlow(graph), [])
  const [nodes, setNodes] = useState<Node[]>(withTypes(initial.nodes as unknown as Node[]))
  const [edges, setEdges] = useState<Edge[]>(initial.edges as unknown as Edge[])
  const [maxHops, setMaxHops] = useState(graph.maxHops)
  const [selEdge, setSelEdge] = useState<string | null>(null)
  const [selNode, setSelNode] = useState<string | null>(null)
  const [showRaw, setShowRaw] = useState(false)
  const [justSaved, setJustSaved] = useState(false)

  const current = (): TeamGraph =>
    fromFlow(nodes as any, edges as any, graph.entry, maxHops)
  const problems = validateGraph(current(), workerNames)

  // Which nodes/edges does validation complain about? Problem messages quote the
  // offending id (e.g. condition node "n_5"), so pull those out and flag them.
  const badNodes = useMemo(() => {
    const ids = new Set(nodes.map(n => n.id))
    const bad = new Set<string>()
    for (const p of problems) for (const m of p.matchAll(/"([^"]+)"/g)) if (ids.has(m[1])) bad.add(m[1])
    return bad
  }, [problems, nodes])

  const onNodesChange = useCallback((cs: any) => setNodes(ns => applyNodeChanges(cs, ns)), [])
  const onEdgesChange = useCallback((cs: any) => setEdges(es => applyEdgeChanges(cs, es)), [])
  const onConnect = useCallback((c: Connection) =>
    setEdges(es => {
      const fromNode = nodes.find(n => n.id === c.source)
      let data: any = {}
      if ((fromNode?.data as any)?.type === 'condition') {
        const existing = es.filter(e => e.source === c.source)
        if (existing.length >= 2) return es // a diamond has exactly two outcomes
        // First branch out of a diamond defaults to "yes", the second to "no",
        // so a freshly-wired diamond is already valid. Flip either in the panel.
        data = { branch: existing.some(e => (e as any).data?.branch === 'yes') ? 'no' : 'yes' }
      }
      return addEdge({
        ...c, id: `e_${Date.now()}`,
        sourceHandle: c.sourceHandle ?? undefined,
        targetHandle: c.targetHandle ?? undefined,
        label: data.branch,
        data,
      } as any, es)
    }), [nodes])

  const rf = useReactFlow()
  const addWorker = (worker: string) => {
    setNodes(ns => {
      const id = newNodeId(ns.map(n => n.id))
      return [...ns, { id, type: 'workerNode', position: { x: 200, y: 60 + ns.length * 70 }, data: { label: worker, type: 'worker', worker, role: workerRoles[worker] } } as any]
    })
  }
  const addCondition = () => {
    setNodes(ns => {
      const id = newNodeId(ns.map(n => n.id))
      return [...ns, { id, type: 'conditionNode', position: { x: 260, y: 60 + ns.length * 70 }, data: { label: 'condition', type: 'condition' } } as any]
    })
  }
  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    const raw = e.dataTransfer.getData('application/codey-node')
    if (!raw) return
    let payload: { kind: 'worker' | 'condition'; worker?: string }
    try { payload = JSON.parse(raw) } catch { return }
    const position = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY })
    if (payload.kind === 'condition') {
      setNodes(ns => {
        const id = newNodeId(ns.map(n => n.id))
        return [...ns, { id, type: 'conditionNode', position, data: { label: 'condition', type: 'condition' } } as any]
      })
    } else {
      if (!payload.worker) return
      setNodes(ns => {
        const id = newNodeId(ns.map(n => n.id))
        return [...ns, { id, type: 'workerNode', position, data: { label: payload.worker, type: 'worker', worker: payload.worker, role: workerRoles[payload.worker!] } } as any]
      })
    }
  }, [rf, workerRoles])
  const onDragOver = useCallback((e: React.DragEvent) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move' }, [])
  const updateEdge = (id: string, patch: any) =>
    setEdges(es => es.map(e => e.id === id ? { ...e, data: { ...(e as any).data, ...patch }, label: patch.isDefault ? 'default' : patch.condition ?? (e as any).data?.condition } : e))
  const updateNodeData = (id: string, patch: any) =>
    setNodes(ns => ns.map(n => n.id === id ? { ...n, data: { ...n.data, ...patch } } : n))

  const updateEdgeBranch = (id: string, branch: 'yes' | 'no') =>
    setEdges(es => es.map(e => e.id === id ? { ...e, data: { ...(e as any).data, branch }, label: branch } : e))

  // Swap an edge's direction. Edges take their direction from the drag, so a
  // backwards edge (which leaves a node unreachable) is fixed with one click.
  const reverseEdge = (id: string) =>
    setEdges(es => es.map(e => e.id === id
      ? { ...e, source: e.target, target: e.source, sourceHandle: (e as any).targetHandle, targetHandle: (e as any).sourceHandle }
      : e))

  // Flip every edge at once — rescues a flow drawn the wrong way round (all
  // arrows pointing back at start), which otherwise reads as "unreachable".
  const reverseAllEdges = () =>
    setEdges(es => es.map(e => ({ ...e, source: e.target, target: e.source, sourceHandle: (e as any).targetHandle, targetHandle: (e as any).sourceHandle })))

  // Edges reachable from the start node "run" (carry a travelling dot). Walk the
  // graph from start so a flow lights up as soon as nodes wire back to it.
  const runningEdgeIds = useMemo(() => {
    const startId = nodes.find(n => (n.data as any)?.type === 'start')?.id
    const active = new Set<string>()
    if (!startId) return active
    const seen = new Set<string>([startId])
    const queue = [startId]
    while (queue.length) {
      const cur = queue.shift()!
      for (const e of edges) {
        if (e.source !== cur) continue
        active.add(e.id)
        if (!seen.has(e.target)) { seen.add(e.target); queue.push(e.target) }
      }
    }
    return active
  }, [nodes, edges])

  const styledEdges = useMemo(() => edges.map(e => {
    const running = runningEdgeIds.has(e.id)
    const markerColor = resolveColor(running || e.selected ? C.accent : C.fg2)
    return {
      ...e,
      type: 'flowEdge',
      markerEnd: { type: MarkerType.ArrowClosed, color: markerColor },
      data: { ...(e as any).data, running },
    }
  }), [edges, runningEdgeIds, effectiveTheme])

  // Inject the per-node `bad` flag so node views can paint themselves red.
  const styledNodes = useMemo(() => nodes.map(n => ({
    ...n, data: { ...n.data, bad: badNodes.has(n.id) },
  })), [nodes, badNodes])

  const save = () => { onSave(current()); setJustSaved(true); window.setTimeout(() => setJustSaved(false), 1600) }

  const sel = edges.find(e => e.id === selEdge) as any
  const selN = nodes.find(n => n.id === selNode) as any
  const selfLoops = selN ? edges.some(e => e.source === selN.id && e.target === selN.id) : false
  // An edge that leaves a condition node is a branch — it needs a yes/no label,
  // even if `branch` is currently unset (e.g. it was drawn into the diamond and
  // then reversed, which never assigned one).
  const selIsBranch = sel ? (nodes.find(n => n.id === sel.source)?.data as any)?.type === 'condition' : false

  const secondaryBtn = { fontSize: 12, background: C.surface2, color: C.fg, border: `1px solid ${C.border2}`, borderRadius: 6, padding: '4px 12px', cursor: 'pointer' } as const

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div onClick={e => e.stopPropagation()} style={{ width: '90vw', height: '85vh', background: C.bg, border: `1px solid ${C.border}`, borderRadius: 10, display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px', borderBottom: `1px solid ${C.border}` }}>
          <strong style={{ flex: 1 }}>Workflow — {teamName}</strong>
          <label style={{ fontSize: 12, color: C.fg }}>max hops <input type="number" min={1} value={maxHops} onChange={e => setMaxHops(Math.max(1, Number(e.target.value) || 1))} style={{ width: 56, marginLeft: 6, background: C.surface3, color: C.fg, border: `1px solid ${C.border2}`, borderRadius: 4, padding: '2px 6px', colorScheme: effectiveTheme, WebkitAppearance: 'textfield' }} /></label>
          <button onClick={reverseAllEdges} title="Flip the direction of every edge" style={secondaryBtn}>⇄ Reverse all</button>
          <button onClick={() => setShowRaw(s => !s)} style={secondaryBtn}>{showRaw ? 'Canvas' : 'Raw config'}</button>
          {justSaved && <span style={{ fontSize: 12, color: C.green }}>Saved ✓</span>}
          <button onClick={save} style={{ fontSize: 12, color: C.onAccent, background: C.accent, border: 'none', borderRadius: 6, padding: '4px 12px' }}>Save</button>
          <button onClick={onClose} style={secondaryBtn}>Close</button>
        </div>
        {problems.length > 0 && (
          <div style={{ background: C.dangerBg, color: C.dangerFg, fontSize: 11, padding: '4px 12px' }}>{problems.join(' · ')}</div>
        )}
        <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
          {!showRaw && (
            <div style={{ width: 160, borderRight: `1px solid ${C.border}`, padding: 10, overflowY: 'auto' }}>
              <div style={{ fontSize: 11, color: C.fg3, marginBottom: 6 }}>Workers</div>
              {workerNames.map(w => (
                <button key={w} draggable
                  onDragStart={e => e.dataTransfer.setData('application/codey-node', JSON.stringify({ kind: 'worker', worker: w }))}
                  onClick={() => addWorker(w)}
                  style={{ display: 'block', width: '100%', textAlign: 'left', marginBottom: 4, fontSize: 12, padding: '8px 8px', minHeight: 40, background: C.surface3, color: C.fg, border: `1px solid ${C.border2}`, borderRadius: 6, cursor: 'pointer' }}>
                  <div style={{ fontWeight: 600 }}>+ {w}</div>
                  {workerRoles[w] && <div style={{ fontSize: 10, color: C.fg2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{workerRoles[w]}</div>}
                </button>
              ))}
              <button draggable
                onDragStart={e => e.dataTransfer.setData('application/codey-node', JSON.stringify({ kind: 'condition' }))}
                onClick={() => addCondition()}
                style={{ display: 'block', width: '100%', marginTop: 8, fontSize: 12, padding: '6px', background: C.surface3, color: C.fg, border: `1px dashed ${C.accent}`, borderRadius: 6, cursor: 'pointer' }}>◇ + Condition</button>
            </div>
          )}
          {showRaw ? (
            <pre style={{ flex: 1, margin: 0, padding: 14, overflow: 'auto', fontSize: 12, color: C.fg }}>{JSON.stringify(current(), null, 2)}</pre>
          ) : (
            <div style={{ flex: 1, position: 'relative' }} onDrop={onDrop} onDragOver={onDragOver}>
              <ReactFlow nodes={styledNodes} edges={styledEdges} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={onConnect} onEdgeClick={(_, e) => { setSelEdge(e.id); setSelNode(null) }} onNodeClick={(_, n) => { setSelNode(n.id); setSelEdge(null) }} onNodesDelete={(ns) => { if (ns.some(n => n.id === selNode)) setSelNode(null) }} onEdgesDelete={(es) => { if (es.some(e => e.id === selEdge)) setSelEdge(null) }} nodeTypes={nodeTypes} edgeTypes={edgeTypes} connectionMode={ConnectionMode.Loose} fitView fitViewOptions={{ maxZoom: 1, padding: 0.2 }} minZoom={0.2} maxZoom={1.5} colorMode={effectiveTheme}>
                <Background style={{ '--xy-background-color': C.bg, '--xy-background-pattern-color': C.border2 } as React.CSSProperties} />
                <Controls style={{ '--xy-controls-button-background-color': C.surface2, '--xy-controls-button-background-color-hover': C.surface3, '--xy-controls-button-color': C.fg, '--xy-controls-button-border-color': C.border2 } as React.CSSProperties} />
              </ReactFlow>
            </div>
          )}
          {!showRaw && selN && (selN.data?.type === 'worker' || selN.data?.type === 'condition') && (
            <div style={{ width: 240, borderLeft: `1px solid ${C.border}`, padding: 10, overflowY: 'auto' }}>
              {selN.data?.type === 'worker' ? (
                <>
                  <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>{selN.data.worker}</div>
                  <div style={{ fontSize: 11, color: C.fg2, marginBottom: 10, whiteSpace: 'pre-wrap' }}>
                    {workerRoles[selN.data.worker] || 'No description.'}
                  </div>
                  {selfLoops && (
                    <label style={{ fontSize: 12, display: 'block' }}>
                      Max self-loops
                      <input type="number" min={1} value={selN.data.maxCalls ?? ''} placeholder="3"
                        onChange={e => updateNodeData(selN.id, { maxCalls: e.target.value === '' ? undefined : Math.max(1, Number(e.target.value) || 1) })}
                        style={{ width: 64, marginLeft: 6, background: C.surface3, color: C.fg, border: `1px solid ${C.border2}`, borderRadius: 4, padding: '2px 6px', colorScheme: effectiveTheme, WebkitAppearance: 'textfield' }} />
                    </label>
                  )}
                </>
              ) : (
                <>
                  <div style={{ fontSize: 11, color: C.fg3, marginBottom: 6 }}>Decision</div>
                  <textarea value={selN.data.condition ?? ''} placeholder='e.g. "Did the tests pass?"'
                    onChange={e => updateNodeData(selN.id, { condition: e.target.value })}
                    style={{ width: '100%', minHeight: 70, fontSize: 12, padding: 6, background: C.surface2, color: C.fg, border: `1px solid ${C.border}`, borderRadius: 6 }} />
                  <div style={{ fontSize: 10, color: C.fg3, marginTop: 6 }}>Draw two edges out — label each yes / no by clicking it.</div>
                </>
              )}
            </div>
          )}
          {!showRaw && !selN && sel && selIsBranch && (
            <div style={{ width: 220, borderLeft: `1px solid ${C.border}`, padding: 10 }}>
              <div style={{ fontSize: 11, color: C.fg3, marginBottom: 6 }}>Branch</div>
              <div style={{ display: 'flex', gap: 6 }}>
                {(['yes', 'no'] as const).map(b => (
                  <button key={b} onClick={() => updateEdgeBranch(sel.id, b)}
                    style={{ flex: 1, fontSize: 12, padding: '6px 0', borderRadius: 6, cursor: 'pointer',
                      background: sel.data?.branch === b ? C.accent : C.surface2,
                      color: sel.data?.branch === b ? C.onAccent : C.fg,
                      border: `1px solid ${sel.data?.branch === b ? C.accent : C.border}` }}>{b}</button>
                ))}
              </div>
              {sel.data?.branch === undefined && <div style={{ fontSize: 10, color: C.dangerFg, marginTop: 6 }}>Unlabeled — pick yes or no.</div>}
              <button onClick={() => reverseEdge(sel.id)} style={{ marginTop: 10, width: '100%', fontSize: 12, padding: '6px 0', borderRadius: 6, cursor: 'pointer', background: C.surface2, color: C.fg, border: `1px solid ${C.border}` }}>⇄ Reverse direction</button>
            </div>
          )}
          {!showRaw && !selN && sel && !selIsBranch && (
            <div style={{ width: 220, borderLeft: `1px solid ${C.border}`, padding: 10 }}>
              <div style={{ fontSize: 11, color: C.fg3, marginBottom: 6 }}>Edge condition</div>
              <textarea value={sel.data?.condition ?? ''} onChange={e => updateEdge(sel.id, { condition: e.target.value, isDefault: false })} placeholder='e.g. "tests pass"' style={{ width: '100%', minHeight: 70, fontSize: 12, padding: 6, background: C.surface2, color: C.fg, border: `1px solid ${C.border}`, borderRadius: 6 }} />
              <label style={{ fontSize: 12, display: 'block', marginTop: 8 }}>
                <input type="checkbox" checked={!!sel.data?.isDefault} onChange={e => updateEdge(sel.id, { isDefault: e.target.checked, condition: e.target.checked ? undefined : sel.data?.condition })} /> default (else) edge
              </label>
              <button onClick={() => reverseEdge(sel.id)} style={{ marginTop: 10, width: '100%', fontSize: 12, padding: '6px 0', borderRadius: 6, cursor: 'pointer', background: C.surface2, color: C.fg, border: `1px solid ${C.border}` }}>⇄ Reverse direction</button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export default function FlowEditor(props: Props) {
  return <ReactFlowProvider><FlowEditorInner {...props} /></ReactFlowProvider>
}
