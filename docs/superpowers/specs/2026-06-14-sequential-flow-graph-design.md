# Sequential Flow Graph — Design

**Date:** 2026-06-14
**Status:** Approved (brainstorming complete, ready for implementation plan)

## Summary

Upgrade the Team **Sequential** dispatch mode from a fixed linear chain into a
user-authored **flow graph** (state machine): worker nodes connected by edges,
where a judge LLM evaluates a natural-language condition on each outgoing edge to
decide the next worker — including loop-back edges that send work back to an
earlier worker for revision. The graph is authored in a drag-and-drop canvas in
the Mac app and persisted to `gateway.json`.

The `auto` and `parallel` dispatch modes are **unchanged**. Only Sequential is
affected.

## Goals

- A Sequential team can define an explicit routing graph: each worker chooses (via
  a judge) which worker runs next.
- Support conditional branching and **loops** — a worker can route work back to a
  previous worker when it judges the previous step was not done well.
- Author the graph visually (drag nodes, draw edges) — no manual "next step"
  typing.
- Persist the graph to the config file; expose a dedicated page in the Mac app
  that both edits the graph and shows the raw config.
- Strict, repeatable execution: every run follows the authored graph and its
  conditions/verdicts.

## Non-Goals

- No changes to `auto` or `parallel` dispatch.
- No per-edge revisit limits in v1 (global hop cap only).
- No duplicate worker nodes in v1 (one node per worker; see constraint below).
- No new judge configuration knob (reuse the existing Advisor config).

## Backward Compatibility

Sequential mode keeps working exactly as today when a team has **no graph**:
members run once in declared order, output carried forward
(`runAllMembersInOrder`). The graph is an **optional** addition to a Sequential
team. The chip-based editor remains the default/simple view.

## Data Model

The graph extends the normalized `TeamConfig` (and its raw form) in
`packages/core/src/workspace.ts`. It is stored in the global team library in
`gateway.json`.

```ts
interface TeamGraph {
  entry: string;            // node id of the start node
  maxHops: number;          // global safety cap on total worker-runs (default 20)
  nodes: TeamGraphNode[];
  edges: TeamGraphEdge[];
}

interface TeamGraphNode {
  id: string;
  type: 'start' | 'worker' | 'end';
  worker?: string;          // worker name; required when type === 'worker'
  x: number;                // canvas position
  y: number;
}

interface TeamGraphEdge {
  id: string;
  from: string;             // node id
  to: string;               // node id
  condition?: string;       // natural-language condition, e.g. "tests pass"
  isDefault?: boolean;      // fallback edge taken when no condition matches
}

interface TeamConfig {
  members: string[];
  dispatch: TeamDispatchMode;
  parallel?: ParallelSettings;
  graph?: TeamGraph;        // NEW — only meaningful when dispatch === 'all' (Sequential)
}
```

Raw/normalize handling (`TeamConfigRaw` → `TeamConfig`) validates the graph on
load: a malformed or invalid graph is dropped (with a logged warning) and the
team falls back to linear Sequential behavior, never crashing the gateway.

### v1 Constraint: one node per worker

Each worker appears as **at most one** `worker` node. Reuse of a worker at
multiple points in the flow (e.g. a reviewer gate reached after both the coder
and the tester) is modeled by **multiple edges converging** on the single
reviewer node — not by duplicate nodes. This keeps node identity equal to worker
identity, which keeps the blackboard and warm-session resume logic simple. The
constraint can be lifted later if a real need appears.

## Execution Engine

New module `packages/core/src/team-graph.ts`:

- Graph types (above).
- `validateGraph(graph, workerNames)` → list of problems (unreachable nodes,
  worker node with no outgoing edge, missing/invalid entry, edge endpoints that
  don't exist, worker node referencing an unknown worker, `worker` node missing a
  `worker`). Used by both the editor (surface to user) and the engine (refuse to
  run an invalid graph and report why).
