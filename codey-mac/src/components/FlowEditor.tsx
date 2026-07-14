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
import { UIIcon } from './UIIcons'

const menuItemStyle = {
  width: '100%', display: 'flex', alignItems: 'center', gap: 8, padding: '8px',
  background: 'transparent', color: C.fg2, border: 'none', borderRadius: 7,
  fontSize: 11, textAlign: 'left', cursor: 'pointer',
} as const

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
  const [toolbarMenuOpen, setToolbarMenuOpen] = useState(false)

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

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(9,12,20,0.65)', backdropFilter: 'blur(10px)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div onClick={e => e.stopPropagation()} style={{ width: '92vw', height: '88vh', background: C.surface, border: `1px solid ${C.border2}`, borderRadius: 18, boxShadow: '0 30px 90px rgba(0,0,0,0.48)', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 11, minHeight: 62, padding: '10px 14px 10px 16px', borderBottom: `1px solid ${C.border}`, background: C.surface }}>
          <span style={{ width: 34, height: 34, borderRadius: 10, display: 'grid', placeItems: 'center', background: C.accentDim, color: C.accent }}><UIIcon name="activity" size={17} /></span>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 760, color: C.fg, fontSize: 13 }}>{teamName}</div>
            <div style={{ fontSize: 10, color: C.fg3, marginTop: 2 }}>Workflow editor</div>
          </div>
          <span style={{ marginLeft: 4, display: 'inline-flex', alignItems: 'center', gap: 5, padding: '4px 8px', borderRadius: 12, fontSize: 10, fontWeight: 650, color: problems.length ? C.dangerFg : C.green, background: problems.length ? C.dangerBg : C.accentDim, border: `1px solid ${problems.length ? C.dangerBorder : C.border}` }}>
            <span style={{ width: 5, height: 5, borderRadius: '50%', background: 'currentColor' }} />
            {problems.length ? `${problems.length} issue${problems.length === 1 ? '' : 's'}` : 'Ready'}
          </span>
          <div style={{ flex: 1 }} />
          <button onClick={save} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, fontWeight: 750, color: C.onAccent, background: C.accent, border: 'none', borderRadius: 9, padding: '8px 12px', cursor: 'pointer', minWidth: 70, justifyContent: 'center' }}>
            <UIIcon name={justSaved ? 'check' : 'archive'} size={14} />{justSaved ? 'Saved' : 'Save'}
          </button>
          <div style={{ position: 'relative' }}>
            <button onClick={() => setToolbarMenuOpen(v => !v)} aria-label="Workflow options" title="Workflow options" style={{ width: 34, height: 34, display: 'grid', placeItems: 'center', padding: 0, borderRadius: 9, background: C.surface2, color: C.fg2, border: `1px solid ${C.border}`, cursor: 'pointer' }}><UIIcon name="more" size={16} /></button>
            {toolbarMenuOpen && (
              <div style={{ position: 'absolute', top: 40, right: 0, zIndex: 20, width: 196, padding: 7, borderRadius: 11, background: C.surface, border: `1px solid ${C.border2}`, boxShadow: '0 14px 36px rgba(0,0,0,0.3)' }}>
                <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '7px 8px', fontSize: 11, color: C.fg2 }}>
                  Maximum hops
                  <input type="number" min={1} value={maxHops} onChange={e => setMaxHops(Math.max(1, Number(e.target.value) || 1))} style={{ width: 52, background: C.surface3, color: C.fg, border: `1px solid ${C.border2}`, borderRadius: 6, padding: '4px 6px', colorScheme: effectiveTheme, WebkitAppearance: 'textfield' }} />
                </label>
                <div style={{ height: 1, background: C.border, margin: '4px 2px' }} />
                <button onClick={() => { setShowRaw(s => !s); setToolbarMenuOpen(false) }} style={menuItemStyle}><UIIcon name="code" size={14} />{showRaw ? 'Return to canvas' : 'View configuration'}</button>
                <button onClick={() => { reverseAllEdges(); setToolbarMenuOpen(false) }} title="Flip the direction of every edge" style={menuItemStyle}><UIIcon name="refresh" size={14} />Reverse all connections</button>
              </div>
            )}
          </div>
          <button onClick={onClose} aria-label="Close workflow editor" title="Close" style={{ width: 34, height: 34, display: 'grid', placeItems: 'center', padding: 0, borderRadius: 9, background: 'transparent', color: C.fg3, border: 'none', cursor: 'pointer' }}><UIIcon name="close" size={17} /></button>
        </div>
        {problems.length > 0 && (
          <div style={{ background: C.dangerBg, color: C.dangerFg, borderBottom: `1px solid ${C.dangerBorder}`, fontSize: 10, lineHeight: 1.4, padding: '6px 16px' }}>{problems.join(' · ')}</div>
        )}
        <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
          {!showRaw && (
            <div style={{ width: 178, borderRight: `1px solid ${C.border}`, padding: '13px 10px', overflowY: 'auto', background: C.surface2 }}>
              <div style={{ padding: '0 3px', fontSize: 10, fontWeight: 720, letterSpacing: 0.65, textTransform: 'uppercase', color: C.fg3 }}>Steps</div>
              <div style={{ padding: '3px 3px 10px', fontSize: 9, color: C.fg3 }}>Click or drag onto the canvas</div>
              {workerNames.map(w => (
                <button key={w} draggable
                  onDragStart={e => e.dataTransfer.setData('application/codey-node', JSON.stringify({ kind: 'worker', worker: w }))}
                  onClick={() => addWorker(w)}
                  style={{ display: 'flex', width: '100%', alignItems: 'center', gap: 7, textAlign: 'left', marginBottom: 5, fontSize: 11, padding: '8px', background: C.surface, color: C.fg, border: `1px solid ${C.border}`, borderRadius: 8, cursor: 'grab' }}>
                  <span style={{ color: C.accent, display: 'inline-flex' }}><UIIcon name="bot" size={13} /></span><span style={{ fontWeight: 680, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{w}</span>
                </button>
              ))}
              <button draggable
                onDragStart={e => e.dataTransfer.setData('application/codey-node', JSON.stringify({ kind: 'condition' }))}
                onClick={() => addCondition()}
                style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, width: '100%', marginTop: 9, fontSize: 11, fontWeight: 680, padding: '8px', background: C.accentDim, color: C.accent, border: `1px dashed ${C.accent}`, borderRadius: 8, cursor: 'pointer' }}><UIIcon name="sparkle" size={13} />Decision</button>
            </div>
          )}
          {showRaw ? (
            <pre style={{ flex: 1, margin: 0, padding: 14, overflow: 'auto', fontSize: 12, color: C.fg }}>{JSON.stringify(current(), null, 2)}</pre>
          ) : (
            <div style={{ flex: 1, position: 'relative', background: C.bg }} onDrop={onDrop} onDragOver={onDragOver}>
              <ReactFlow nodes={styledNodes} edges={styledEdges} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={onConnect} onEdgeClick={(_, e) => { setSelEdge(e.id); setSelNode(null) }} onNodeClick={(_, n) => { setSelNode(n.id); setSelEdge(null) }} onNodesDelete={(ns) => { if (ns.some(n => n.id === selNode)) setSelNode(null) }} onEdgesDelete={(es) => { if (es.some(e => e.id === selEdge)) setSelEdge(null) }} nodeTypes={nodeTypes} edgeTypes={edgeTypes} connectionMode={ConnectionMode.Loose} fitView fitViewOptions={{ maxZoom: 1, padding: 0.2 }} minZoom={0.2} maxZoom={1.5} colorMode={effectiveTheme}>
                <Background style={{ '--xy-background-color': C.bg, '--xy-background-pattern-color': C.border2 } as React.CSSProperties} />
                <Controls style={{ '--xy-controls-button-background-color': C.surface2, '--xy-controls-button-background-color-hover': C.surface3, '--xy-controls-button-color': C.fg, '--xy-controls-button-border-color': C.border2 } as React.CSSProperties} />
              </ReactFlow>
            </div>
          )}
          {!showRaw && selN && (selN.data?.type === 'worker' || selN.data?.type === 'condition') && (
            <div style={{ width: 250, borderLeft: `1px solid ${C.border}`, padding: 15, overflowY: 'auto', background: C.surface2 }}>
              {selN.data?.type === 'worker' ? (
                <>
                  <div style={{ fontSize: 9, fontWeight: 720, letterSpacing: 0.65, textTransform: 'uppercase', color: C.fg3, marginBottom: 9 }}>Selected step</div>
                  <span style={{ width: 30, height: 30, display: 'grid', placeItems: 'center', borderRadius: 8, background: C.accentDim, color: C.accent, marginBottom: 10 }}><UIIcon name="bot" size={15} /></span>
                  <div style={{ fontSize: 13, color: C.fg, fontWeight: 720, marginBottom: 5 }}>{selN.data.worker}</div>
                  <div style={{ fontSize: 10, lineHeight: 1.45, color: C.fg2, marginBottom: 14, whiteSpace: 'pre-wrap' }}>
                    {workerRoles[selN.data.worker] || 'No description.'}
                  </div>
                  {selfLoops && (
                    <label style={{ fontSize: 10, color: C.fg2, display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingTop: 10, borderTop: `1px solid ${C.border}` }}>
                      Max self-loops
                      <input type="number" min={1} value={selN.data.maxCalls ?? ''} placeholder="3"
                        onChange={e => updateNodeData(selN.id, { maxCalls: e.target.value === '' ? undefined : Math.max(1, Number(e.target.value) || 1) })}
                        style={{ width: 58, background: C.surface3, color: C.fg, border: `1px solid ${C.border2}`, borderRadius: 6, padding: '4px 6px', colorScheme: effectiveTheme, WebkitAppearance: 'textfield' }} />
                    </label>
                  )}
                </>
              ) : (
                <>
                  <div style={{ fontSize: 9, fontWeight: 720, letterSpacing: 0.65, textTransform: 'uppercase', color: C.fg3, marginBottom: 9 }}>Selected decision</div>
                  <div style={{ fontSize: 11, color: C.fg2, marginBottom: 6 }}>Question</div>
                  <textarea value={selN.data.condition ?? ''} placeholder='e.g. "Did the tests pass?"'
                    onChange={e => updateNodeData(selN.id, { condition: e.target.value })}
                    style={{ width: '100%', minHeight: 82, fontSize: 11, lineHeight: 1.4, padding: 9, background: C.surface, color: C.fg, border: `1px solid ${C.border2}`, borderRadius: 8, resize: 'vertical' }} />
                  <div style={{ fontSize: 9, lineHeight: 1.4, color: C.fg3, marginTop: 7 }}>Connect two outgoing paths, then label them yes and no.</div>
                </>
              )}
            </div>
          )}
          {!showRaw && !selN && sel && selIsBranch && (
            <div style={{ width: 240, borderLeft: `1px solid ${C.border}`, padding: 15, background: C.surface2 }}>
              <div style={{ fontSize: 9, fontWeight: 720, letterSpacing: 0.65, textTransform: 'uppercase', color: C.fg3, marginBottom: 10 }}>Selected branch</div>
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
            <div style={{ width: 240, borderLeft: `1px solid ${C.border}`, padding: 15, background: C.surface2 }}>
              <div style={{ fontSize: 9, fontWeight: 720, letterSpacing: 0.65, textTransform: 'uppercase', color: C.fg3, marginBottom: 10 }}>Selected connection</div>
              <textarea value={sel.data?.condition ?? ''} onChange={e => updateEdge(sel.id, { condition: e.target.value, isDefault: false })} placeholder='e.g. "tests pass"' style={{ width: '100%', minHeight: 78, fontSize: 11, padding: 9, background: C.surface, color: C.fg, border: `1px solid ${C.border2}`, borderRadius: 8 }} />
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
