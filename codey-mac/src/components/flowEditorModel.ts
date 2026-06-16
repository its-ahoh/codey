import type { TeamGraph, TeamGraphNode, TeamGraphEdge } from '../../../packages/core/src/team-graph'

export interface FlowNode { id: string; position: { x: number; y: number }; data: { label: string; type: TeamGraphNode['type']; worker?: string }; type?: string }
export interface FlowEdge { id: string; source: string; target: string; sourceHandle?: string; targetHandle?: string; label?: string; data: { condition?: string; isDefault?: boolean } }

export function toFlow(g: TeamGraph): { nodes: FlowNode[]; edges: FlowEdge[] } {
  const nodes = g.nodes.map(n => ({
    id: n.id,
    position: { x: n.x, y: n.y },
    data: { label: n.type === 'worker' ? (n.worker ?? '?') : n.type, type: n.type, worker: n.worker },
  }))
  const edges = g.edges.map(e => ({
    id: e.id, source: e.from, target: e.to,
    sourceHandle: e.sourceHandle, targetHandle: e.targetHandle,
    label: e.isDefault ? 'default' : e.condition,
    data: { condition: e.condition, isDefault: e.isDefault },
  }))
  return { nodes, edges }
}

export function fromFlow(nodes: FlowNode[], edges: FlowEdge[], entry: string, maxHops: number): TeamGraph {
  const gNodes: TeamGraphNode[] = nodes.map(n => {
    const node: TeamGraphNode = { id: n.id, type: n.data.type, x: Math.round(n.position.x), y: Math.round(n.position.y) }
    if (n.data.worker !== undefined) node.worker = n.data.worker
    return node
  })
  const gEdges: TeamGraphEdge[] = edges.map(e => {
    const edge: TeamGraphEdge = { id: e.id, from: e.source, to: e.target }
    if (e.data.condition !== undefined) edge.condition = e.data.condition
    if (e.data.isDefault !== undefined) edge.isDefault = e.data.isDefault
    if (e.sourceHandle) edge.sourceHandle = e.sourceHandle
    if (e.targetHandle) edge.targetHandle = e.targetHandle
    return edge
  })
  return { entry, maxHops, nodes: gNodes, edges: gEdges }
}

export function newNodeId(existing: string[]): string {
  let i = 1
  while (existing.includes(`n_${i}`)) i++
  return `n_${i}`
}

export function emptyGraph(): TeamGraph {
  return {
    entry: 'start', maxHops: 20,
    nodes: [
      { id: 'start', type: 'start', x: 40, y: 120 },
      { id: 'end', type: 'end', x: 480, y: 120 },
    ],
    edges: [],
  }
}

const BRANCH_PALETTE = ['#3b82f6', '#22c55e', '#f59e0b', '#a855f7', '#ec4899', '#14b8a6']

/**
 * Map edge id -> color for edges leaving a branch node (a node with >1 outgoing
 * edge). Non-default edges get distinct palette colors by index; the default
 * (else) edge is gray. Edges from single-output nodes are left uncolored.
 */
export function branchColors(_nodes: FlowNode[], edges: FlowEdge[]): Record<string, string> {
  const bySource = new Map<string, FlowEdge[]>()
  for (const e of edges) {
    if (!bySource.has(e.source)) bySource.set(e.source, [])
    bySource.get(e.source)!.push(e)
  }
  const out: Record<string, string> = {}
  for (const group of bySource.values()) {
    if (group.length < 2) continue
    let i = 0
    for (const e of group) {
      out[e.id] = e.data?.isDefault ? '#888' : BRANCH_PALETTE[i++ % BRANCH_PALETTE.length]
    }
  }
  return out
}