- A step state machine that, given the current node and the engine's
  worker-runner + judge callbacks, drives one hop at a time so the gateway can
  interleave streaming, `[ASK_USER]` pauses, and persistence.

The gateway runs the graph in place of `runAllMembersInOrder` when a Sequential
team has a valid `graph`, mirroring how `runAdvisorLoop` is wired for `auto`:

1. Begin at `entry`; advance to its first `worker` node.
2. Run the worker. This reuses the **existing** worker-run path: memory bootstrap,
   blackboard markers, and the `[ASK_USER]` / `[ASK_USER:choice]` pause/resume
   flow (`persistPendingTeam`). Workers can still pause mid-flow for user input;
   on resume the engine re-enters at the same node.
3. **Judge step:** the judge LLM is given the just-finished worker's output (plus
   the blackboard summary) and the current node's outgoing edges as
   `{ id, condition, targetWorker }`. It returns the chosen edge id and a one-line
   reason. If no conditioned edge matches, the `isDefault` edge is taken. If there
   is no default and nothing matches, the node is treated as a terminal stop with
   a warning.
4. **Loop-back** is not a special case: it is simply an edge from the current node
   back to an earlier node carrying a condition like *"previous step's work is
   incomplete"*.
5. Reaching an `end` node finishes the run and reports results. Hitting `maxHops`
   is a hard stop that reports the partial result and notes the cap was reached.

### Judge identity

Reuse the existing Advisor configuration: `gateway.json` `advisor.{agent, model}`
falling back to the gateway default — the same LLM that already powers `auto` and
`parallel` routing. No new config field. The judge is a coordination-only role
(it never writes code), consistent with the existing Advisor contract.

### User feedback during a run

Reuse the existing Sequential/auto progress messaging: emit a step line as each
worker starts (worker name + the judge's one-line reason for routing there), and
a final results block with the blackboard summary, matching current behavior.

## Mac App — Flow Editor

In the Teams tab (`GlobalTeamsSection.tsx`), each Sequential team keeps its chip
row and gains an **"Edit flow ↗"** button that opens a full-canvas editor.

- Library: React Flow (`@xyflow/react`) — the standard node-graph lib, not yet a
  dependency; to be added to `codey-mac`.
- Canvas: drag worker nodes from a palette; one fixed **Start** node and one or
  more **End** nodes. Draw edges by dragging between node handles.
- Edge inspector: click an edge to set its natural-language condition or mark it
  the default (`isDefault`) edge.
- Toolbar: set `maxHops`.
- **Raw config toggle:** show the underlying JSON for the team (satisfies the
  "page that displays the config file content" requirement).
- Validation from `validateGraph` is surfaced inline (unreachable nodes, worker
  node with no outgoing edge, missing entry, etc.).
- Saves debounce back to `gateway.json` through the existing `setGlobalTeams`
  API, exactly like the chip editor — so chip edits and graph edits share one
  persistence path.

## Testing

- `team-graph.ts`: unit tests for `validateGraph` (each failure class) and the
  step state machine — linear walk, conditional branch, loop-back, `maxHops` cap,
  terminal stop with no matching edge.
- Normalize/denormalize round-trip tests for `TeamConfig.graph` in
  `workspace.ts`, including the legacy/invalid-graph-drops-to-linear path.
- Judge selection: a test with a stubbed judge confirming the chosen edge id is
  honored and the default-edge fallback fires when nothing matches.
- Mac app: a small view-logic test for graph↔config normalization (mirroring
  existing `teamMessageFormat`/`teamsChanged` test style); the React Flow canvas
  itself is exercised manually.

## Open Risks

- Judge cost/latency: one judge LLM call per hop. Bounded by `maxHops`. Acceptable
  for v1; revisit if runs feel slow.
- Authoring footguns (e.g. a graph with no path to an End node) are caught by
  `validateGraph` and surfaced before a run, but a user can still author a graph
  that loops until `maxHops`. The hop cap is the backstop.
