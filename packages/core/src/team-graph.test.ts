import { describe, it, expect } from 'vitest';
import { validateGraph, TeamGraph, startRun, advance, outgoingEdges } from './team-graph';

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

describe('step machine', () => {
  it('starts at the first worker node after entry', () => {
    const g = baseGraph();
    const state = startRun(g);
    expect(state.currentNodeId).toBe('n_coder');
    expect(state.hops).toBe(0);
    expect(state.status).toBe('running');
  });

  it('lists outgoing edges for the current node', () => {
    const g = baseGraph();
    const state = startRun(g);
    expect(outgoingEdges(g, state.currentNodeId).map(e => e.id)).toEqual(['e2']);
  });

  it('advancing along an edge to an end node finishes the run', () => {
    const g = baseGraph();
    let state = startRun(g);
    state = advance(g, state, 'e2');
    expect(state.status).toBe('done');
    expect(state.hops).toBe(1);
  });

  it('loops back and counts hops', () => {
    const g = baseGraph();
    g.nodes.push({ id: 'n_review', type: 'worker', worker: 'reviewer', x: 150, y: 0 });
    g.edges = [
      { id: 'e1', from: 'start', to: 'n_coder' },
      { id: 'e2', from: 'n_coder', to: 'n_review', isDefault: true },
      { id: 'e3', from: 'n_review', to: 'n_coder', condition: 'work incomplete' },
      { id: 'e4', from: 'n_review', to: 'end', isDefault: true },
    ];
    let state = startRun(g);            // at n_coder, hops 0
    state = advance(g, state, 'e2');    // -> n_review, hops 1
    expect(state.currentNodeId).toBe('n_review');
    state = advance(g, state, 'e3');    // -> n_coder, hops 2
    expect(state.currentNodeId).toBe('n_coder');
    expect(state.status).toBe('running');
  });

  it('stops with status "capped" when maxHops is exceeded', () => {
    const g = baseGraph();
    g.maxHops = 1;
    g.nodes.push({ id: 'n_review', type: 'worker', worker: 'reviewer', x: 150, y: 0 });
    g.edges = [
      { id: 'e1', from: 'start', to: 'n_coder' },
      { id: 'e2', from: 'n_coder', to: 'n_review', isDefault: true },
      { id: 'e3', from: 'n_review', to: 'end', isDefault: true },
    ];
    let state = startRun(g);
    state = advance(g, state, 'e2');   // hops -> 1, at n_review
    expect(state.status).toBe('capped');
  });
});

function graphWithCondition(): TeamGraph {
  return {
    entry: 'start', maxHops: 20,
    nodes: [
      { id: 'start', type: 'start', x: 0, y: 0 },
      { id: 'w1', type: 'worker', worker: 'coder', x: 100, y: 0 },
      { id: 'c1', type: 'condition', condition: 'needs review?', x: 200, y: 0 },
      { id: 'w2', type: 'worker', worker: 'reviewer', x: 300, y: 0 },
      { id: 'end', type: 'end', x: 400, y: 0 },
    ],
    edges: [
      { id: 'e0', from: 'start', to: 'w1' },
      { id: 'e1', from: 'w1', to: 'c1' },
      { id: 'e2', from: 'c1', to: 'w2', branch: 'yes' },
      { id: 'e3', from: 'c1', to: 'end', branch: 'no' },
      { id: 'e4', from: 'w2', to: 'end', isDefault: true },
    ],
  };
}

describe('condition node settle', () => {
  it('settles onto a condition node without recording it in visited', () => {
    const g = graphWithCondition();
    let s = startRun(g);
    expect(s.currentNodeId).toBe('w1');
    s = advance(g, s, 'e1');
    expect(s.currentNodeId).toBe('c1');
    expect(s.status).toBe('running');
    expect(s.visited).toEqual(['w1']);
  });

  it('advances from a condition node to the next worker', () => {
    const g = graphWithCondition();
    let s = startRun(g);
    s = advance(g, s, 'e1');
    s = advance(g, s, 'e2');
    expect(s.currentNodeId).toBe('w2');
    expect(s.visited).toEqual(['w1', 'w2']);
  });
});

describe('condition node validation', () => {
  const workers = ['coder', 'reviewer'];

  it('rejects a condition node that carries a worker', () => {
    const g = graphWithCondition();
    (g.nodes.find(n => n.id === 'c1') as any).worker = 'coder';
    const problems = validateGraph(g, workers);
    expect(problems.some(p => p.includes('c1') && p.includes('worker'))).toBe(true);
  });

  it('rejects a condition node missing a yes or no branch edge', () => {
    const g = graphWithCondition();
    g.edges = g.edges.map(e => e.id === 'e3' ? { ...e, branch: undefined } : e);
    const problems = validateGraph(g, workers);
    expect(problems.some(p => p.includes('c1') && p.includes('one yes and one no'))).toBe(true);
  });

  it('accepts a well-formed condition node', () => {
    expect(validateGraph(graphWithCondition(), workers)).toEqual([]);
  });
});

