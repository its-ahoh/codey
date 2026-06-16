# Decision Diamonds & Worker Self-Loops Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make decision diamonds carry their condition (yes/no question) with two labeled outcome edges, add bounded worker self-loops, a node inspector (worker description, diamond question, max-self-loops), and resizable worker cards.

**Architecture:** Core graph model gains node `condition`/`maxCalls`/`width`/`height` and edge `branch` fields; `GraphRunState` gains a `runStreak` counter; a new `eligibleEdges` helper drops a worker's self-edge once `maxCalls` is hit; the judge learns an optional `question`. The gateway's single `continueGraphRun` loop threads `runStreak` and the diamond question. The Mac editor adds a node-aware inspector, auto-labeled yes/no diamond edges, self-loop handles, and `NodeResizer`.

**Tech Stack:** TypeScript (ES2020/CommonJS), vitest (core + codey-mac), React + @xyflow/react (Mac app). Node v22.17.1 via nvm (v16 default cannot run vitest/tsc).

---

## File structure

- `packages/core/src/team-graph.ts` — model fields, `validateGraph` rules, `GraphRunState.runStreak`, `settle`, `eligibleEdges`, `resolveEdge` diamond fallback.
- `packages/core/src/team-graph.test.ts` — vitest for the above.
- `packages/core/src/judge.ts` — `JudgeInput.question` + `buildJudgePrompt` decision section.
- `packages/core/src/judge.test.ts` — vitest for the prompt.
- `packages/gateway/src/gateway.ts` — `buildJudgeEdges`/`pickNextGraphEdge` use eligible edges + question; loop increments `runStreak`; resume persists/restores it. (No unit runner: build + manual.)
- `codey-mac/src/components/flowEditorModel.ts` — round-trip new fields; `branchColors` diamond colors.
- `codey-mac/src/components/flowEditorModel.test.ts` — vitest for the above.
- `codey-mac/src/components/FlowEditor.tsx` — node inspector, yes/no diamond edges, self-loop, `NodeResizer`. (No unit runner: build + manual.)

**Environment setup (run once before any task):**

```bash
source ~/.nvm/nvm.sh && nvm use 22.17.1
```

---

## Task 1: Core model fields + `validateGraph` rules

**Files:**
- Modify: `packages/core/src/team-graph.ts:3-24` (interfaces), `:49-65` (validate worker/condition blocks)
- Test: `packages/core/src/team-graph.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `packages/core/src/team-graph.test.ts` (reuse the existing `import { validateGraph, ... }` line; if `validateGraph` is not already imported, add it):

```ts
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
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/core && npx vitest run src/team-graph.test.ts`
Expected: FAIL — the diamond test fails on the old "needs a default outgoing edge" rule; `branch`/`maxCalls` are not yet on the types so it may also fail to compile.

- [ ] **Step 3: Add the model fields**

In `packages/core/src/team-graph.ts`, replace the `TeamGraphNode` interface (lines 3-10) with:

```ts
export interface TeamGraphNode {
  id: string;
  type: TeamGraphNodeType;
  /** Worker name; required when type === 'worker'. */
  worker?: string;
  /** Decision question the judge evaluates; used when type === 'condition'. */
  condition?: string;
  /** Max consecutive runs of this (self-looping) worker before a forced exit. */
  maxCalls?: number;
  x: number;
  y: number;
  /** Presentation-only: editor card size. Ignored by the runtime. */
  width?: number;
  height?: number;
}
```

In the `TeamGraphEdge` interface, add after the `isDefault` field (after line 19):

```ts
  /** Outcome of a diamond's decision. Only set on edges leaving a 'condition' node. */
  branch?: 'yes' | 'no';
```

- [ ] **Step 4: Update the `condition`-node validation block**

Replace the `else if (node.type === 'condition') { ... }` block (lines 56-64) with:

```ts
    } else if (node.type === 'condition') {
      if (node.worker) {
        problems.push(`condition node "${node.id}" must not reference a worker`);
      }
      if (!node.condition || !node.condition.trim()) {
        problems.push(`condition node "${node.id}" needs a question`);
      }
      const outs = graph.edges.filter(e => e.from === node.id);
      const yes = outs.filter(e => e.branch === 'yes').length;
      const no = outs.filter(e => e.branch === 'no').length;
      if (outs.length !== 2 || yes !== 1 || no !== 1) {
        problems.push(`condition node "${node.id}" needs exactly one yes and one no outgoing edge`);
      }
    }
