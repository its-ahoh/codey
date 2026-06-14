# Sequential Flow Graph Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade the Team **Sequential** dispatch mode so a team can optionally define a user-authored flow graph (worker nodes + conditional/loop-back edges), executed by a judge LLM that picks the next edge after each worker, and authored in a drag-and-drop canvas in the Mac app.

**Architecture:** A new pure graph module in `packages/core` holds the graph types, a validator, and a resumable step state machine. A judge module mirrors the existing `advisor.ts` (prompt builder + `runJudge`). The gateway drives the state machine, reusing the existing `runOneWorker`, blackboard, and `[ASK_USER]` pause/resume path. The Mac app gains a React Flow canvas behind an "Edit flow" button; graphs persist through the existing `setGlobalTeams` API into `gateway.json`. Sequential teams with no graph keep today's exact linear behavior.

**Tech Stack:** TypeScript (ES2020, CommonJS), Vitest, React + Vite (codey-mac), `@xyflow/react` (new dependency).

**Spec:** `docs/superpowers/specs/2026-06-14-sequential-flow-graph-design.md`

**Node note:** All `npm` commands require Node v22.17.1 (`nvm use 22.17.1`); the default v16 cannot run vitest/tsc.

---

## File Structure

**packages/core/src/**
- Create `team-graph.ts` — graph types (`TeamGraph`, `TeamGraphNode`, `TeamGraphEdge`), `validateGraph()`, and the resumable step machine (`graphStep()` + `GraphRunState`).
- Create `team-graph.test.ts` — validator + step-machine unit tests.
- Create `judge.ts` — `JudgeInput`, `JudgeDecision`, `buildJudgePrompt()`, `runJudge()` (mirrors `advisor.ts`).
- Create `judge.test.ts` — prompt + decision-parsing tests with a stub runner.
- Modify `workspace.ts` — add `graph?` to `TeamConfigRaw` (object form) and `TeamConfig`; validate/normalize it in `normalizeTeam()`.
- Modify `workspace.test.ts` — graph normalize round-trip + invalid-graph-drops-to-linear tests.
- Modify `index.ts` (core barrel, if present) — re-export the new modules.

**packages/gateway/src/**
- Modify `gateway.ts` — branch into the graph engine when a Sequential team has a valid `graph`; add `runSequentialGraphForChat()` and graph pause/resume in `pendingTeam`.

**codey-mac/**
- Modify `package.json` — add `@xyflow/react`.
- Modify `src/components/GlobalTeamsSection.tsx` — preserve `graph` through `fromRaw`/`toRaw`; add "Edit flow" button + editor mount.
- Create `src/components/FlowEditor.tsx` — the React Flow canvas (nodes, edges, condition inspector, maxHops, raw JSON toggle, validation).
- Create `src/components/flowEditorModel.ts` — pure helpers converting `TeamGraph` ↔ React Flow nodes/edges, plus a thin re-export of `validateGraph` inputs.
- Create `src/components/flowEditorModel.test.ts` — conversion + validation view-logic tests.

---

## Task 1: Core graph types + validator

**Files:**
- Create: `packages/core/src/team-graph.ts`
- Test: `packages/core/src/team-graph.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/team-graph.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/core && npx vitest run src/team-graph.test.ts`
Expected: FAIL — `Cannot find module './team-graph'`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/core/src/team-graph.ts`:

```ts
export type TeamGraphNodeType = 'start' | 'worker' | 'end';

export interface TeamGraphNode {
  id: string;
  type: TeamGraphNodeType;
  /** Worker name; required when type === 'worker'. */
  worker?: string;
  x: number;
  y: number;
}

export interface TeamGraphEdge {
  id: string;
  from: string;
  to: string;
  /** Natural-language condition the judge evaluates, e.g. "tests pass". */
  condition?: string;
  /** Fallback edge taken when no conditioned edge matches. */
  isDefault?: boolean;
}

export interface TeamGraph {
  entry: string;
  maxHops: number;
  nodes: TeamGraphNode[];
  edges: TeamGraphEdge[];
}

export const DEFAULT_MAX_HOPS = 20;

/**
 * Returns a list of human-readable problems with the graph. Empty array means
 * the graph is runnable. Used by both the gateway (refuse to run, report why)
 * and the Mac editor (surface inline).
 */