describe('validateGraph — diamonds carry conditions', () => {
  const base = (over: Partial<import('./team-graph').TeamGraph> = {}) => ({
    entry: 'start', maxHops: 10,
    nodes: [
      { id: 'start', type: 'start', x: 0, y: 0 },
      { id: 'w1', type: 'worker', worker: 'coder', x: 1, y: 0 },
      { id: 'd1', type: 'condition', condition: 'tests pass?', x: 2, y: 0 },
      { id: 'end', type: 'end', x: 3, y: 0 },
    ],
    edges: [
      { id: 'e0', from: 'start', to: 'w1' },
      { id: 'e1', from: 'w1', to: 'd1' },
      { id: 'e2', from: 'd1', to: 'end', branch: 'yes' },
      { id: 'e3', from: 'd1', to: 'w1', branch: 'no' },
    ],
    ...over,
  } as import('./team-graph').TeamGraph);

  it('accepts a diamond with a question and one yes + one no edge', () => {
    expect(validateGraph(base(), ['coder'])).toEqual([]);
  });

  it('rejects a diamond with no question', () => {
    const g = base();
    g.nodes.find(n => n.id === 'd1')!.condition = '';
    expect(validateGraph(g, ['coder']).some(p => p.includes('needs a question'))).toBe(true);
  });

  it('rejects a diamond without exactly one yes and one no edge', () => {
    const g = base();
    g.edges.find(e => e.id === 'e3')!.branch = 'yes';
    expect(validateGraph(g, ['coder']).some(p => p.includes('one yes and one no'))).toBe(true);
  });
});

describe('validateGraph — worker self-loops', () => {
  it('rejects a worker self-loop with no exit edge', () => {
    const g: import('./team-graph').TeamGraph = {
      entry: 'start', maxHops: 10,
      nodes: [
        { id: 'start', type: 'start', x: 0, y: 0 },
        { id: 'w1', type: 'worker', worker: 'coder', maxCalls: 3, x: 1, y: 0 },
      ],
      edges: [
        { id: 'e0', from: 'start', to: 'w1' },
        { id: 'e1', from: 'w1', to: 'w1' },
      ],
    };
    expect(validateGraph(g, ['coder']).some(p => p.includes('self-loops with no exit'))).toBe(true);
  });

  it('rejects maxCalls < 1', () => {
    const g: import('./team-graph').TeamGraph = {
      entry: 'start', maxHops: 10,
      nodes: [
        { id: 'start', type: 'start', x: 0, y: 0 },
        { id: 'w1', type: 'worker', worker: 'coder', maxCalls: 0, x: 1, y: 0 },
        { id: 'end', type: 'end', x: 2, y: 0 },
      ],
      edges: [
        { id: 'e0', from: 'start', to: 'w1' },
        { id: 'e1', from: 'w1', to: 'end' },
      ],
    };
    expect(validateGraph(g, ['coder']).some(p => p.includes('maxCalls must be >= 1'))).toBe(true);
  });

  it('rejects non-integer maxCalls', () => {
    const g: import('./team-graph').TeamGraph = {
      entry: 'start', maxHops: 10,
      nodes: [
        { id: 'start', type: 'start', x: 0, y: 0 },
        { id: 'w1', type: 'worker', worker: 'coder', maxCalls: 1.5, x: 1, y: 0 },
        { id: 'end', type: 'end', x: 2, y: 0 },
      ],
      edges: [
        { id: 'e0', from: 'start', to: 'w1' },
        { id: 'e1', from: 'w1', to: 'end' },
      ],
    };
    expect(validateGraph(g, ['coder']).some(p => p.includes('maxCalls must be >= 1'))).toBe(true);
  });

  it('accepts a worker with both a self-edge and an exit edge', () => {
    const g: import('./team-graph').TeamGraph = {
      entry: 'start', maxHops: 10,
      nodes: [
        { id: 'start', type: 'start', x: 0, y: 0 },
        { id: 'w1', type: 'worker', worker: 'coder', maxCalls: 3, x: 1, y: 0 },
        { id: 'end', type: 'end', x: 2, y: 0 },
      ],
      edges: [
        { id: 'e0', from: 'start', to: 'w1' },
        { id: 'e1', from: 'w1', to: 'w1' },
        { id: 'e2', from: 'w1', to: 'end' },
      ],
    };
    expect(validateGraph(g, ['coder'])).toEqual([]);
  });
});
