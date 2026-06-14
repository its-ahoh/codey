import { describe, it, expect } from 'vitest';
import { validateGraph, TeamGraph } from './team-graph';

function baseGraph(): TeamGraph {
  return {
    entry: 'start',
    maxHops: 20,
    nodes: [
      { id: 'start', type: 'start', x: 0, y: 0 },
      { id: 'n_coder', type: 'worker', worker: 'coder', x: 100, y: 0 },
      { id: 'end', type: 'end', x: 200, y: 0 },
    ],
    edges: [
      { id: 'e1', from: 'start', to: 'n_coder' },
      { id: 'e2', from: 'n_coder', to: 'end', isDefault: true },
    ],
  };
}

describe('validateGraph', () => {
  it('accepts a valid linear graph', () => {
    expect(validateGraph(baseGraph(), ['coder'])).toEqual([]);
  });

  it('flags a missing entry node', () => {
    const g = baseGraph(); g.entry = 'nope';
    expect(validateGraph(g, ['coder'])).toContain('entry node "nope" does not exist');
  });

  it('flags a worker node referencing an unknown worker', () => {
    expect(validateGraph(baseGraph(), [])).toContain('node "n_coder" references unknown worker "coder"');
  });

  it('flags a worker node missing its worker field', () => {
    const g = baseGraph();
    g.nodes[1] = { id: 'n_coder', type: 'worker', x: 100, y: 0 } as any;
    expect(validateGraph(g, ['coder'])).toContain('worker node "n_coder" is missing a worker');
  });

  it('flags an edge endpoint that does not exist', () => {
    const g = baseGraph(); g.edges[1].to = 'ghost';
    expect(validateGraph(g, ['coder'])).toContain('edge "e2" points to missing node "ghost"');
  });

  it('flags a non-terminal worker node with no outgoing edge', () => {
    const g = baseGraph(); g.edges = g.edges.filter(e => e.id !== 'e2');
    expect(validateGraph(g, ['coder'])).toContain('worker node "n_coder" has no outgoing edge');
  });

  it('flags an unreachable node', () => {
    const g = baseGraph();
    g.nodes.push({ id: 'orphan', type: 'worker', worker: 'coder', x: 0, y: 99 });
    expect(validateGraph(g, ['coder'])).toContain('node "orphan" is unreachable from entry');
  });
});
