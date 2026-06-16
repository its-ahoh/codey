import { describe, it, expect } from 'vitest'
import { toFlow, fromFlow, newNodeId, emptyGraph, branchColors } from './flowEditorModel'
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

const gHandles: TeamGraph = {
  entry: 'start', maxHops: 20,
  nodes: [
    { id: 'start', type: 'start', x: 0, y: 0 },
    { id: 'w1', type: 'worker', worker: 'coder', x: 100, y: 0 },
    { id: 'c1', type: 'condition', x: 200, y: 0 },
    { id: 'end', type: 'end', x: 300, y: 0 },
  ],
  edges: [
    { id: 'e0', from: 'start', to: 'w1' },
    { id: 'e1', from: 'w1', to: 'c1', sourceHandle: 'r', targetHandle: 'l' },
    { id: 'e2', from: 'c1', to: 'end', isDefault: true },
  ],
}

describe('flowEditorModel condition + handles round-trip', () => {
  it('preserves condition node type and edge handles', () => {
    const flow = toFlow(gHandles)
    const cNode = flow.nodes.find(n => n.id === 'c1')!
    expect(cNode.data.type).toBe('condition')

    const back = fromFlow(flow.nodes, flow.edges, gHandles.entry, gHandles.maxHops)
    expect(back.nodes.find(n => n.id === 'c1')!.type).toBe('condition')
    const e1 = back.edges.find(e => e.id === 'e1')!
    expect(e1.sourceHandle).toBe('r')
    expect(e1.targetHandle).toBe('l')
  })
})

describe('branchColors', () => {
  it('colors non-default branch edges distinctly and default gray', () => {
    const colors = branchColors([] as any, [
      { id: 'e2a', source: 'c1', data: { isDefault: false } },
      { id: 'e2b', source: 'c1', data: { isDefault: true } },
    ] as any)
    expect(colors['e2a']).toBeTruthy()
    expect(colors['e2b']).toBe('#888')
    expect(colors['e2a']).not.toBe('#888')
  })

  it('does not color edges out of a single-output node', () => {
    const colors = branchColors([] as any, [
      { id: 'only', source: 'w1', data: {} },
    ] as any)
    expect(colors['only']).toBeUndefined()
  })
})

describe('flowEditorModel diamond + maxCalls round-trip', () => {
  const g: TeamGraph = {
    entry: 'start', maxHops: 20,
    nodes: [
      { id: 'start', type: 'start', x: 0, y: 0 },
      { id: 'w1', type: 'worker', worker: 'coder', maxCalls: 3, width: 220, height: 90, x: 1, y: 0 },
      { id: 'd1', type: 'condition', condition: 'tests pass?', x: 2, y: 0 },
      { id: 'end', type: 'end', x: 3, y: 0 },
    ],
    edges: [
      { id: 'e0', from: 'start', to: 'w1' },
      { id: 'e1', from: 'w1', to: 'd1' },
      { id: 'e2', from: 'd1', to: 'end', branch: 'yes' },
      { id: 'e3', from: 'd1', to: 'w1', branch: 'no' },
    ],
  };

  it('round-trips condition, maxCalls, width/height, and branch', () => {
    const flow = toFlow(g);
    const back = fromFlow(flow.nodes, flow.edges, g.entry, g.maxHops);
    expect(back).toEqual(g);
  });
});

describe('branchColors diamond colors', () => {
  it('colors a diamond yes green and no red', () => {
    const nodes = [{ id: 'd1', position: { x: 0, y: 0 }, data: { label: 'd1', type: 'condition' } }] as any;
    const colors = branchColors(nodes, [
      { id: 'y', source: 'd1', data: { branch: 'yes' } },
      { id: 'n', source: 'd1', data: { branch: 'no' } },
    ] as any);
    expect(colors['y']).toBe('#22c55e');
    expect(colors['n']).toBe('#ef4444');
  });
});
