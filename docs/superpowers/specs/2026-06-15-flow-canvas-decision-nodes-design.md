# Flow Canvas Upgrades — Decision Nodes, Drag-to-Canvas, Animated Edges

**Date:** 2026-06-15
**Status:** Approved design
**Surface:** Sequential-mode flow graph editor (`codey-mac` `FlowEditor.tsx`) + flow-graph runtime (`packages/core`, `packages/gateway`)

## Summary

Five upgrades to the Sequential team flow canvas. One is a model/runtime change (a real
**decision node** rendered as a diamond); the other four are editor-only (multiple connection
handles, animated edges, drag-to-canvas, bigger worker cards with a description).

All changes are back-compatible: existing graphs in `gateway.json` (conditions placed directly
on worker outgoing edges) keep working unchanged. Diamonds are purely additive.

## Goals

1. Edges attach at distinct points on a node so parallel/loop-back edges don't overlap.
2. A real diamond **decision node** users can drop, where the judge picks a branch.
3. Always-on animated edges (a moving dot) that visualize flow direction; branch edges get
   distinct colors, the `default` (else) edge styled neutrally.
4. Drag workers from the palette onto the canvas, placed where dropped.
5. Bigger worker cards showing a one-line description sourced from `personality.role`.

## Non-Goals

- No run-simulation / playback engine. The animated dot is decorative styling only.
- No change to the judge prompt or judge decision contract.
- No change to `auto` / `parallel` dispatch modes.

---

## A. Decision (diamond) node — model + runtime

### Model

`TeamGraphNodeType` (`packages/core/src/team-graph.ts`) gains a third interactive type:

```ts
export type TeamGraphNodeType = 'start' | 'worker' | 'condition' | 'end';
```

- A `condition` node carries **no** `worker`.
- Branching happens on its **outgoing edges**, each with a natural-language `condition`; exactly
  one outgoing edge is `isDefault` (the else branch).

`TeamGraphEdge` gains two optional, presentation-only fields (ignored by the runtime/judge):

```ts
sourceHandle?: string;
targetHandle?: string;
```

### Semantics

A diamond is a **branch point with no worker**. Flow reaches it (e.g. `worker → diamond`), and the
**judge evaluates the diamond's outgoing edges** using the *last worker's output* + blackboard —
exactly the mechanism used today for a worker's outgoing edges. The judge (`judge.ts`) needs **no
change**: it already operates on a generic edge list (`buildJudgeEdges` / `runJudge`).

### Runtime changes

**`packages/core/src/team-graph.ts`:**
- `settle()` walks through `start` nodes (as today) and **stops at `condition` nodes**. It does
  **not** push `condition` nodes to `state.visited` (which remains worker-only history).
- `advance()` is unchanged structurally (still increments hops, enforces `maxHops`, calls
  `settle`), but because `settle` now stops at condition nodes, the loop regains control at a
  diamond.

