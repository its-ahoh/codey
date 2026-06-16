# Flow Canvas Decision Nodes + Editor Upgrades Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a real diamond decision node to the Sequential flow graph (model + judge-driven runtime) and four editor upgrades — multiple connection handles, always-on animated/colored edges, drag-to-canvas, and bigger worker cards with a role description.

**Architecture:** A new `condition` node type is a *branch point with no worker*: the existing judge LLM evaluates its outgoing edges using the last worker's output, exactly as it does for worker edges today. `settle()` stops at condition nodes; the gateway run loop branches on node type and threads `lastWorkerOutput`. The editor moves to custom React Flow node components, persists per-edge handle ids, animates edges, and supports palette drag-drop.

**Tech Stack:** TypeScript (ES2020/CommonJS, strict), `@xyflow/react` (React Flow) in the Electron/Vite `codey-mac` app, Vitest for `@codey/core` and `codey-mac`. The gateway has no test runner.

**Prerequisite for every test/build command below:** use Node v22.17.1 (`nvm use 22.17.1`). The repo's default Node v16 cannot run vitest/tsc. Spec: `docs/superpowers/specs/2026-06-15-flow-canvas-decision-nodes-design.md`.

---

## File Structure

| File | Responsibility | Change |
|------|----------------|--------|
| `packages/core/src/team-graph.ts` | Graph types, `settle`/`advance`, `validateGraph` | add `condition` type, edge handle fields, settle + validate rules |
| `packages/core/src/team-graph.test.ts` | Core unit tests | settle/advance/validate coverage for condition nodes |
| `packages/gateway/src/gateway.ts` | Flow run loop (2 variants) | node-type branching + `lastWorkerOutput` threading (manual verify) |
| `codey-mac/src/components/flowEditorModel.ts` | React Flow ↔ TeamGraph mapping | handle fields, condition mapping, branch-color helper |
| `codey-mac/src/components/flowEditorModel.test.ts` | Model round-trip tests | condition + handle round-trip, color helper |
| `codey-mac/src/components/FlowEditor.tsx` | Canvas editor | custom nodes, handles, animation, drag-drop, palette |
| `codey-mac/src/components/GlobalTeamsSection.tsx` | Team library UI | pass worker role lookup into `FlowEditor` |

---

## Task 1: Core — add `condition` node type and edge handle fields

**Files:**
- Modify: `packages/core/src/team-graph.ts:1-27`

- [ ] **Step 1: Add `condition` to the node type union and handle fields to the edge**

In `packages/core/src/team-graph.ts`, change the type union and edge interface:

```ts
export type TeamGraphNodeType = 'start' | 'worker' | 'condition' | 'end';
```

In `interface TeamGraphEdge`, after the `isDefault?` field, add:

```ts
  /** Presentation-only: React Flow source handle id. Ignored by the runtime. */
  sourceHandle?: string;
  /** Presentation-only: React Flow target handle id. Ignored by the runtime. */
  targetHandle?: string;
```

- [ ] **Step 2: Verify it compiles**

Run: `cd packages/core && npx tsc --noEmit`
Expected: PASS (no errors).

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/team-graph.ts
git commit -m "feat(core): add condition node type and edge handle fields"
```

---

## Task 2: Core — `settle()` stops at condition nodes

**Files:**
- Modify: `packages/core/src/team-graph.ts:116-135`
- Test: `packages/core/src/team-graph.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/core/src/team-graph.test.ts` (import helpers already used by the file; match its existing import style):

```ts
import { describe, it, expect } from 'vitest';
import { startRun, advance, type TeamGraph } from './team-graph';

function graphWithCondition(): TeamGraph {
  return {
    entry: 'start', maxHops: 20,
    nodes: [
      { id: 'start', type: 'start', x: 0, y: 0 },
      { id: 'w1', type: 'worker', worker: 'coder', x: 100, y: 0 },
      { id: 'c1', type: 'condition', x: 200, y: 0 },
      { id: 'w2', type: 'worker', worker: 'reviewer', x: 300, y: 0 },
      { id: 'end', type: 'end', x: 400, y: 0 },
    ],
    edges: [
      { id: 'e0', from: 'start', to: 'w1' },
      { id: 'e1', from: 'w1', to: 'c1' },
      { id: 'e2', from: 'c1', to: 'w2', condition: 'needs review' },
      { id: 'e3', from: 'c1', to: 'end', isDefault: true },
    ],
  };
}