```

- [ ] **Step 5: Add the worker self-loop + maxCalls checks**

In the `if (node.type === 'worker') { ... }` block (lines 50-56), add these statements just before its closing `}` (after the unknown-worker check):

```ts
      const outs = graph.edges.filter(e => e.from === node.id);
      if (outs.some(e => e.to === node.id) && !outs.some(e => e.to !== node.id)) {
        problems.push(`worker node "${node.id}" self-loops with no exit edge`);
      }
      if (node.maxCalls !== undefined && (!Number.isInteger(node.maxCalls) || node.maxCalls < 1)) {
        problems.push(`worker node "${node.id}" maxCalls must be >= 1`);
      }
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd packages/core && npx vitest run src/team-graph.test.ts`
Expected: PASS (all existing + new tests).

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/team-graph.ts packages/core/src/team-graph.test.ts
git commit -m "feat(core): diamonds carry conditions; validate yes/no edges + worker self-loops"
```

---

## Task 2: `runStreak` on `GraphRunState` + `settle` reset

**Files:**
- Modify: `packages/core/src/team-graph.ts:110-154` (`GraphRunState`, `settle`, `startRun`)
- Test: `packages/core/src/team-graph.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `packages/core/src/team-graph.test.ts`:

```ts
import { startRun, advance } from './team-graph';

