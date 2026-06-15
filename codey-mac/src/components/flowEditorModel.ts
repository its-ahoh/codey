import type { TeamGraph, TeamGraphNode, TeamGraphEdge } from '../../../packages/core/src/team-graph'

export interface FlowNode { id: string; position: { x: number; y: number }; data: { label: string; type: TeamGraphNode['type']; worker?: string }; type?: string }
export interface FlowEdge { id: string; source: string; target: string; label?: string; data: { condition?: string; isDefault?: boolean } }

export function toFlow(g: TeamGraph): { nodes: FlowNode[]; edges: FlowEdge[] } {
  const nodes = g.nodes.map(n => ({
    id: n.id,
    position: { x: n.x, y: n.y },
    data: { label: n.type === 'worker' ? (n.worker ?? '?') : n.type, type: n.type, worker: n.worker },
  }))
  const edges = g.edges.map(e => ({
    id: e.id, source: e.from, target: e.to,
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