describe('condition node settle', () => {
  it('settles onto a condition node without recording it in visited', () => {
    const g = graphWithCondition();
    let s = startRun(g);            // start -> w1
    expect(s.currentNodeId).toBe('w1');
    s = advance(g, s, 'e1');        // w1 -> c1
    expect(s.currentNodeId).toBe('c1');
    expect(s.status).toBe('running');
    expect(s.visited).toEqual(['w1']); // condition NOT in visited
  });

  it('advances from a condition node to the next worker', () => {
    const g = graphWithCondition();
    let s = startRun(g);
    s = advance(g, s, 'e1');        // at c1
    s = advance(g, s, 'e2');        // c1 -> w2
    expect(s.currentNodeId).toBe('w2');
    expect(s.visited).toEqual(['w1', 'w2']);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/core && npx vitest run src/team-graph.test.ts -t "condition node settle"`
Expected: FAIL — current `settle()` records `c1` in `visited` (treats it like a worker).

- [ ] **Step 3: Update `settle()` to handle condition nodes**

In `packages/core/src/team-graph.ts`, in `settle()` (currently lines ~117-135), after the `start`-walk loop and the `end` check, add a `condition` branch BEFORE the final worker return:

```ts
  const node = nodes.get(cur);
  if (!node) return { ...state, currentNodeId: cur, status: 'stuck' };
  if (node.type === 'end') return { ...state, currentNodeId: cur, status: 'done' };
  if (node.type === 'condition') {
    // Branch point: stop here so the orchestrator can run the judge. Do not
    // record it in `visited` (worker-only history).
    return { ...state, currentNodeId: cur, status: 'running' };
  }
  return {
    ...state,
    currentNodeId: cur,
    status: 'running',
    visited: [...state.visited, cur],
  };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/core && npx vitest run src/team-graph.test.ts -t "condition node settle"`
Expected: PASS (both cases).

- [ ] **Step 5: Run the full core suite to check no regressions**

Run: `cd packages/core && npx vitest run`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/team-graph.ts packages/core/src/team-graph.test.ts
git commit -m "feat(core): settle stops at condition nodes without recording history"
```

---

## Task 3: Core — `validateGraph` rules for condition nodes

**Files:**
- Modify: `packages/core/src/team-graph.ts:36-96`
- Test: `packages/core/src/team-graph.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/core/src/team-graph.test.ts`:

```ts
import { validateGraph } from './team-graph';

describe('condition node validation', () => {
  const workers = ['coder', 'reviewer'];

  it('rejects a condition node that carries a worker', () => {
    const g = graphWithCondition();
    (g.nodes.find(n => n.id === 'c1') as any).worker = 'coder';
    const problems = validateGraph(g, workers);
    expect(problems.some(p => p.includes('c1') && p.includes('worker'))).toBe(true);
  });

  it('rejects a condition node with no default outgoing edge', () => {
    const g = graphWithCondition();
    // drop the default flag from e3
    g.edges = g.edges.map(e => e.id === 'e3' ? { ...e, isDefault: false } : e);
    const problems = validateGraph(g, workers);
    expect(problems.some(p => p.includes('c1') && p.includes('default'))).toBe(true);
  });

  it('accepts a well-formed condition node', () => {
    expect(validateGraph(graphWithCondition(), workers)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/core && npx vitest run src/team-graph.test.ts -t "condition node validation"`
Expected: FAIL — no condition-specific rules yet.

- [ ] **Step 3: Add condition rules to `validateGraph`**

In `packages/core/src/team-graph.ts`, inside the `for (const node of graph.nodes)` loop that currently checks `node.type === 'worker'` (lines ~45-53), add an `else if`:

```ts
    } else if (node.type === 'condition') {
      if (node.worker) {
        problems.push(`condition node "${node.id}" must not reference a worker`);
      }
      const outs = graph.edges.filter(e => e.from === node.id);
      if (!outs.some(e => e.isDefault)) {
        problems.push(`condition node "${node.id}" needs a default outgoing edge`);
      }
    }
```

Then extend the "has no outgoing edge" rule (lines ~67-73) so condition nodes are included:

```ts
  for (const node of graph.nodes) {
    const hasOut = (outgoing.get(node.id)?.length ?? 0) > 0;
    if ((node.type === 'worker' || node.type === 'start' || node.type === 'condition') && !hasOut) {
      const label = node.type === 'start' ? 'start node' : node.type === 'condition' ? 'condition node' : 'worker node';
      problems.push(`${label} "${node.id}" has no outgoing edge`);
    }
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/core && npx vitest run src/team-graph.test.ts -t "condition node validation"`
Expected: PASS (all three cases).

- [ ] **Step 5: Run the full core suite**

Run: `cd packages/core && npx vitest run`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/team-graph.ts packages/core/src/team-graph.test.ts
git commit -m "feat(core): validate condition nodes (no worker, require default edge)"
```

---

## Task 4: Editor model — handle fields + condition round-trip

**Files:**
- Modify: `codey-mac/src/components/flowEditorModel.ts:1-50`
- Test: `codey-mac/src/components/flowEditorModel.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `codey-mac/src/components/flowEditorModel.test.ts` (match its existing import style; it imports from `./flowEditorModel`):

```ts
import { describe, it, expect } from 'vitest';
import { toFlow, fromFlow } from './flowEditorModel';
import type { TeamGraph } from '../../../packages/core/src/team-graph';

const g: TeamGraph = {
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
};

describe('flowEditorModel condition + handles round-trip', () => {
  it('preserves condition node type and edge handles', () => {
    const flow = toFlow(g);
    const cNode = flow.nodes.find(n => n.id === 'c1')!;
    expect(cNode.data.type).toBe('condition');

    const back = fromFlow(flow.nodes, flow.edges, g.entry, g.maxHops);
    expect(back.nodes.find(n => n.id === 'c1')!.type).toBe('condition');
    const e1 = back.edges.find(e => e.id === 'e1')!;
    expect(e1.sourceHandle).toBe('r');
    expect(e1.targetHandle).toBe('l');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd codey-mac && npx vitest run src/components/flowEditorModel.test.ts -t "condition + handles"`
Expected: FAIL — handles are dropped by `fromFlow`/`toFlow`.

- [ ] **Step 3: Thread handle fields through the model**

In `codey-mac/src/components/flowEditorModel.ts`:

Extend `FlowEdge.data` (line ~4) to carry handles, and add top-level handle fields React Flow uses:

```ts
export interface FlowEdge { id: string; source: string; target: string; sourceHandle?: string; targetHandle?: string; label?: string; data: { condition?: string; isDefault?: boolean } }
```

In `toFlow`, map handles onto each edge:

```ts
  const edges = g.edges.map(e => ({
    id: e.id, source: e.from, target: e.to,
    sourceHandle: e.sourceHandle, targetHandle: e.targetHandle,
    label: e.isDefault ? 'default' : e.condition,
    data: { condition: e.condition, isDefault: e.isDefault },
  }))
```

In `fromFlow`, write handles back onto the `TeamGraphEdge`:

```ts
  const gEdges: TeamGraphEdge[] = edges.map(e => {
    const edge: TeamGraphEdge = { id: e.id, from: e.source, to: e.target }
    if (e.data.condition !== undefined) edge.condition = e.data.condition
    if (e.data.isDefault !== undefined) edge.isDefault = e.data.isDefault
    if (e.sourceHandle) edge.sourceHandle = e.sourceHandle
    if (e.targetHandle) edge.targetHandle = e.targetHandle
    return edge
  })
```

Note: `toFlow`'s node `label` for a `condition` node falls through to `n.type` (i.e. `'condition'`) via the existing `n.type === 'worker' ? ... : n.type` expression — no change needed there.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd codey-mac && npx vitest run src/components/flowEditorModel.test.ts -t "condition + handles"`
Expected: PASS.

- [ ] **Step 5: Run the full model test file**

Run: `cd codey-mac && npx vitest run src/components/flowEditorModel.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add codey-mac/src/components/flowEditorModel.ts codey-mac/src/components/flowEditorModel.test.ts
git commit -m "feat(codey-mac): round-trip condition nodes and edge handles in flow model"
```

---

## Task 5: Editor model — branch color helper

**Files:**
- Modify: `codey-mac/src/components/flowEditorModel.ts`
- Test: `codey-mac/src/components/flowEditorModel.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `codey-mac/src/components/flowEditorModel.test.ts`:

```ts
import { branchColors } from './flowEditorModel';

describe('branchColors', () => {
  it('colors non-default branch edges distinctly and default gray', () => {
    const colors = branchColors(g.nodes.map(n => ({ id: n.id })) as any, [
      { id: 'e2a', source: 'c1', data: { isDefault: false } },
      { id: 'e2b', source: 'c1', data: { isDefault: true } },
    ] as any);
    expect(colors['e2a']).toBeTruthy();
    expect(colors['e2b']).toBe('#888');     // default = gray
    expect(colors['e2a']).not.toBe('#888');
  });

  it('does not color edges out of a single-output node', () => {
    const colors = branchColors([{ id: 'w1' }] as any, [
      { id: 'only', source: 'w1', data: {} },
    ] as any);
    expect(colors['only']).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd codey-mac && npx vitest run src/components/flowEditorModel.test.ts -t "branchColors"`
Expected: FAIL — `branchColors` not exported.

- [ ] **Step 3: Implement `branchColors`**

Add to `codey-mac/src/components/flowEditorModel.ts`:

```ts
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd codey-mac && npx vitest run src/components/flowEditorModel.test.ts -t "branchColors"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add codey-mac/src/components/flowEditorModel.ts codey-mac/src/components/flowEditorModel.test.ts
git commit -m "feat(codey-mac): branchColors helper for edge coloring"
```

---

## Task 6: Gateway — run loop branches on node type

**Files:**
- Modify: `packages/gateway/src/gateway.ts:2966-3044` (`continueGraphRun`)
- Modify: `packages/gateway/src/gateway.ts` (the `runSequentialGraphForChatSink` loop, ~3052+)

> The gateway has no unit-test runner. Verify with a TypeScript build and a manual run (Step 4/5). Make the SAME change in both loop variants.

- [ ] **Step 1: Thread `lastWorkerOutput` and branch on node type in `continueGraphRun`**

In `continueGraphRun`, before the `while (state.status === 'running')` loop, add:

```ts
    let lastWorkerOutput = ''
    let lastWorkerName = ''
```

Inside the loop, replace the current body that assumes a worker node. At the top of the loop, after `const node = nodeById.get(state.currentNodeId)!`, branch:

```ts
      if (node.type === 'condition') {
        // Branch point: no worker runs. Judge picks among the diamond's edges
        // using the last worker's output.
        const { decision, edge } = await this.pickNextGraphEdge(
          graph, nodeById, state.currentNodeId, task, lastWorkerName,
          lastWorkerOutput, blackboard.renderForUser() || '',
        )
        if (!edge) {
          await emitter.status(`🏁 Flow stopped at a decision point (no matching branch).`)
          break
        }
        await emitter.status(`↪️ ${decision.fallback ? '(default) ' : ''}${decision.reason || 'branch'}`)
        state = advance(graph, state, edge.id)
        continue
      }
```

Keep the existing worker logic below this branch. In the worker path, after `const ingested = blackboard.ingest(...)`, set:

```ts
      lastWorkerOutput = ingested.stripped
      lastWorkerName = workerName
```

(The existing `pickNextGraphEdge` call for the worker path stays as-is — workers may still carry their own conditioned edges.)

- [ ] **Step 2: Apply the identical branch to `runSequentialGraphForChatSink`**

Find the sink variant's `while (state.status === 'running')` loop (after line ~3052). Add the same `let lastWorkerOutput = ''` / `let lastWorkerName = ''` before the loop, the same `if (node.type === 'condition') { ... continue }` block at the top, and the same `lastWorkerOutput`/`lastWorkerName` assignment after the worker's `ingest`. Use the sink variant's existing emit/status helpers (mirror its current worker-path style rather than copying `emitter.status` verbatim if it differs).

- [ ] **Step 3: Type-check the gateway**

Run: `cd packages/gateway && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Build core + gateway**

Run: `cd /path/to/codey && npm run build:core && npm run build:gateway`
Expected: both build with no errors.

- [ ] **Step 5: Manual smoke (document result in the commit body)**

Construct a tiny team graph in a scratch `gateway.json` (or reuse a test workspace) with `coder → diamond → {reviewer if "needs review", end default}` and run a `/team` task. Confirm: the diamond does not run a worker, a `↪️` branch status appears, and the flow reaches `reviewer` or `end`. If a full run isn't feasible in this environment, note that and rely on the core tests (Task 2/3) for the settle/advance/validate guarantees the loop depends on.

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/src/gateway.ts
git commit -m "feat(gateway): flow loop runs the judge at condition nodes"
```

---

## Task 7: Editor — custom node components (worker card, diamond, terminal)

**Files:**
- Modify: `codey-mac/src/components/FlowEditor.tsx`

> Visual change, no unit test. Verify by `vite build` (Step 3) and manual open.

- [ ] **Step 1: Extend `FlowEditor` props to receive worker roles**

In `codey-mac/src/components/FlowEditor.tsx`, change the `Props` interface to add a role lookup:

```ts
interface Props {
  teamName: string
  workerNames: string[]
  workerRoles?: Record<string, string>   // name -> personality.role (one-liner)
  graph: TeamGraph
  onSave: (graph: TeamGraph) => void
  onClose: () => void
}
```

Destructure `workerRoles = {}` in the component signature.

- [ ] **Step 2: Define custom node components and `nodeTypes`**

Add, above the `FlowEditor` component, custom node renderers using `Handle`/`Position` from `@xyflow/react`. Each interactive node exposes four handles (top/right/bottom/left) that act as both source and target so edges can attach at distinct points:

```tsx
import { Handle, Position, type NodeProps } from '@xyflow/react'

const HANDLE_IDS = ['t', 'r', 'b', 'l'] as const
const HANDLE_POS = { t: Position.Top, r: Position.Right, b: Position.Bottom, l: Position.Left }

function NodeHandles() {
  return (
    <>
      {HANDLE_IDS.map(id => (
        <Handle key={`s-${id}`} type="source" id={id} position={HANDLE_POS[id]} style={{ background: C.accent }} />
      ))}
      {HANDLE_IDS.map(id => (
        <Handle key={`tg-${id}`} type="target" id={id} position={HANDLE_POS[id]} style={{ background: C.fg3 }} />
      ))}
    </>
  )
}

function WorkerNodeView({ data }: NodeProps) {
  const d = data as { label: string; role?: string }
  return (
    <div style={{ minWidth: 150, padding: '8px 10px', borderRadius: 8, background: C.surface2, border: `1px solid ${C.border}`, color: C.fg }}>
      <div style={{ fontSize: 13, fontWeight: 600 }}>{d.label}</div>
      {d.role && <div style={{ fontSize: 11, color: C.fg3, marginTop: 2, maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.role}</div>}
      <NodeHandles />
    </div>
  )
}

function ConditionNodeView() {
  return (
    <div style={{ width: 90, height: 90, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ width: 64, height: 64, transform: 'rotate(45deg)', background: C.surface2, border: `1px solid ${C.accent}`, borderRadius: 8 }} />
      <span style={{ position: 'absolute', fontSize: 11, color: C.fg3 }}>?</span>
      <NodeHandles />
    </div>
  )
}

function TerminalNodeView({ data }: NodeProps) {
  const d = data as { label: string }
  return (
    <div style={{ padding: '6px 14px', borderRadius: 999, background: C.bg, border: `1px solid ${C.border}`, color: C.fg, fontSize: 12 }}>
      {d.label}
      <NodeHandles />
    </div>
  )
}

const nodeTypes = { workerNode: WorkerNodeView, conditionNode: ConditionNodeView, terminalNode: TerminalNodeView }
```

- [ ] **Step 3: Assign `type` to nodes and pass `role` into worker node data**

When building the initial nodes (the `toFlow` result at line ~20), set each React Flow node's `type` field and inject `role`. Add a mapper after `const initial = useMemo(...)`:

```ts
  const withTypes = (ns: Node[]): Node[] => ns.map(n => {
    const t = (n.data as any).type
    const rfType = t === 'worker' ? 'workerNode' : t === 'condition' ? 'conditionNode' : 'terminalNode'
    const role = t === 'worker' ? workerRoles[(n.data as any).worker] : undefined
    return { ...n, type: rfType, data: { ...n.data, role } }
  })
```

Initialize state with it: `useState<Node[]>(withTypes(initial.nodes as unknown as Node[]))`.

Pass `nodeTypes` to `<ReactFlow ... nodeTypes={nodeTypes}>`.

- [ ] **Step 4: Build to verify**

Run: `cd codey-mac && npx vite build`
Expected: build succeeds (TypeScript + bundling).

- [ ] **Step 5: Commit**

```bash
git add codey-mac/src/components/FlowEditor.tsx
git commit -m "feat(codey-mac): custom flow nodes (worker card with role, diamond, terminal)"
```

---

## Task 8: Editor — persist handles on connect + animated/colored edges

**Files:**
- Modify: `codey-mac/src/components/FlowEditor.tsx`

- [ ] **Step 1: Capture handles in `onConnect`**

Replace the `onConnect` callback (line ~33) so it records the handles React Flow reports:

```ts
  const onConnect = useCallback((c: Connection) =>
    setEdges(es => addEdge({
      ...c, id: `e_${Date.now()}`,
      sourceHandle: c.sourceHandle ?? undefined,
      targetHandle: c.targetHandle ?? undefined,
      data: {},
    } as any, es)), [])
```

- [ ] **Step 2: Derive styled edges (animated + branch colors) for rendering**

Add, before the `return`:

```ts
  const colors = useMemo(() => branchColors(nodes as any, edges as any), [nodes, edges])
  const styledEdges = useMemo(() => edges.map(e => ({
    ...e,
    animated: true,
    style: { ...(e as any).style, stroke: colors[e.id] ?? C.fg3 },
  })), [edges, colors])
```

Import `branchColors` from `./flowEditorModel` (extend the existing import on line 8).

- [ ] **Step 3: Render `styledEdges` instead of `edges`**

In the `<ReactFlow>` element, change `edges={edges}` to `edges={styledEdges}`. Keep `onEdgesChange`/`onConnect`/`onEdgeClick` bound to the real `edges` state (they operate by id, so styling is render-only).

- [ ] **Step 4: Build to verify**

Run: `cd codey-mac && npx vite build`
Expected: build succeeds.

- [ ] **Step 5: Commit**

```bash
git add codey-mac/src/components/FlowEditor.tsx
git commit -m "feat(codey-mac): persist edge handles, animate + color branch edges"
```

---

## Task 9: Editor — drag workers/condition onto the canvas

**Files:**
- Modify: `codey-mac/src/components/FlowEditor.tsx`

- [ ] **Step 1: Wrap the canvas in `ReactFlowProvider`**

Import `ReactFlowProvider, useReactFlow` from `@xyflow/react`. The default export becomes a thin wrapper; rename the current component to `FlowEditorInner` and add:

```tsx
export default function FlowEditor(props: Props) {
  return <ReactFlowProvider><FlowEditorInner {...props} /></ReactFlowProvider>
}
```

- [ ] **Step 2: Add drag source to palette items**

In the Workers palette (lines ~62-67), make each button draggable and add a Condition button:

```tsx
{workerNames.map(w => (
  <button key={w} draggable
    onDragStart={e => e.dataTransfer.setData('application/codey-node', JSON.stringify({ kind: 'worker', worker: w }))}
    onClick={() => addWorker(w)}
    style={{ /* keep existing styles, enlarge: padding '8px 8px', minHeight 40 */ }}>
    <div style={{ fontWeight: 600 }}>+ {w}</div>
    {workerRoles[w] && <div style={{ fontSize: 10, color: C.fg3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{workerRoles[w]}</div>}
  </button>
))}
<button draggable
  onDragStart={e => e.dataTransfer.setData('application/codey-node', JSON.stringify({ kind: 'condition' }))}
  onClick={() => addCondition()}
  style={{ display: 'block', width: '100%', marginTop: 8, fontSize: 12, padding: '6px', background: C.surface2, border: `1px dashed ${C.accent}`, borderRadius: 6, cursor: 'pointer' }}>◇ + Condition</button>
```

- [ ] **Step 3: Add `addCondition` and drop handling**

Add near `addWorker`:

```ts
  const rf = useReactFlow()
  const addCondition = () => {
    const id = newNodeId(nodes.map(n => n.id))
    setNodes(ns => [...ns, { id, type: 'conditionNode', position: { x: 260, y: 60 + ns.length * 70 }, data: { label: 'condition', type: 'condition' } } as any])
  }
  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    const raw = e.dataTransfer.getData('application/codey-node')
    if (!raw) return
    const payload = JSON.parse(raw) as { kind: 'worker' | 'condition'; worker?: string }
    const position = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY })
    const id = newNodeId(nodes.map(n => n.id))
    if (payload.kind === 'condition') {
      setNodes(ns => [...ns, { id, type: 'conditionNode', position, data: { label: 'condition', type: 'condition' } } as any])
    } else {
      setNodes(ns => [...ns, { id, type: 'workerNode', position, data: { label: payload.worker, type: 'worker', worker: payload.worker, role: workerRoles[payload.worker!] } } as any])
    }
  }, [nodes, rf, workerRoles])
  const onDragOver = useCallback((e: React.DragEvent) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move' }, [])
```

Update `addWorker` so its node also carries `type: 'workerNode'` and `role`, matching the drop path (so click-add and drag-add produce identical nodes).

- [ ] **Step 4: Wire drop onto the canvas wrapper**

Put `onDrop={onDrop}` and `onDragOver={onDragOver}` on the `<div style={{ flex: 1, position: 'relative' }}>` that wraps `<ReactFlow>` (line ~72).

- [ ] **Step 5: Build to verify**

Run: `cd codey-mac && npx vite build`
Expected: build succeeds.

- [ ] **Step 6: Commit**

```bash
git add codey-mac/src/components/FlowEditor.tsx
git commit -m "feat(codey-mac): drag workers and condition nodes onto the flow canvas"
```

---

## Task 10: Wire worker roles from `GlobalTeamsSection` into `FlowEditor`

**Files:**
- Modify: `codey-mac/src/components/GlobalTeamsSection.tsx:234-239`

- [ ] **Step 1: Build a `name → role` map and pass it as a prop**

In `GlobalTeamsSection.tsx`, where `<FlowEditor ... />` is rendered (line ~234), add a `workerRoles` prop derived from the existing `workers` state:

```tsx
<FlowEditor
  teamName={editingFlow}
  workerNames={teams[editingFlow].members}
  workerRoles={Object.fromEntries(workers.map(w => [w.name, w.personality.role]))}
  graph={teams[editingFlow].graph ?? emptyGraph()}
  onSave={(graph) => { queueSave({ ...teams, [editingFlow]: { ...teams[editingFlow], graph } }) }}
  onClose={() => setEditingFlow(null)}
/>
```

(Confirm the exact existing prop lines while editing; keep `onSave`/`onClose` exactly as they are.)

- [ ] **Step 2: Build to verify**

Run: `cd codey-mac && npx vite build`
Expected: build succeeds.

- [ ] **Step 3: Manual check (Mac app)**

Run the app (`cd codey-mac && npm run dev`), open a Sequential team's flow editor, and verify: worker palette cards show the role line; dragging a worker drops it at the cursor; the "◇ + Condition" control drops a diamond; wiring `worker → diamond → {conditioned, default}` shows animated, colored edges; Save → reopen → toggle "Raw config" shows the `condition` node and `sourceHandle`/`targetHandle` on edges.

- [ ] **Step 4: Commit**

```bash
git add codey-mac/src/components/GlobalTeamsSection.tsx
git commit -m "feat(codey-mac): pass worker roles into the flow editor"
```

---

## Final verification

- [ ] **Core tests:** `cd packages/core && npx vitest run` → PASS
- [ ] **Editor model tests:** `cd codey-mac && npx vitest run src/components/flowEditorModel.test.ts` → PASS
- [ ] **Builds:** `npm run build:core && npm run build:gateway` and `cd codey-mac && npx vite build` → all succeed
- [ ] **Lint:** `npm run lint` (non-English character check) → PASS
- [ ] **Manual:** the Task 10 Step 3 checklist passes end-to-end in the Mac app.

---

## Self-review notes (resolved)

- **Spec coverage:** #1 handles → Tasks 4, 7, 8; #2 diamond → Tasks 1–3 (model), 6 (runtime), 7/9 (editor); #3 animation/colors → Tasks 5, 8; #4 drag → Task 9; #5 card+role → Tasks 7, 9, 10. All five covered.
- **Type consistency:** `condition` node type, `sourceHandle`/`targetHandle` edge fields, `workerRoles` prop, and `branchColors` signature are defined once (Tasks 1, 4, 5, 7) and reused consistently downstream.
- **Gateway no-test caveat:** Task 6 relies on Task 2/3 core tests for the settle/advance/validate guarantees plus a build + manual smoke, since the gateway has no unit runner.