export function validateGraph(graph: TeamGraph, knownWorkers: string[]): string[] {
  const problems: string[] = [];
  const known = new Set(knownWorkers.map(w => w.toLowerCase()));
  const nodeById = new Map(graph.nodes.map(n => [n.id, n]));

  if (!nodeById.has(graph.entry)) {
    problems.push(`entry node "${graph.entry}" does not exist`);
  }

  for (const node of graph.nodes) {
    if (node.type === 'worker') {
      if (!node.worker) {
        problems.push(`worker node "${node.id}" is missing a worker`);
      } else if (!known.has(node.worker.toLowerCase())) {
        problems.push(`node "${node.id}" references unknown worker "${node.worker}"`);
      }
    }
  }

  const outgoing = new Map<string, TeamGraphEdge[]>();
  for (const edge of graph.edges) {
    if (!nodeById.has(edge.from)) {
      problems.push(`edge "${edge.id}" comes from missing node "${edge.from}"`);
    }
    if (!nodeById.has(edge.to)) {
      problems.push(`edge "${edge.id}" points to missing node "${edge.to}"`);
    }
    if (!outgoing.has(edge.from)) outgoing.set(edge.from, []);
    outgoing.get(edge.from)!.push(edge);
  }

  for (const node of graph.nodes) {
    const hasOut = (outgoing.get(node.id)?.length ?? 0) > 0;
    if ((node.type === 'worker' || node.type === 'start') && !hasOut) {
      const label = node.type === 'start' ? 'start node' : 'worker node';
      problems.push(`${label} "${node.id}" has no outgoing edge`);
    }
  }

  // Reachability from entry.
  if (nodeById.has(graph.entry)) {
    const seen = new Set<string>([graph.entry]);
    const stack = [graph.entry];
    while (stack.length) {
      const cur = stack.pop()!;
      for (const edge of outgoing.get(cur) ?? []) {
        if (nodeById.has(edge.to) && !seen.has(edge.to)) {
          seen.add(edge.to);
          stack.push(edge.to);
        }
      }
    }
    for (const node of graph.nodes) {
      if (!seen.has(node.id)) {
        problems.push(`node "${node.id}" is unreachable from entry`);
      }
    }
  }

  return problems;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/core && npx vitest run src/team-graph.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/team-graph.ts packages/core/src/team-graph.test.ts
git commit -m "feat(core): team flow graph types and validator"
```

---

## Task 2: The resumable step machine

**Files:**
- Modify: `packages/core/src/team-graph.ts`
- Test: `packages/core/src/team-graph.test.ts`

The step machine is pure: it never runs workers or calls the judge itself. The
gateway runs a worker, then asks the machine "given this node's edges and the
chosen edge id, what's the next node?". This keeps it fully unit-testable.

- [ ] **Step 1: Write the failing test**

Append to `packages/core/src/team-graph.test.ts`:

```ts
import { startRun, advance, outgoingEdges } from './team-graph';

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/core && npx vitest run src/team-graph.test.ts`
Expected: FAIL — `startRun is not a function`.

- [ ] **Step 3: Write minimal implementation**

Append to `packages/core/src/team-graph.ts`:

```ts
export type GraphRunStatus = 'running' | 'done' | 'capped' | 'stuck';

export interface GraphRunState {
  currentNodeId: string;
  hops: number;
  status: GraphRunStatus;
  /** Node ids visited in order (worker nodes only), for progress/history. */
  visited: string[];
}

function nodeMap(graph: TeamGraph): Map<string, TeamGraphNode> {
  return new Map(graph.nodes.map(n => [n.id, n]));
}

export function outgoingEdges(graph: TeamGraph, nodeId: string): TeamGraphEdge[] {
  return graph.edges.filter(e => e.from === nodeId);
}

/** Follow non-worker nodes (start) forward to the first worker/end node. */
function settle(graph: TeamGraph, nodeId: string, state: GraphRunState): GraphRunState {
  const nodes = nodeMap(graph);
  let cur = nodeId;
  // start nodes have exactly one meaningful outgoing edge; walk through them.
  while (nodes.get(cur)?.type === 'start') {
    const next = outgoingEdges(graph, cur)[0];
    if (!next) return { ...state, currentNodeId: cur, status: 'stuck' };
    cur = next.to;
  }
  const node = nodes.get(cur);
  if (!node) return { ...state, currentNodeId: cur, status: 'stuck' };
  if (node.type === 'end') return { ...state, currentNodeId: cur, status: 'done' };
  return {
    ...state,
    currentNodeId: cur,
    status: 'running',
    visited: [...state.visited, cur],
  };
}

export function startRun(graph: TeamGraph): GraphRunState {
  return settle(graph, graph.entry, { currentNodeId: graph.entry, hops: 0, status: 'running', visited: [] });
}

/**
 * Move from the current node along `edgeId`. Increments the hop counter,
 * enforces maxHops, and settles onto the next worker/end node.
 */
export function advance(graph: TeamGraph, state: GraphRunState, edgeId: string): GraphRunState {
  const edge = graph.edges.find(e => e.id === edgeId && e.from === state.currentNodeId);
  if (!edge) return { ...state, status: 'stuck' };
  const hops = state.hops + 1;
  const settled = settle(graph, edge.to, { ...state, hops });
  if (settled.status === 'running' && hops >= graph.maxHops) {
    return { ...settled, status: 'capped' };
  }
  return settled;
}

/**
 * Pick the edge to follow given the judge's chosen edge id. Falls back to the
 * default edge when the judge's choice is absent/invalid, then to "stuck".
 */
export function resolveEdge(graph: TeamGraph, nodeId: string, chosenEdgeId: string | null): TeamGraphEdge | null {
  const edges = outgoingEdges(graph, nodeId);
  if (edges.length === 0) return null;
  const chosen = chosenEdgeId ? edges.find(e => e.id === chosenEdgeId) : undefined;
  if (chosen) return chosen;
  return edges.find(e => e.isDefault) ?? null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/core && npx vitest run src/team-graph.test.ts`
Expected: PASS (all Task 1 + Task 2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/team-graph.ts packages/core/src/team-graph.test.ts
git commit -m "feat(core): resumable team-graph step machine"
```

---

## Task 3: Judge module

**Files:**
- Create: `packages/core/src/judge.ts`
- Test: `packages/core/src/judge.test.ts`

Mirrors `advisor.ts`: a prompt builder + a `runJudge()` that calls a runner,
times out, and parses a JSON decision. Reuses `extractJsonObject` from `advisor.ts`.

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/judge.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildJudgePrompt, runJudge, JudgeInput } from './judge';
import { AgentResponse } from './types';

function input(): JudgeInput {
  return {
    task: 'Add a feature',
    worker: 'reviewer',
    workerOutput: 'I checked the code; tests fail.',
    blackboardSummary: '',
    edges: [
      { id: 'e3', condition: 'work incomplete', targetWorker: 'coder' },
      { id: 'e4', condition: undefined, targetWorker: '(end)' },
    ],
  };
}

describe('buildJudgePrompt', () => {
  it('lists each edge with its id, condition and target', () => {
    const p = buildJudgePrompt(input());
    expect(p).toContain('e3');
    expect(p).toContain('work incomplete');
    expect(p).toContain('coder');
  });
});

describe('runJudge', () => {
  it('returns the chosen edge id and reason from JSON output', async () => {
    const runner = async (): Promise<AgentResponse> =>
      ({ success: true, output: '{"edge_id":"e3","reason":"tests fail"}' } as AgentResponse);
    const d = await runJudge(input(), { agent: 'claude-code', runner });
    expect(d.edgeId).toBe('e3');
    expect(d.reason).toBe('tests fail');
    expect(d.fallback).toBe(false);
  });

  it('falls back when the runner fails', async () => {
    const runner = async (): Promise<AgentResponse> =>
      ({ success: false, output: '', error: 'boom' } as AgentResponse);
    const d = await runJudge(input(), { agent: 'claude-code', runner });
    expect(d.fallback).toBe(true);
    expect(d.edgeId).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/core && npx vitest run src/judge.test.ts`
Expected: FAIL — `Cannot find module './judge'`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/core/src/judge.ts`:

```ts
import { AgentRequest, AgentResponse, CodingAgent, ModelConfig } from './types';
import { extractJsonObject } from './advisor';

export interface JudgeEdge {
  id: string;
  condition?: string;
  /** Worker name of the target node, or a label like "(end)". */
  targetWorker: string;
}

export interface JudgeInput {
  task: string;
  worker: string;
  workerOutput: string;
  blackboardSummary: string;
  edges: JudgeEdge[];
}

export interface JudgeDecision {
  edgeId: string | null;
  reason: string;
  fallback: boolean;
  fallbackReason?: string;
}

export type JudgeRunner = (req: AgentRequest) => Promise<AgentResponse>;

export interface JudgeOptions {
  agent: CodingAgent;
  model?: ModelConfig;
  runner: JudgeRunner;
  timeoutMs?: number;
  signal?: AbortSignal;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export function buildJudgePrompt(input: JudgeInput): string {
  const lines: string[] = [];
  lines.push('# Flow Judge');
  lines.push('## Role');
  lines.push(
    'You route a sequential worker team along a fixed graph. You never write code. ' +
    'Given the worker that just finished, its output, and the list of outgoing edges, ' +
    'choose exactly one edge to follow. Each edge has a natural-language condition; ' +
    'pick the edge whose condition the output best satisfies. If none clearly match, ' +
    'pick the edge marked as the default target.',
  );
  lines.push('## Task');
  lines.push(input.task);
  if (input.blackboardSummary.trim()) {
    lines.push('## Shared notes');
    lines.push(input.blackboardSummary.trim());
  }
  lines.push(`## Worker just finished: ${input.worker}`);
  lines.push('## Worker output');
  lines.push(input.workerOutput || '(empty)');
  lines.push('## Outgoing edges (choose one)');
  for (const e of input.edges) {
    lines.push(`- id="${e.id}" → ${e.targetWorker}: ${e.condition ? `if ${e.condition}` : '(default)'}`);
  }
  lines.push('## Output format');
  lines.push('Reply with ONLY a JSON object: {"edge_id":"<one of the ids above>","reason":"<one short sentence>"}');
  return lines.join('\n\n');
}

function fallback(reason: string): JudgeDecision {
  return { edgeId: null, reason: '', fallback: true, fallbackReason: reason };
}

export async function runJudge(input: JudgeInput, opts: JudgeOptions): Promise<JudgeDecision> {
  if (input.edges.length === 0) return fallback('no outgoing edges');

  const prompt = buildJudgePrompt(input);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const ac = new AbortController();
  const onAbort = () => ac.abort();
  if (opts.signal) {
    if (opts.signal.aborted) ac.abort();
    else opts.signal.addEventListener('abort', onAbort, { once: true });
  }
  const timer = setTimeout(() => ac.abort(), timeoutMs);

  let response: AgentResponse;
  try {
    response = await opts.runner({ prompt, agent: opts.agent, model: opts.model, signal: ac.signal });
  } catch (err) {
    return fallback(`runner threw: ${(err as Error).message}`);
  } finally {
    clearTimeout(timer);
    if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
  }

  if (!response.success) return fallback(response.error || 'runner returned non-success');

  const obj = extractJsonObject(response.output) as { edge_id?: unknown; reason?: unknown } | null;
  if (!obj || typeof obj.edge_id !== 'string') return fallback('could not parse judge JSON');
  const edgeId = obj.edge_id;
  if (!input.edges.some(e => e.id === edgeId)) return fallback(`judge chose unknown edge "${edgeId}"`);
  return {
    edgeId,
    reason: typeof obj.reason === 'string' ? obj.reason : '',
    fallback: false,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/core && npx vitest run src/judge.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/judge.ts packages/core/src/judge.test.ts
git commit -m "feat(core): flow-graph judge module"
```

---

## Task 4: Persist `graph` in TeamConfig

**Files:**
- Modify: `packages/core/src/workspace.ts:28-43` (types) and `:183-219` (`normalizeTeam`)
- Test: `packages/core/src/workspace.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `packages/core/src/workspace.test.ts` (follow the file's existing setup for constructing a `WorkspaceManager` with stub workers; if it uses a helper, reuse it — the assertions below are the new content). If the test file does not already exist, create it with a minimal `WorkerManager` stub whose `hasWorker` returns true for `coder`:

```ts
import { describe, it, expect } from 'vitest';
import { WorkspaceManager } from './workspace';
import { WorkerManager } from './workers';

// Access the private normalizeTeam via a tiny subclass for unit testing.
class TestWM extends WorkspaceManager {
  norm(name: string, raw: any) { return (this as any).normalizeTeam(name, raw); }
}

function makeWM(): TestWM {
  const workers = new WorkerManager('/tmp/nonexistent-workers');
  // Pretend "coder" exists.
  (workers as any).workers = new Map([['coder', { name: 'coder', personality: {}, config: {} }]]);
  return new TestWM(workers, '/tmp/ws');
}

const validGraph = {
  entry: 'start',
  maxHops: 5,
  nodes: [
    { id: 'start', type: 'start', x: 0, y: 0 },
    { id: 'n_coder', type: 'worker', worker: 'coder', x: 1, y: 0 },
    { id: 'end', type: 'end', x: 2, y: 0 },
  ],
  edges: [
    { id: 'e1', from: 'start', to: 'n_coder' },
    { id: 'e2', from: 'n_coder', to: 'end', isDefault: true },
  ],
};

describe('normalizeTeam graph', () => {
  it('keeps a valid graph on a sequential team', () => {
    const t = makeWM().norm('t', { members: ['coder'], dispatch: 'all', graph: validGraph });
    expect(t.graph).toBeDefined();
    expect(t.graph.entry).toBe('start');
  });

  it('drops an invalid graph and stays linear sequential', () => {
    const bad = { ...validGraph, entry: 'ghost' };
    const t = makeWM().norm('t', { members: ['coder'], dispatch: 'all', graph: bad });
    expect(t.graph).toBeUndefined();
    expect(t.dispatch).toBe('all');
  });

  it('ignores a graph on non-sequential dispatch', () => {
    const t = makeWM().norm('t', { members: ['coder'], dispatch: 'auto', graph: validGraph });
    expect(t.graph).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/core && npx vitest run src/workspace.test.ts -t "normalizeTeam graph"`
Expected: FAIL — `graph` is not on the returned object / type error.

- [ ] **Step 3: Write minimal implementation**

In `packages/core/src/workspace.ts`, add the import near the top:

```ts
import { TeamGraph, validateGraph } from './team-graph';
```

Extend the raw object form (in the `TeamConfigRaw` union, the object branch) and `TeamConfig`:

```ts
// TeamConfigRaw object branch — add:
      graph?: TeamGraph;

// TeamConfig interface — add:
  /** Only honored when dispatch === 'all' (Sequential). */
  graph?: TeamGraph;
```

In `normalizeTeam`, capture the raw graph alongside `parallel` (object branch):

```ts
    let parallel: Partial<ParallelSettings> | undefined;
    let graph: TeamGraph | undefined;          // NEW
    ...
    } else if (raw && typeof raw === 'object' && Array.isArray(raw.members)) {
      members = raw.members;
      ...
      parallel = raw.parallel;
      graph = raw.graph;                        // NEW
    }
```

Then, just before `return result;`, validate and attach the graph:

```ts
    if (dispatch === 'all' && graph) {
      const problems = validateGraph(graph, members);
      if (problems.length === 0) {
        result.graph = graph;
      } else {
        this.logger.warn(`[Workspace] Team "${name}" has an invalid flow graph — running linearly. Problems: ${problems.join('; ')}`);
      }
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/core && npx vitest run src/workspace.test.ts -t "normalizeTeam graph"`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/workspace.ts packages/core/src/workspace.test.ts
git commit -m "feat(core): persist and validate flow graph on sequential teams"
```

---

## Task 5: Export new modules from the core barrel

**Files:**
- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: Check the barrel exists and how it re-exports**

Run: `cat packages/core/src/index.ts | grep -n "export"`
Expected: a list of `export * from './...'` lines (e.g. `./advisor`, `./workers`).

- [ ] **Step 2: Add the new exports**

Append to `packages/core/src/index.ts` (match the existing style — if it uses `export * from`):

```ts
export * from './team-graph';
export * from './judge';
```

If the barrel uses named exports instead, add `TeamGraph`, `TeamGraphNode`, `TeamGraphEdge`, `validateGraph`, `startRun`, `advance`, `resolveEdge`, `outgoingEdges`, `GraphRunState`, `DEFAULT_MAX_HOPS`, `JudgeInput`, `JudgeDecision`, `runJudge`, `buildJudgePrompt` to match.

- [ ] **Step 3: Build core to verify exports compile**

Run: `cd packages/core && npx tsc -p . --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/index.ts
git commit -m "chore(core): export team-graph and judge modules"
```

---

## Task 6: Gateway — run the graph for sequential teams

**Files:**
- Modify: `packages/gateway/src/gateway.ts` (imports; `handleTeamCommand` branch near `:2357`; `runTeamForChat` branch near `:3063`; new `runSequentialGraphForChat`)

This task wires the engine. The graph engine reuses the existing `runOneWorker`
closure and `TeamBlackboard`, and the judge uses `getAdvisorAgentAndModel()` +
the same runner the Advisor uses. For v1, the graph runner handles the happy
path, loop-backs, `maxHops`, and terminal stops. `[ASK_USER]` pausing inside a
graph is deferred to Task 7 (the worker simply runs to completion per hop here;
if it emits `[ASK_USER]`, that text is shown and treated as the worker's output —
Task 7 upgrades it to a true pause/resume).

- [ ] **Step 1: Add imports**

Near the other `@codey/core` imports in `gateway.ts`, add to the import list:

```ts
import {
  TeamGraph, startRun, advance, resolveEdge, outgoingEdges,
  runJudge, JudgeInput, GraphRunState,
} from '@codey/core';
```

(Use the same import path/style the file already uses for `runAdvisor`, `TeamBlackboard`, etc.)

- [ ] **Step 2: Write the engine method**

Add this private method to the gateway class (place it just after `runAllMembersInOrder`, around `:2840`). It takes the same `runOneWorker` closure the command handlers build:

```ts
  private async runSequentialGraphForChat(
    message: UserMessage,
    teamName: string,
    graph: TeamGraph,
    task: string,
    runOneWorker: (
      workerName: string,
      prompt: string,
      codingAgent: CodingAgent,
      modelConfig: ModelConfig | undefined,
      blackboard: TeamBlackboard,
    ) => Promise<{ success: boolean; output: string; error?: string }>,
  ): Promise<void> {
    const { chatId, channel } = message;
    const wm = this.workspaceManager.getWorkerManager();
    const blackboard = new TeamBlackboard();
    const nodeById = new Map(graph.nodes.map(n => [n.id, n]));
    const results: string[] = [];

    let state: GraphRunState = startRun(graph);
    if (state.status !== 'running') {
      await this.sendResponse({ chatId, channel, text: `⚠️ Team **${teamName}** flow could not start (${state.status}).` });
      return;
    }

    await this.sendResponse({
      chatId, channel,
      text: `🧭 Running flow for team **${teamName}**\nTask: ${task.substring(0, 100)}${task.length > 100 ? '...' : ''}`,
    });

    let stepIndex = 0;
    while (state.status === 'running') {
      const node = nodeById.get(state.currentNodeId)!;
      const workerName = node.worker!;
      const worker = wm.getWorker(workerName);
      if (!worker) { results.push(`**${workerName}**: ❌ not found`); break; }

      const codingAgent = wm.getWorkerCodingAgent(workerName) as CodingAgent;
      const model = wm.getWorkerModel(workerName);
      const modelConfig = this.getModelConfig(codingAgent, model);
      await this.sendResponse({ chatId, channel, text: `🔄 Step ${++stepIndex}: **${worker.name}** is working...` });

      const roster = graph.nodes
        .filter(n => n.type === 'worker' && n.worker)
        .map(n => ({ name: n.worker!, hint: wm.getDispatchHint(n.worker!) }));
      const prompt = wm.buildSequentialWorkerPrompt(
        workerName, task, roster, null, blackboard.renderForWorker(workerName),
      );
      const resp = await runOneWorker(workerName, prompt, codingAgent, modelConfig, blackboard);
      if (!resp.success) { results.push(`**${worker.name}**: ❌ Failed - ${resp.error}`); break; }

      const ingested = blackboard.ingest(workerName, stepIndex, resp.output);
      results.push(`**${worker.name}**:\n${ingested.stripped.substring(0, 200)}`);

      // Judge picks the next edge.
      const edges = outgoingEdges(graph, state.currentNodeId).map(e => ({
        id: e.id,
        condition: e.condition,
        targetWorker: nodeById.get(e.to)?.type === 'end' ? '(end)' : (nodeById.get(e.to)?.worker ?? e.to),
      }));
      const { agent: jAgent, model: jModel } = this.getAdvisorAgentAndModel();
      const judgeInput: JudgeInput = {
        task, worker: workerName, workerOutput: ingested.stripped,
        blackboardSummary: blackboard.renderForUser() || '', edges,
      };
      const decision = await runJudge(judgeInput, {
        agent: jAgent, model: jModel,
        runner: this.advisorRunner,   // the same runner field the Advisor loop uses (gateway.ts ~:2118)
      });
      const edge = resolveEdge(graph, state.currentNodeId, decision.edgeId);
      if (!edge) {
        await this.sendResponse({ chatId, channel, text: `🏁 Flow stopped at **${worker.name}** (no matching next step).` });
        break;
      }
      await this.sendResponse({
        chatId, channel,
        text: `↪️ ${decision.fallback ? '(default) ' : ''}${decision.reason || 'next step'}`,
      });
      state = advance(graph, state, edge.id);
    }

    if (state.status === 'capped') {
      await this.sendResponse({ chatId, channel, text: `⚠️ Flow hit the max-hops cap (${graph.maxHops}); reporting partial result.` });
    }
    const bbBlock = blackboard.renderForUser();
    const body = `📊 Team **${teamName}** flow results\n\n${results.join('\n\n')}`;
    await this.sendResponse({ chatId, channel, text: bbBlock ? `${body}\n\n${bbBlock}` : body });
  }
```

Note: `this.advisorRunner` is the gateway field passed as `runner` to `runAdvisor`
(see `runAdvisorLoop` near `:2118`). Reuse it verbatim for the judge.

- [ ] **Step 3: Branch into the engine from `handleTeamCommand`**

In `handleTeamCommand`, replace the final linear-dispatch tail (currently at
`:2447-2454`, the `// dispatch === 'all' OR forceAll: legacy path` block) so that
a graph short-circuits before the linear run:

```ts
    // dispatch === 'all' OR forceAll: graph first, else legacy linear path
    if (!opts.forceAll && team.graph) {
      await this.runSequentialGraphForChat(message, teamName, team.graph, task, runOneWorker);
      return;
    }
    const headerSuffix = opts.forceAll ? ' [--all override]' : '';
    await this.sendResponse({
      chatId, channel,
      text: `👥 Running team **${teamName}** (${members.join(' → ')})${headerSuffix}\nTask: ${task.substring(0, 100)}${task.length > 100 ? '...' : ''}`,
    });
    await this.runAllMembersInOrder(message, teamName, members, task, runOneWorker);
```

- [ ] **Step 4: Branch into the engine from `runTeamForChat`**

In `runTeamForChat`, find the linear fallback near `:3063`
(`// dispatch === 'all', forceAll, or auto-routing fallback`) and add the same
guard immediately before the `runAllMembersInOrder` call there:

```ts
    if (!opts.forceAll && team.graph) {
      await this.runSequentialGraphForChat(message, teamName, team.graph, task, runOneWorker);
      return;
    }
```

(Use the `team`/`message`/`task`/`runOneWorker` identifiers already in that scope.
If `runTeamForChat` uses a differently-named message variable, match it.)

- [ ] **Step 5: Build the gateway**

Run: `cd packages/gateway && npx tsc -p . --noEmit`
Expected: no errors. Fix any mismatch in the runner closure name (`runAgentRequest`) by matching the Advisor's actual runner.

- [ ] **Step 6: Manual smoke test**

Run the gateway in dev (`npm run dev` from repo root after `nvm use 22.17.1`),
define a 2-node graph in `gateway.json` for an existing sequential team (coder →
reviewer, reviewer loops back to coder if "work incomplete" else end), and run
`/team <name> <task>`. Confirm: step messages appear, the judge routes, a loop
back occurs at least once when the reviewer rejects, and the run ends.

- [ ] **Step 7: Commit**

```bash
git add packages/gateway/src/gateway.ts
git commit -m "feat(gateway): execute sequential team flow graphs via judge"
```

---

## Task 7: Gateway — `[ASK_USER]` pause/resume inside a graph

**Files:**
- Modify: `packages/gateway/src/gateway.ts` (`runSequentialGraphForChat`; `pendingTeam` persistence; resume handler)

The existing auto/sequential paths persist a paused team via `persistPendingTeam`
and resume on the user's reply. Add a `mode: 'graph'` variant so a worker that
emits `[ASK_USER]` mid-flow pauses the graph and resumes at the same node.

- [ ] **Step 1: Detect ASK_USER and persist graph state**

In `runSequentialGraphForChat`, after `runOneWorker` returns, detect an ASK_USER
marker in `resp.output` with `parseAskUser` (already imported from `@codey/core`
in `gateway.ts:3`; the auto path uses it at `:2573`). It returns
`{ preamble, question, options? }`. When present, persist and return:

```ts
      const ask = parseAskUser(resp.output);
      if (ask) {
        this.persistPendingTeam(message.chatId, {
          mode: 'graph',
          teamName,
          task,
          graphState: { currentNodeId: state.currentNodeId, hops: state.hops, visited: state.visited },
          askingWorker: workerName,
          question: ask.question,
          options: ask.options,
          askedAt: Date.now(),
          blackboard: blackboard.toJSON(),
          results,
        });
        const rendered = renderQuestion(worker.name, ask.preamble, ask.question, ask.options);
        await this.sendResponse({ chatId, channel, text: rendered.text, choices: rendered.choices });
        return;
      }
```

Add a third `mode: 'graph'` member to the `PendingTeamState` union in
`packages/core/src/types/pending-team.ts` (alongside `'sequential'` and `'auto'`):

```ts
  | {
      teamName: string;
      task: string;
      mode: 'graph';
      graphState: { currentNodeId: string; hops: number; visited: string[] };
      results: string[];
      askingWorker: string;
      question: string;
      options?: string[];
      askedAt: number;
      blackboard?: BlackboardSnapshot;
    };
```

- [ ] **Step 2: Resume on the user's answer**

Find the resume entry point that switches on `pending.mode` (the auto path handles
`mode: 'auto'`, the sequential path `mode: 'sequential'` — near `:2540`). Add a
`case 'graph'` that rebuilds the graph from the team config, restores
`GraphRunState` from `graphState`, rebuilds the blackboard with
`TeamBlackboard.fromJSON(pending.blackboard)` (the auto path does this at `:2545`),
feeds the user's answer to the paused worker as the next task (prefix it, e.g.
`User answered: <answer>\n\nContinue.`), and resumes the loop. Factor the loop
body from Task 6 into a private `continueGraphRun(message, teamName, graph, task,
state, blackboard, results, runOneWorker)` so both the fresh start (Task 6) and
resume call it.

```ts
      case 'graph': {
        const team = this.workspaceManager.getTeam(pending.teamName);
        if (!team?.graph) { /* report stale pause */ break; }
        const state = { currentNodeId: pending.graphState.currentNodeId, hops: pending.graphState.hops, status: 'running' as const, visited: pending.graphState.visited };
        const blackboard = TeamBlackboard.fromJSON(pending.blackboard);
        const resumeTask = `User answered: ${answerText}\n\nContinue.`;
        await this.continueGraphRun(message, pending.teamName, team.graph, resumeTask, state, blackboard, pending.results, runOneWorker);
        break;
      }
```

(`TeamBlackboard.fromJSON` is the inverse of the `toJSON` already used by the auto
path — reuse whatever the auto resume uses to rehydrate the blackboard.)

- [ ] **Step 3: Refactor Task 6's loop into `continueGraphRun`**

Extract the `while (state.status === 'running') { ... }` body and the trailing
results/cap reporting from `runSequentialGraphForChat` into
`continueGraphRun(...)`. `runSequentialGraphForChat` becomes: `startRun`, the
header message, then `await this.continueGraphRun(...)`.

- [ ] **Step 4: Build**

Run: `cd packages/gateway && npx tsc -p . --noEmit`
Expected: no errors.

- [ ] **Step 5: Manual smoke test**

With a worker that emits `[ASK_USER:choice]: Proceed? | yes | no` in the flow,
run the team, confirm the question is delivered as tappable choices, answer it,
and confirm the flow resumes at the same node and finishes.

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/src/gateway.ts
git commit -m "feat(gateway): pause/resume ASK_USER inside team flow graphs"
```

---

## Task 8: Mac app — preserve `graph` + "Edit flow" entry point

**Files:**
- Modify: `codey-mac/src/components/GlobalTeamsSection.tsx`

- [ ] **Step 1: Preserve `graph` through normalize**

In `GlobalTeamsSection.tsx`, extend `TeamState` and the `fromRaw`/`toRaw`
converters so the graph survives round-trips (today they drop unknown fields):

```ts
import type { TeamGraph } from '../../../packages/core/src/team-graph'

interface TeamState { members: string[]; dispatch: DispatchMode; graph?: TeamGraph }

function fromRaw(raw: TeamConfigRaw): TeamState {
  if (Array.isArray(raw)) return { members: raw, dispatch: 'all' }
  const d = raw?.dispatch
  const dispatch: DispatchMode = d === 'auto' ? 'auto' : d === 'parallel' ? 'parallel' : 'all'
  return { members: Array.isArray(raw?.members) ? raw.members : [], dispatch, graph: (raw as any)?.graph }
}

function toRaw(t: TeamState): TeamConfigRaw {
  if (t.dispatch === 'all' && !t.graph) return t.members
  const out: any = { members: t.members, dispatch: t.dispatch }
  if (t.dispatch === 'all' && t.graph) out.graph = t.graph
  return out
}
```

- [ ] **Step 2: Add the "Edit flow" button (Sequential only)**

In the team card (after the members row, inside the `team.dispatch === 'all'`
case), add a button that opens the editor for this team:

```tsx
{team.dispatch === 'all' && (
  <div style={{ marginTop: 8 }}>
    <button onClick={() => setEditingFlow(name)}
      style={{ padding: '3px 10px', fontSize: 11, background: 'transparent', color: C.accent, border: `1px solid ${C.accent}`, borderRadius: 6, cursor: 'pointer' }}>
      {team.graph ? 'Edit flow ↗' : '+ Add flow ↗'}
    </button>
    {team.graph && <span style={{ fontSize: 11, color: C.fg3, marginLeft: 8 }}>{team.graph.nodes.filter(n => n.type === 'worker').length} nodes</span>}
  </div>
)}
```

Add `const [editingFlow, setEditingFlow] = useState<string | null>(null)` with the
other hooks, and render the editor modal when set (wired in Task 10).

- [ ] **Step 3: Build the renderer**

Run: `cd codey-mac && npx tsc -p tsconfig.json --noEmit`
Expected: errors only about `FlowEditor` not yet existing (resolved in Task 10).

- [ ] **Step 4: Commit**

```bash
git add codey-mac/src/components/GlobalTeamsSection.tsx
git commit -m "feat(mac): preserve team flow graph and add Edit flow entry point"
```

---

## Task 9: Mac app — flow editor model helpers (TDD)

**Files:**
- Create: `codey-mac/src/components/flowEditorModel.ts`
- Test: `codey-mac/src/components/flowEditorModel.test.ts`

These pure helpers convert between `TeamGraph` and React Flow's `{nodes, edges}`
shape, and generate ids. Keeping them pure makes the canvas component thin and
testable.

- [ ] **Step 1: Write the failing test**

Create `codey-mac/src/components/flowEditorModel.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd codey-mac && npx vitest run src/components/flowEditorModel.test.ts`
Expected: FAIL — `Cannot find module './flowEditorModel'`.

- [ ] **Step 3: Write minimal implementation**

Create `codey-mac/src/components/flowEditorModel.ts`:

```ts
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
  const gNodes: TeamGraphNode[] = nodes.map(n => ({
    id: n.id, type: n.data.type, worker: n.data.worker,
    x: Math.round(n.position.x), y: Math.round(n.position.y),
  }))
  const gEdges: TeamGraphEdge[] = edges.map(e => ({
    id: e.id, from: e.source, to: e.target,
    condition: e.data.condition, isDefault: e.data.isDefault,
  }))
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
```

Note: `fromFlow` must serialize `condition`/`isDefault`/`worker` as `undefined`
when absent so the round-trip test's `toEqual(g)` holds. If `toEqual` complains
about explicit `undefined` keys, strip them in `fromFlow` with a small helper
before returning.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd codey-mac && npx vitest run src/components/flowEditorModel.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add codey-mac/src/components/flowEditorModel.ts codey-mac/src/components/flowEditorModel.test.ts
git commit -m "feat(mac): flow editor model helpers"
```

---

## Task 10: Mac app — React Flow canvas

**Files:**
- Modify: `codey-mac/package.json` (add dependency)
- Create: `codey-mac/src/components/FlowEditor.tsx`
- Modify: `codey-mac/src/components/GlobalTeamsSection.tsx` (mount the editor)

- [ ] **Step 1: Install React Flow**

Run: `cd codey-mac && nvm use 22.17.1 && npm install @xyflow/react`
Expected: `@xyflow/react` added to `package.json` dependencies, no peer errors.

- [ ] **Step 2: Create the editor component**

Create `codey-mac/src/components/FlowEditor.tsx`. It mounts a `ReactFlow` canvas
with controlled nodes/edges from `flowEditorModel`, a left palette listing the
team's workers (drag/click to add a `worker` node), an edge inspector (click an
edge → set its condition or toggle default), a `maxHops` field, a "Raw config"
toggle (renders `JSON.stringify(graph, null, 2)`), a validation strip
(`validateGraph(graph, workerNames)`), and Save/Close. On change it recomputes
the `TeamGraph` via `fromFlow` and calls `onSave(graph)` (debounced by the parent):

```tsx
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
```

- [ ] **Step 3: Mount the editor in `GlobalTeamsSection`**

At the end of the component's JSX (next to the worker-create modal), render:

```tsx
{editingFlow && teams[editingFlow] && (
  <FlowEditor
    teamName={editingFlow}
    workerNames={workers.map(w => w.name)}
    graph={teams[editingFlow].graph ?? emptyGraph()}
    onSave={(graph) => { queueSave({ ...teams, [editingFlow]: { ...teams[editingFlow], graph } }) }}
    onClose={() => setEditingFlow(null)}
  />
)}
```

Add the imports:

```tsx
import FlowEditor from './FlowEditor'
import { emptyGraph } from './flowEditorModel'
```

- [ ] **Step 4: Build the renderer**

Run: `cd codey-mac && npx tsc -p tsconfig.json --noEmit`
Expected: no errors.

- [ ] **Step 5: Manual check**

Run the Mac app (`npm run dev` in `codey-mac` per the project's existing run
flow), open Teams, pick a Sequential team, click "Add flow", drop two worker
nodes, connect start → A → B → end, set a condition on one edge and mark another
default, toggle "Raw config" to confirm JSON, Save, reopen to confirm it
persisted, and verify the validation strip clears when the graph is complete.

- [ ] **Step 6: Commit**

```bash
git add codey-mac/package.json codey-mac/package-lock.json codey-mac/src/components/FlowEditor.tsx codey-mac/src/components/GlobalTeamsSection.tsx
git commit -m "feat(mac): React Flow canvas for sequential team flow graphs"
```

---

## Task 11: Full build + test sweep

**Files:** none (verification)

- [ ] **Step 1: Build everything**

Run from repo root (after `nvm use 22.17.1`): `npm run build`
Expected: core + gateway compile with no errors.

- [ ] **Step 2: Run core tests**

Run: `cd packages/core && npx vitest run`
Expected: all pass, including `team-graph`, `judge`, and `workspace` graph tests.

- [ ] **Step 3: Run gateway + mac tests**

Run: `cd packages/gateway && npx vitest run` and `cd codey-mac && npx vitest run`
Expected: all pass (no regressions; `flowEditorModel` passes).

- [ ] **Step 4: Update docs**

Add a short "Flow graphs (Sequential)" subsection to the Worker/Team docs (the
`CLAUDE.md` Worker system bullet and `README` team section): a Sequential team
may define a `graph` ({nodes, edges, entry, maxHops}); a judge LLM picks the next
edge by its natural-language condition; edges can loop back; reaching an `end`
node or `maxHops` stops the run. Note auto/parallel are unchanged.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "docs: document sequential team flow graphs"
```

---

## Self-Review Notes

- **Spec coverage:** data model → Task 4; engine + judge + loop-back + maxHops + terminal → Tasks 1–3, 6; ASK_USER pause/resume → Task 7; canvas editor + raw-config view + validation → Tasks 9–10; persistence via `setGlobalTeams` → Tasks 8, 10; backward-compat (no graph = linear) → Tasks 4 & 6 guards.
- **v1 constraint** (one node per worker; converging edges for reuse) is honored — nothing creates duplicate worker nodes; the judge roster and `runOneWorker` key on worker name.
- **Judge identity** reuses `getAdvisorAgentAndModel()` and the Advisor's runner — no new config (Task 6 Step 2).
- **Type consistency:** `validateGraph`, `startRun`, `advance`, `resolveEdge`, `outgoingEdges`, `runJudge`, `JudgeInput`, `TeamGraph`, `GraphRunState` names are identical across core, gateway, and mac usages.
- **Verified integration points** (confirmed against the current `gateway.ts` while writing this plan, so they are named, not guessed): judge runner = `this.advisorRunner` (`:2118`); ASK_USER parser = `parseAskUser(output)` returning `{preamble, question, options?}` (imported `gateway.ts:3`, used `:2573`); `renderQuestion(worker, preamble, question, options)` from `./team-pause` (`:18`); pause persistence = `this.persistPendingTeam(chatId, PendingTeamState)` with `PendingTeamState` defined in `packages/core/src/types/pending-team.ts` (extended with the `mode:'graph'` member in Task 7); blackboard rehydrate = `TeamBlackboard.fromJSON(snapshot)` (`team-blackboard.ts:103`, used `:2545`). The resume switch lives near `:2540`.