**`packages/gateway/src/gateway.ts` run loop** (`continueGraphRun` and the sink variant
`runSequentialGraphForChatSink`): branch on the settled node's type.
- The loop threads a `lastWorkerOutput` string across iterations (seeded empty).
- **worker node:** run worker, ingest, `[ASK_USER]` check (unchanged), set
  `lastWorkerOutput = ingested.stripped`, then `pickNextGraphEdge` (judge over this node's edges),
  `resolveEdge`, `advance`.
- **condition node:** no worker run. Call `pickNextGraphEdge` with `workerName` = the last worker
  that ran (for prompt context) and `workerOutput = lastWorkerOutput`, then `resolveEdge`,
  `advance`. Emit a status line for the chosen branch (reuse the existing `↪️ reason` emit).
- `pickNextGraphEdge` / `buildJudgeEdges` are unchanged — they already operate on
  `outgoingEdges(graph, nodeId)` for any node id.

### Validation (`validateGraph`)

For a `condition` node:
- must carry **no** `worker` (error if present),
- must have **≥1 incoming** edge and **≥1 outgoing** edge,
- **must have a `default` outgoing edge** (so it can never get stuck on an unmatched branch),
- existing reachability + "outgoing edge required" checks extend to it (treat `condition` like
  `worker`/`start` for the "has outgoing edge" rule).

An invalid graph falls back to plain linear Sequential via the existing `validateGraph` gate in
`gateway.ts` (`fallbackTeam.graph` only set when `problems.length === 0`).

### Pause / resume

`[ASK_USER]` pauses happen only at **worker** nodes (diamonds run no worker), so the existing
`PendingTeamState.graphState` (`currentNodeId`, `hops`, `visited`) is sufficient. On resume the
re-issued worker produces fresh output, which becomes `lastWorkerOutput` for the subsequent judge
step. No new persisted fields are required.

---

## B. Editor changes (`codey-mac`, frontend-only)

### B1. Custom React Flow node components

Introduce custom node types (needed for B2/B5/diamond rendering):
- `workerNode` — card with name + one-line description (B5).
- `conditionNode` — diamond shape.
- `terminalNode` — `start` / `end` pill.

Registered via React Flow `nodeTypes`. `flowEditorModel.ts` `toFlow`/`fromFlow` map
`condition` nodes through unchanged (they already pass `type` and have no `worker`).

### B2. Multiple connection handles (#1)

Each node renders **multiple source/target handles** (left/right/top/bottom). New edges record the
handle they connect from/to; these persist as `sourceHandle`/`targetHandle` on `TeamGraphEdge`
(presentation-only). `onConnect` captures `c.sourceHandle` / `c.targetHandle` and stores them in
edge data → `fromFlow` writes them onto the `TeamGraphEdge`. Result: parallel edges and loop-backs
attach at distinct points instead of overlapping.

### B3. Animated edges (#3)

- All edges set `animated: true` (React Flow's built-in moving dash → moving-dot effect).
- **Branch coloring:** for any node with >1 outgoing edge (a worker-with-branches or a diamond),
  assign each non-default outgoing edge a distinct color from a small fixed palette (by index);
  the `default` edge renders neutral gray. Colors are computed at render time from the current
  `edges`/`nodes` (no persistence). Edge label keeps showing the condition text / `default`.

### B4. Drag workers onto canvas (#4)

- Palette worker items + the "+ Condition" button become `draggable` (`onDragStart` sets a
  `dataTransfer` payload identifying the node kind + worker name).
- The React Flow pane (wrapped in `ReactFlowProvider`) handles `onDragOver`/`onDrop`; `onDrop` uses
  `useReactFlow().screenToFlowPosition` to place the node at the cursor.
- Click-to-add is kept as a fallback (drops at a default offset, current behavior).

### B5. Bigger worker card + description (#5)

- Palette and on-canvas `workerNode` cards are enlarged.
- Each shows the worker name + a one-line description from `WorkerDto.personality.role`
  (truncated). `role` is already loaded via `apiService.listWorkers()` / passed into the editor;
  pass a `workers: WorkerDto[]` (or a `name → role` map) into `FlowEditor` so cards can look up the
  role. (Today `FlowEditor` only receives `workerNames: string[]`; extend it to also receive the
  role lookup, sourced from `GlobalTeamsSection`'s existing `workers` state.)
- Add a **"+ Condition"** palette control to drop a diamond node.

---

## Data-model summary

| Type | Change |
|------|--------|
| `TeamGraphNodeType` | add `'condition'` |
| `TeamGraphNode` | no shape change (`condition` uses existing optional `worker` left unset) |
| `TeamGraphEdge` | add optional `sourceHandle?`, `targetHandle?` (presentation-only) |
| `gateway.json` graphs | remain valid; new fields optional |

## Files touched

- `packages/core/src/team-graph.ts` — node type, `settle`, `validateGraph`, edge fields.
- `packages/core/src/team-graph.test.ts` — coverage for condition settle/validate.
- `packages/gateway/src/gateway.ts` — `continueGraphRun` + `runSequentialGraphForChatSink` node-type
  branching, `lastWorkerOutput` threading.
- `codey-mac/src/components/FlowEditor.tsx` — custom nodes, handles, animation, drag-drop, palette.
- `codey-mac/src/components/flowEditorModel.ts` — handle fields, condition node mapping; helpers.
- `codey-mac/src/components/flowEditorModel.test.ts` — round-trip coverage incl. condition + handles.
- `codey-mac/src/components/GlobalTeamsSection.tsx` — pass worker role lookup into `FlowEditor`.

## Testing

- **Core unit tests:** `settle` stops at a condition node without recording it in `visited`;
  `advance` through `worker → condition → worker`; `validateGraph` flags a condition node missing a
  default edge / carrying a worker / lacking in/out edges; existing linear-fallback still triggers
  on invalid graphs.
- **Editor unit tests (`flowEditorModel.test.ts`):** `toFlow`/`fromFlow` round-trip a graph
  containing a condition node and edges with `sourceHandle`/`targetHandle`.
- **Manual (Mac app):** drop a worker via drag; drop a diamond; wire `worker → diamond → {A,B}`
  with conditions + a default; confirm animated edges + branch colors; Save → reopen → Raw config
  shows the `condition` node and handle fields.

## Risks

- Run-loop refactor in `gateway.ts` is the highest-risk change (two variants must stay in sync).
  Mitigate by threading `lastWorkerOutput` in one shared spot and covering `worker→condition→worker`
  in core tests before wiring the gateway.
- React Flow custom nodes + multiple handles require correct handle `id`s for edge persistence;
  cover with the model round-trip test.