describe('runStreak', () => {
  const g: import('./team-graph').TeamGraph = {
    entry: 'start', maxHops: 20,
    nodes: [
      { id: 'start', type: 'start', x: 0, y: 0 },
      { id: 'w1', type: 'worker', worker: 'coder', maxCalls: 2, x: 1, y: 0 },
      { id: 'w2', type: 'worker', worker: 'reviewer', x: 2, y: 0 },
      { id: 'end', type: 'end', x: 3, y: 0 },
    ],
    edges: [
      { id: 'e0', from: 'start', to: 'w1' },
      { id: 'e1', from: 'w1', to: 'w1' },   // self-loop
      { id: 'e2', from: 'w1', to: 'w2' },   // exit
      { id: 'e3', from: 'w2', to: 'end' },
    ],
  };

  it('starts at 0', () => {
    expect(startRun(g).runStreak).toBe(0);
  });

  it('carries the streak when looping onto the same node', () => {
    const s0 = { ...startRun(g), runStreak: 5 };
    const s1 = advance(g, s0, 'e1'); // w1 -> w1
    expect(s1.currentNodeId).toBe('w1');
    expect(s1.runStreak).toBe(5);
  });

  it('resets the streak when moving to a different node', () => {
    const s0 = { ...startRun(g), runStreak: 5 };
    const s1 = advance(g, s0, 'e2'); // w1 -> w2
    expect(s1.currentNodeId).toBe('w2');
    expect(s1.runStreak).toBe(0);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/core && npx vitest run src/team-graph.test.ts`
Expected: FAIL — `runStreak` is `undefined` on the returned state.

- [ ] **Step 3: Add `runStreak` to `GraphRunState`**

In `packages/core/src/team-graph.ts`, add to the `GraphRunState` interface (after the `visited` field, ~line 117):

```ts
  /** Consecutive runs of currentNodeId; resets when settling onto a different node. */
  runStreak: number;
```

- [ ] **Step 4: Reset/carry `runStreak` in `settle`; init in `startRun`**

In `settle` (lines 129-150), after the final `cur`/`node` are resolved (just before `if (node.type === 'end')`), add:

```ts
  const runStreak = state.currentNodeId === cur ? state.runStreak : 0;
```

Then add `runStreak,` to each of the three terminal returns in `settle` — the `end` return, the `condition` return, and the final worker return. For example the worker return becomes:

```ts
  return {
    ...state,
    currentNodeId: cur,
    status: 'running',
    visited: [...state.visited, cur],
    runStreak,
  };
```

In `startRun` (line 152-154), add `runStreak: 0` to the initial state object:

```ts
export function startRun(graph: TeamGraph): GraphRunState {
  return settle(graph, graph.entry, { currentNodeId: graph.entry, hops: 0, status: 'running', visited: [], runStreak: 0 });
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd packages/core && npx vitest run src/team-graph.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/team-graph.ts packages/core/src/team-graph.test.ts
git commit -m "feat(core): track consecutive worker run streak in GraphRunState"
```

---

## Task 3: `eligibleEdges` helper

**Files:**
- Modify: `packages/core/src/team-graph.ts` (add helper near `outgoingEdges`, ~line 126)
- Test: `packages/core/src/team-graph.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/core/src/team-graph.test.ts`:

```ts
import { eligibleEdges } from './team-graph';

describe('eligibleEdges', () => {
  const g: import('./team-graph').TeamGraph = {
    entry: 'start', maxHops: 20,
    nodes: [
      { id: 'start', type: 'start', x: 0, y: 0 },
      { id: 'w1', type: 'worker', worker: 'coder', maxCalls: 2, x: 1, y: 0 },
      { id: 'w2', type: 'worker', worker: 'reviewer', x: 2, y: 0 },
    ],
    edges: [
      { id: 'e0', from: 'start', to: 'w1' },
      { id: 'e1', from: 'w1', to: 'w1' },
      { id: 'e2', from: 'w1', to: 'w2' },
    ],
  };

  it('keeps the self-edge below maxCalls', () => {
    const ids = eligibleEdges(g, { ...startRun(g), currentNodeId: 'w1', runStreak: 1 }, 'w1').map(e => e.id);
    expect(ids).toContain('e1');
    expect(ids).toContain('e2');
  });

  it('drops the self-edge at/after maxCalls', () => {
    const ids = eligibleEdges(g, { ...startRun(g), currentNodeId: 'w1', runStreak: 2 }, 'w1').map(e => e.id);
    expect(ids).not.toContain('e1');
    expect(ids).toContain('e2');
  });

  it('ignores nodes without maxCalls', () => {
    const ids = eligibleEdges(g, { ...startRun(g), currentNodeId: 'w2', runStreak: 99 }, 'w2').map(e => e.id);
    expect(ids).toEqual([]); // w2 has no outgoing in this fixture
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/core && npx vitest run src/team-graph.test.ts`
Expected: FAIL — `eligibleEdges` is not exported.

- [ ] **Step 3: Add the helper**

In `packages/core/src/team-graph.ts`, add immediately after `outgoingEdges` (after line 126):

```ts
/**
 * Outgoing edges the judge may choose from. Drops a worker's self-edge once its
 * consecutive-run streak has reached the node's maxCalls, forcing an exit. For
 * nodes without maxCalls (or non-worker nodes) this equals outgoingEdges.
 */
export function eligibleEdges(graph: TeamGraph, state: GraphRunState, nodeId: string): TeamGraphEdge[] {
  const edges = outgoingEdges(graph, nodeId);
  const node = nodeMap(graph).get(nodeId);
  if (node?.type === 'worker' && node.maxCalls !== undefined && state.runStreak >= node.maxCalls) {
    return edges.filter(e => e.to !== nodeId);
  }
  return edges;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/core && npx vitest run src/team-graph.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/team-graph.ts packages/core/src/team-graph.test.ts
git commit -m "feat(core): eligibleEdges drops worker self-edge at maxCalls"
```

---

## Task 4: `resolveEdge` diamond fallback to the `no` edge

**Files:**
- Modify: `packages/core/src/team-graph.ts:175-181` (`resolveEdge`)
- Test: `packages/core/src/team-graph.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/core/src/team-graph.test.ts`:

```ts
import { resolveEdge } from './team-graph';

describe('resolveEdge diamond fallback', () => {
  const g: import('./team-graph').TeamGraph = {
    entry: 'start', maxHops: 10,
    nodes: [
      { id: 'd1', type: 'condition', condition: 'ok?', x: 0, y: 0 },
      { id: 'a', type: 'worker', worker: 'a', x: 1, y: 0 },
      { id: 'b', type: 'worker', worker: 'b', x: 2, y: 0 },
    ],
    edges: [
      { id: 'yes', from: 'd1', to: 'a', branch: 'yes' },
      { id: 'no', from: 'd1', to: 'b', branch: 'no' },
    ],
  };

  it('falls back to the no edge on a null choice', () => {
    expect(resolveEdge(g, 'd1', null)?.id).toBe('no');
  });

  it('falls back to the no edge on an unknown choice', () => {
    expect(resolveEdge(g, 'd1', 'bogus')?.id).toBe('no');
  });

  it('honors a valid choice', () => {
    expect(resolveEdge(g, 'd1', 'yes')?.id).toBe('yes');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/core && npx vitest run src/team-graph.test.ts`
Expected: FAIL — current `resolveEdge` falls back via `isDefault`, returns `null` for a diamond.

- [ ] **Step 3: Update `resolveEdge`**

Replace `resolveEdge` (lines 175-181) with:

```ts
export function resolveEdge(graph: TeamGraph, nodeId: string, chosenEdgeId: string | null): TeamGraphEdge | null {
  const edges = outgoingEdges(graph, nodeId);
  if (edges.length === 0) return null;
  const chosen = chosenEdgeId ? edges.find(e => e.id === chosenEdgeId) : undefined;
  if (chosen) return chosen;
  const node = nodeMap(graph).get(nodeId);
  if (node?.type === 'condition') {
    return edges.find(e => e.branch === 'no') ?? null;
  }
  return edges.find(e => e.isDefault) ?? null;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/core && npx vitest run src/team-graph.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/team-graph.ts packages/core/src/team-graph.test.ts
git commit -m "feat(core): resolveEdge falls back to the no branch for diamonds"
```

---

## Task 5: Judge `question` for diamond decisions

**Files:**
- Modify: `packages/core/src/judge.ts:11-17` (`JudgeInput`), `:38-65` (`buildJudgePrompt`)
- Test: `packages/core/src/judge.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/core/src/judge.test.ts` (reuse the existing `import { buildJudgePrompt } from './judge'`; add it if absent):

```ts
describe('buildJudgePrompt — decision question', () => {
  it('renders the decision question and yes/no edges', () => {
    const prompt = buildJudgePrompt({
      task: 'ship it',
      worker: 'coder',
      workerOutput: 'all green',
      blackboardSummary: '',
      question: 'Did the tests pass?',
      edges: [
        { id: 'yes', condition: 'yes', targetWorker: '(end)' },
        { id: 'no', condition: 'no', targetWorker: 'coder' },
      ],
    });
    expect(prompt).toContain('Did the tests pass?');
    expect(prompt).toContain('id="yes"');
    expect(prompt).toContain('id="no"');
  });

  it('omits the decision section when no question is given', () => {
    const prompt = buildJudgePrompt({
      task: 't', worker: 'w', workerOutput: 'o', blackboardSummary: '',
      edges: [{ id: 'e1', condition: 'tests pass', targetWorker: 'reviewer' }],
    });
    expect(prompt).not.toContain('## Decision');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/core && npx vitest run src/judge.test.ts`
Expected: FAIL — `question` is not on `JudgeInput` (compile error) and no `## Decision` section exists.

- [ ] **Step 3: Add `question` to `JudgeInput`**

In `packages/core/src/judge.ts`, add to the `JudgeInput` interface (after `blackboardSummary`, ~line 15):

```ts
  /** Diamond decision question; when set, the judge answers it yes/no over the edges. */
  question?: string;
```

- [ ] **Step 4: Render the decision section in `buildJudgePrompt`**

In `buildJudgePrompt`, insert just before the `## Outgoing edges` block (before line 58 `lines.push('## Outgoing edges (choose one)');`):

```ts
  if (input.question && input.question.trim()) {
    lines.push('## Decision');
    lines.push(`Answer this yes/no question about the latest output, then pick the matching edge: ${input.question.trim()}`);
  }
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd packages/core && npx vitest run src/judge.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/judge.ts packages/core/src/judge.test.ts
git commit -m "feat(core): judge renders an optional decision question"
```

---

## Task 6: Gateway loop — eligible edges, diamond question, runStreak persistence

**Files:**
- Modify: `packages/gateway/src/gateway.ts` — `buildJudgeEdges` (~2861), `pickNextGraphEdge` (~2878), the two `pickNextGraphEdge` call sites (~2981, ~3045), the worker-run body (~3023), the `[ASK_USER]` persist (~3032), the resume reconstruction (~2648).
- Also: the `PendingTeamState.graphState` type (find it: `grep -rn "graphState" packages/core/src` — it lives on `PendingTeamState` in core).

No unit runner for the gateway — verify via build + the core tests + manual smoke.

- [ ] **Step 1: Add `runStreak` to the persisted graph state type**

Run `grep -rn "currentNodeId" packages/core/src` to find the `PendingTeamState.graphState` shape. Add an optional field to that inline type:

```ts
    runStreak?: number;
```

(It sits alongside `currentNodeId`, `hops`, `visited`.)

- [ ] **Step 2: Make `buildJudgeEdges` use eligible edges + branch labels**

Replace the body of `buildJudgeEdges` (lines 2861-2871). Add a `state: GraphRunState` parameter and import `eligibleEdges`:

In the `@codey/core` import (line 3), add `eligibleEdges` to the named imports.

```ts
  private buildJudgeEdges(
    graph: TeamGraph,
    nodeById: Map<string, TeamGraph['nodes'][number]>,
    nodeId: string,
    state: GraphRunState,
  ): JudgeInput['edges'] {
    const node = nodeById.get(nodeId);
    return eligibleEdges(graph, state, nodeId).map(e => ({
      id: e.id,
      condition: node?.type === 'condition' ? e.branch : e.condition,
      targetWorker: nodeById.get(e.to)?.type === 'end' ? '(end)' : (nodeById.get(e.to)?.worker ?? e.to),
    }));
  }
```

- [ ] **Step 3: Pass `state` + diamond `question` through `pickNextGraphEdge`**

Replace `pickNextGraphEdge` (lines 2878-2896). Add a `state: GraphRunState` parameter and thread the question:

```ts
  private async pickNextGraphEdge(
    graph: TeamGraph,
    nodeById: Map<string, TeamGraph['nodes'][number]>,
    currentNodeId: string,
    state: GraphRunState,
    task: string,
    workerName: string,
    workerOutput: string,
    blackboardSummary: string,
    signal?: AbortSignal,
  ): Promise<{ decision: JudgeDecision; edge: TeamGraphEdge | null }> {
    const edges = this.buildJudgeEdges(graph, nodeById, currentNodeId, state);
    const node = nodeById.get(currentNodeId);
    const { agent, model } = this.getAdvisorAgentAndModel();
    const decision = await runJudge(
      { task, worker: workerName, workerOutput, blackboardSummary, edges,
        question: node?.type === 'condition' ? node.condition : undefined },
      { agent, model, runner: this.advisorRunner, signal },
    );
    const edge = resolveEdge(graph, currentNodeId, decision.edgeId);
    return { decision, edge };
  }
```

- [ ] **Step 4: Update the two call sites to pass `state`**

In the condition-node branch (line ~2981), change the call to insert `state` after `state.currentNodeId`:

```ts
        const { decision, edge } = await this.pickNextGraphEdge(
          graph, nodeById, state.currentNodeId, state, task, lastWorkerName,
          lastWorkerOutput, blackboard.renderForUser() || '',
        );
```

In the post-worker branch (line ~3045), likewise:

```ts
      const { decision, edge } = await this.pickNextGraphEdge(
        graph, nodeById, state.currentNodeId, state, task, workerName,
        ingested.stripped, blackboard.renderForUser() || '',
      );
```

- [ ] **Step 5: Increment `runStreak` when a worker runs**

In `continueGraphRun`, after `lastWorkerName = workerName;` (line ~3024) and **before** the `[ASK_USER]` pause check, add:

```ts
      state = { ...state, runStreak: state.runStreak + 1 };
```

- [ ] **Step 6: Persist + restore `runStreak`**

In the `[ASK_USER]` `persistPendingTeam` call (line ~3032), add `runStreak` to `graphState`:

```ts
          graphState: { currentNodeId: state.currentNodeId, hops: state.hops, visited: state.visited, runStreak: state.runStreak },
```

In the resume reconstruction (line ~2648), add `runStreak`:

```ts
      const state: GraphRunState = { currentNodeId: pending.graphState.currentNodeId, hops: pending.graphState.hops, status: 'running', visited: pending.graphState.visited, runStreak: pending.graphState.runStreak ?? 0 };
```

- [ ] **Step 7: Build to verify**

Run: `npm run build:core && npm run build:gateway`
Expected: both succeed with no type errors.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src packages/gateway/src/gateway.ts
git commit -m "feat(gateway): flow loop bounds worker self-loops and asks the diamond question"
```

---

## Task 7: Editor model — round-trip new fields + diamond colors

**Files:**
- Modify: `codey-mac/src/components/flowEditorModel.ts`
- Test: `codey-mac/src/components/flowEditorModel.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `codey-mac/src/components/flowEditorModel.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd codey-mac && npx vitest run src/components/flowEditorModel.test.ts`
Expected: FAIL — new fields are dropped by `toFlow`/`fromFlow`; diamond colors not implemented.

- [ ] **Step 3: Extend the `FlowNode`/`FlowEdge` types**

In `codey-mac/src/components/flowEditorModel.ts`, replace lines 3-4 with:

```ts
export interface FlowNode { id: string; position: { x: number; y: number }; data: { label: string; type: TeamGraphNode['type']; worker?: string; condition?: string; maxCalls?: number }; type?: string; width?: number; height?: number }
export interface FlowEdge { id: string; source: string; target: string; sourceHandle?: string; targetHandle?: string; label?: string; data: { condition?: string; isDefault?: boolean; branch?: 'yes' | 'no' } }
```

- [ ] **Step 4: Round-trip the new fields**

Replace `toFlow` (lines 6-19) with:

```ts
export function toFlow(g: TeamGraph): { nodes: FlowNode[]; edges: FlowEdge[] } {
  const nodes = g.nodes.map(n => ({
    id: n.id,
    position: { x: n.x, y: n.y },
    data: { label: n.type === 'worker' ? (n.worker ?? '?') : n.type, type: n.type, worker: n.worker, condition: n.condition, maxCalls: n.maxCalls },
    ...(n.width !== undefined ? { width: n.width } : {}),
    ...(n.height !== undefined ? { height: n.height } : {}),
  }))
  const edges = g.edges.map(e => ({
    id: e.id, source: e.from, target: e.to,
    sourceHandle: e.sourceHandle, targetHandle: e.targetHandle,
    label: e.isDefault ? 'default' : e.branch ?? e.condition,
    data: { condition: e.condition, isDefault: e.isDefault, branch: e.branch },
  }))
  return { nodes, edges }
}
```

In `fromFlow`, extend the node mapping (after `if (n.data.worker !== undefined) node.worker = n.data.worker`):

```ts
    if (n.data.condition !== undefined) node.condition = n.data.condition
    if (n.data.maxCalls !== undefined) node.maxCalls = n.data.maxCalls
    if (n.width !== undefined) node.width = n.width
    if (n.height !== undefined) node.height = n.height
```

and the edge mapping (after `if (e.data.isDefault !== undefined) edge.isDefault = e.data.isDefault`):

```ts
    if (e.data.branch !== undefined) edge.branch = e.data.branch
```

- [ ] **Step 5: Add diamond colors to `branchColors`**

Replace `branchColors` (lines 62-77) with:

```ts
export function branchColors(nodes: FlowNode[], edges: FlowEdge[]): Record<string, string> {
  const typeById = new Map(nodes.map(n => [n.id, n.data?.type]))
  const bySource = new Map<string, FlowEdge[]>()
  for (const e of edges) {
    if (!bySource.has(e.source)) bySource.set(e.source, [])
    bySource.get(e.source)!.push(e)
  }
  const out: Record<string, string> = {}
  for (const [source, group] of bySource) {
    if (typeById.get(source) === 'condition') {
      for (const e of group) out[e.id] = e.data?.branch === 'no' ? '#ef4444' : '#22c55e'
      continue
    }
    if (group.length < 2) continue
    let i = 0
    for (const e of group) {
      out[e.id] = e.data?.isDefault ? '#888' : BRANCH_PALETTE[i++ % BRANCH_PALETTE.length]
    }
  }
  return out
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd codey-mac && npx vitest run src/components/flowEditorModel.test.ts`
Expected: PASS (existing + new).

- [ ] **Step 7: Commit**

```bash
git add codey-mac/src/components/flowEditorModel.ts codey-mac/src/components/flowEditorModel.test.ts
git commit -m "feat(codey-mac): round-trip diamond/maxCalls/size fields and color diamond edges"
```

---

## Task 8: Editor — node inspector, yes/no diamond edges, self-loop

**Files:**
- Modify: `codey-mac/src/components/FlowEditor.tsx`

No unit runner — verify via `npx vite build` + manual.

- [ ] **Step 1: Track a selected node and auto-label diamond edges on connect**

In `FlowEditorInner`, add state next to `selEdge` (line 91):

```ts
  const [selNode, setSelNode] = useState<string | null>(null)
```

Replace `onConnect` (lines 100-106) so an edge leaving a diamond is auto-assigned `branch: 'yes'` (first) then `'no'` (second):

```ts
  const onConnect = useCallback((c: Connection) =>
    setEdges(es => {
      const fromNode = nodes.find(n => n.id === c.source)
      let data: any = {}
      if ((fromNode?.data as any)?.type === 'condition') {
        const existing = es.filter(e => e.source === c.source)
        data = { branch: existing.some(e => (e as any).data?.branch === 'yes') ? 'no' : 'yes' }
        if (existing.length >= 2) return es // a diamond has exactly two outcomes
      }
      return addEdge({
        ...c, id: `e_${Date.now()}`,
        sourceHandle: c.sourceHandle ?? undefined,
        targetHandle: c.targetHandle ?? undefined,
        label: data.branch,
        data,
      } as any, es)
    }), [nodes])
```

- [ ] **Step 2: Add node-update helpers and wire `onNodeClick`**

Add near `updateEdge` (line 142):

```ts
  const updateNodeData = (id: string, patch: any) =>
    setNodes(ns => ns.map(n => n.id === id ? { ...n, data: { ...n.data, ...patch } } : n))
```

On the `<ReactFlow>` element (line 192), add an `onNodeClick` handler and clear the edge selection:

```tsx
                onNodeClick={(_, n) => { setSelNode(n.id); setSelEdge(null) }}
```

- [ ] **Step 3: Render the node inspector**

Add a `selN` lookup next to `sel` (line 154):

```ts
  const selN = nodes.find(n => n.id === selNode) as any
  const selfLoops = selN ? edges.some(e => e.source === selN.id && e.target === selN.id) : false
```

Replace the edge-condition panel block (lines 198-206) with a combined inspector. The edge panel now only opens for **worker** edges; diamond edges are read-only labels:

```tsx
          {!showRaw && selN && (selN.data?.type === 'worker' || selN.data?.type === 'condition') && (
            <div style={{ width: 240, borderLeft: `1px solid ${C.border}`, padding: 10, overflowY: 'auto' }}>
              {selN.data?.type === 'worker' ? (
                <>
                  <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>{selN.data.worker}</div>
                  <div style={{ fontSize: 11, color: C.fg3, marginBottom: 10, whiteSpace: 'pre-wrap' }}>
                    {workerRoles[selN.data.worker] || 'No description.'}
                  </div>
                  {selfLoops && (
                    <label style={{ fontSize: 12, display: 'block' }}>
                      Max self-loops
                      <input type="number" min={1} value={selN.data.maxCalls ?? ''} placeholder="∞"
                        onChange={e => updateNodeData(selN.id, { maxCalls: e.target.value === '' ? undefined : Math.max(1, Number(e.target.value) || 1) })}
                        style={{ width: 64, marginLeft: 6 }} />
                    </label>
                  )}
                </>
              ) : (
                <>
                  <div style={{ fontSize: 11, color: C.fg3, marginBottom: 6 }}>Decision</div>
                  <textarea value={selN.data.condition ?? ''} placeholder='e.g. "Did the tests pass?"'
                    onChange={e => updateNodeData(selN.id, { condition: e.target.value })}
                    style={{ width: '100%', minHeight: 70, fontSize: 12, padding: 6, background: C.surface2, color: C.fg, border: `1px solid ${C.border}`, borderRadius: 6 }} />
                  <div style={{ fontSize: 10, color: C.fg3, marginTop: 6 }}>Yes edge → green · No edge → red</div>
                </>
              )}
            </div>
          )}
          {!showRaw && !selN && sel && (sel.data?.branch === undefined) && (
            <div style={{ width: 220, borderLeft: `1px solid ${C.border}`, padding: 10 }}>
              <div style={{ fontSize: 11, color: C.fg3, marginBottom: 6 }}>Edge condition</div>
              <textarea value={sel.data?.condition ?? ''} onChange={e => updateEdge(sel.id, { condition: e.target.value, isDefault: false })} placeholder='e.g. "tests pass"' style={{ width: '100%', minHeight: 70, fontSize: 12, padding: 6, background: C.surface2, color: C.fg, border: `1px solid ${C.border}`, borderRadius: 6 }} />
              <label style={{ fontSize: 12, display: 'block', marginTop: 8 }}>
                <input type="checkbox" checked={!!sel.data?.isDefault} onChange={e => updateEdge(sel.id, { isDefault: e.target.checked, condition: e.target.checked ? undefined : sel.data?.condition })} /> default (else) edge
              </label>
            </div>
          )}
```

(`onEdgeClick` already sets `selEdge`; also clear `selNode` there so the panels don't fight — update line 192's `onEdgeClick` to `onEdgeClick={(_, e) => { setSelEdge(e.id); setSelNode(null) }}`.)

- [ ] **Step 4: Build to verify**

Run: `cd codey-mac && npx vite build`
Expected: build succeeds.

- [ ] **Step 5: Manual smoke**

Run the app (`cd codey-mac && npm run dev`). Open a Sequential team's flow editor and verify: tapping a diamond opens the Decision textarea and typing persists; drawing two edges out of the diamond labels them yes (green) / no (red); a third edge out of the diamond is rejected; tapping a worker shows its full description; drawing a worker→itself edge then tapping the worker shows the Max self-loops field.

- [ ] **Step 6: Commit**

```bash
git add codey-mac/src/components/FlowEditor.tsx
git commit -m "feat(codey-mac): node inspector with diamond question, worker description, and self-loop cap"
```

---

## Task 9: Editor — resizable worker cards

**Files:**
- Modify: `codey-mac/src/components/FlowEditor.tsx`

No unit runner — verify via `npx vite build` + manual.

- [ ] **Step 1: Import `NodeResizer` and persist size on resize**

In the `@xyflow/react` import (lines 2-7), add `NodeResizer`:

```ts
  NodeResizer,
```

(`NodeResizer`'s styles ship with `@xyflow/react/dist/style.css`, already imported.)

- [ ] **Step 2: Make the worker card resizable**

Replace `WorkerNodeView` (lines 33-42) with:

```tsx
function WorkerNodeView({ data, selected, width, height }: NodeProps) {
  const d = data as { label: string; role?: string }
  return (
    <div style={{ width: width ?? undefined, height: height ?? undefined, minWidth: 120, padding: '8px 10px', borderRadius: 8, background: C.surface2, border: `1px solid ${C.border}`, color: C.fg, boxSizing: 'border-box' }}>
      <NodeResizer isVisible={selected} minWidth={120} minHeight={48} />
      <div style={{ fontSize: 13, fontWeight: 600 }}>{d.label}</div>
      {d.role && <div style={{ fontSize: 11, color: C.fg3, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.role}</div>}
      <NodeHandles />
    </div>
  )
}
```

(React Flow writes the dragged size into each node's `width`/`height` via `onNodesChange`, which `flowEditorModel.fromFlow` already persists — Task 7. `ConditionNodeView` and `TerminalNodeView` are left unchanged, so start/end/diamond stay fixed-size.)

- [ ] **Step 3: Build to verify**

Run: `cd codey-mac && npx vite build`
Expected: build succeeds.

- [ ] **Step 4: Manual smoke**

Run the app, select a worker card, drag a resize handle, then Save → reopen → toggle Raw config and confirm the node shows `width`/`height`. Confirm start/end pills and the diamond are not resizable.

- [ ] **Step 5: Commit**

```bash
git add codey-mac/src/components/FlowEditor.tsx
git commit -m "feat(codey-mac): resizable worker cards via NodeResizer"
```

---

## Final verification

- [ ] **Core tests:** `cd packages/core && npx vitest run` → PASS
- [ ] **Editor model tests:** `cd codey-mac && npx vitest run src/components/flowEditorModel.test.ts` → PASS
- [ ] **Builds:** `npm run build:core && npm run build:gateway` and `cd codey-mac && npx vite build` → all succeed
- [ ] **Lint:** `npm run lint` (non-English character check) → PASS
- [ ] **Manual (Mac app):** diamond holds a yes/no question with green/no-red edges; worker inspector shows full description + max-self-loops; a worker self-loop runs `maxCalls` times then exits; worker cards resize and the size survives Save → reopen.

---

## Self-review notes (resolved)

- **Spec coverage:** diamond carries condition → Tasks 1, 5, 6, 8; yes/no edges → Tasks 1, 7, 8; worker branching kept → unchanged (validation only *adds* self-loop rules); worker self-loop + maxCalls → Tasks 1, 2, 3, 6, 8; node inspector → Task 8; resizable worker cards → Tasks 7, 9; back-compat fields presentation-only → Tasks 1, 7.
- **Type consistency:** `condition`/`maxCalls`/`width`/`height` (node) and `branch: 'yes'|'no'` (edge) are defined once in Task 1 and reused identically in `flowEditorModel` (Task 7), `eligibleEdges` (Task 3), `resolveEdge` (Task 4), and the gateway (Task 6). `runStreak` is added to `GraphRunState` in Task 2 and consumed in Tasks 3 and 6. `buildJudgeEdges`/`pickNextGraphEdge` gain a `state` parameter in Task 6 at both call sites.
- **Gateway no-test caveat:** Task 6 has no unit runner; it relies on the Task 1-5 core tests for validate/streak/eligible/resolve/judge guarantees plus a build + manual smoke.
