import { describe, it, expect } from 'vitest'
import { toFlow, fromFlow, newNodeId, emptyGraph } from './flowEditorModel'
import type { TeamGraph } from '../../../packages/core/src/team-graph'

const g: TeamGraph = {
  entry: 'start', maxHops: 10,
  nodes: [
    { id: 'start', type: 'start', x: 0, y: 0 },
    { id: 'n1', type: 'worker', worker: 'coder', x: 50, y: 0 },
    { id: 'end', type: 'end', x: 100, y: 0 },
  ],
  edges: [
    { id: 'e1', from: 'start', to: 'n1' },
    { id: 'e2', from: 'n1', to: 'end', isDefault: true },
  ],
}

describe('flowEditorModel', () => {
  it('round-trips a graph through toFlow/fromFlow', () => {
    const { nodes, edges } = toFlow(g)
    expect(nodes).toHaveLength(3)
    expect(edges).toHaveLength(2)
    const back = fromFlow(nodes, edges, g.entry, g.maxHops)
    expect(back).toEqual(g)
  })

  it('emptyGraph has a start and an end node and an entry edge', () => {
    const e = emptyGraph()
    expect(e.nodes.some(n => n.type === 'start')).toBe(true)
    expect(e.nodes.some(n => n.type === 'end')).toBe(true)
  })

  it('newNodeId is unique against existing ids', () => {
    expect(newNodeId(['n_1', 'n_2'])).not.toBe('n_1')
  })
})
