# Decision diamonds, worker self-loops, and the node inspector

**Date:** 2026-06-16
**Branch:** `flow-canvas-decision-nodes`
**Status:** Design — approved, ready for plan

## Background

The Flow canvas (Mac app `codey-mac` `FlowEditor.tsx`, core `packages/core/src/team-graph.ts` + `judge.ts`) already supports a `condition` (diamond) node type, multi-handle edges, animated/colored branch edges, drag-to-canvas, and worker cards with a role line. In that first cut, **conditions lived on edges**: a diamond was a judge-evaluated branch point and each *outgoing edge* carried a natural-language condition, with one edge marked `isDefault`.

User feedback after using it:

1. Tapping a diamond does nothing — there is no way to type the condition into it. Conditions should live **on the diamond**, with the edges representing the **yes/no** outcomes.
2. A worker's description is only a truncated line on the card; there is no way to read the whole thing.
3. Worker cards are fixed-size and too large relative to the start/end terminals; they should be resizable.
4. (New capability) A worker should be able to **loop on itself to self-improve**, with a **maximum number of calls** before it is forced to pass to the next node.

This spec revises the decision model to match canonical flowchart conventions (a decision diamond *holds* the condition and emits labeled outcome edges), adds bounded worker self-loops, and adds a node inspector + resizable worker cards.

## Goals

- Diamonds carry the condition (a yes/no question); each diamond has **exactly two** outgoing edges — one `yes`, one `no`.
- Worker nodes keep their existing multi-edge conditional branching + `isDefault` fallback (back-compatible — "diamonds only" for the new binary model).
- A worker node may have a **self-loop** edge (`from === to`) with a **per-worker call cap** (`maxCalls`) that forces an exit once reached, independent of the global `maxHops`.
- A node inspector: tap a worker to see its full description and (when it self-loops) edit `maxCalls`; tap a diamond to edit its question and flip which edge is yes/no.
- Worker cards are resizable; start/end terminals stay fixed-size.

## Non-goals

- Multiway (>2 exit) decisions. Binary yes/no only; nest diamonds for multiway. (Deliberate house-style simplification.)
- Forbidding worker branching (strict-flowchart "process boxes have one exit" form). Rejected in favor of back-compat.
- Any change to `auto` / `parallel` dispatch modes.
- Changing the `[ASK_USER]` pause/resume path.

## Flowchart-convention alignment

The revised model maps to ANSI/ISO 5807 flowchart symbols: **decision = diamond holding the condition with labeled yes/no exits** (exhaustive + mutually exclusive, so a decision can never dead-end), **process = worker rectangle**, **terminator = start/end pills**, **directed labeled flow lines**. The one intentional deviation from strict form is that worker (process) nodes may still branch; this is kept for flexibility and back-compatibility.

## Design

### A. Data model — `packages/core/src/team-graph.ts`

`TeamGraphNode` gains two optional fields:

```ts
export interface TeamGraphNode {
  id: string;
  type: TeamGraphNodeType;            // 'start' | 'worker' | 'condition' | 'end'
  worker?: string;                    // required when type === 'worker'
  /** Decision question the judge evaluates; used when type === 'condition'. */
  condition?: string;
  /** Max consecutive runs of this worker (with a self-edge) before a forced exit. */
  maxCalls?: number;
  x: number;
  y: number;
  /** Presentation-only: editor card size. Ignored by the runtime. */
  width?: number;
  height?: number;
}
```

`TeamGraphEdge` gains one optional field:

```ts
export interface TeamGraphEdge {
  id: string;
  from: string;
  to: string;
  condition?: string;                 // worker-edge condition (unchanged)
  isDefault?: boolean;                // worker-edge fallback (unchanged)
  /** Outcome of a diamond's decision. Only set on edges leaving a 'condition' node. */
  branch?: 'yes' | 'no';
  sourceHandle?: string;              // presentation-only (unchanged)
  targetHandle?: string;              // presentation-only (unchanged)
}
```

- `condition` (node) is the diamond's question, e.g. *"Did the tests pass?"*
- `branch` distinguishes the two diamond exits. A self-loop is just an ordinary worker edge where `from === to`; it carries a normal `condition` (the "keep looping" criterion), not a `branch`.
- `width`/`height` are presentation-only and ignored by the runtime, like `sourceHandle`/`targetHandle`.

This is additive — existing graphs (worker conditions on edges, diamonds with edge conditions + default) keep validating until re-authored; see migration note below.

### B. Validation — `validateGraph`

Replace the current `condition`-node rule ("needs a default outgoing edge") with:

For each `condition` node:
- must **not** reference a worker (unchanged),
- must have a non-empty `condition` (the question) → else `condition node "<id>" needs a question`,
- must have **exactly two** outgoing edges, one `branch: 'yes'` and one `branch: 'no'` → else `condition node "<id>" needs exactly one yes and one no outgoing edge`.

For each `worker` node:
- existing checks unchanged (has a worker, worker is known, has ≥1 outgoing edge),
- if it has a self-edge (`from === to`), it must also have **≥1 non-self outgoing edge** → else `worker node "<id>" self-loops with no exit edge`,
- if `maxCalls` is set, it must be an integer `≥ 1` → else `worker node "<id>" maxCalls must be >= 1`.

Reachability and edge-endpoint checks are unchanged. As today, any problem makes the gateway fall back to plain linear Sequential.

### C. Runtime — `GraphRunState`, `settle`/`advance`, gateway loop, `judge.ts`

**Per-worker consecutive-run count.** `GraphRunState` gains:

```ts
export interface GraphRunState {
  currentNodeId: string;
  hops: number;
  status: GraphRunStatus;
  visited: string[];
  /** Consecutive runs of currentNodeId; resets when the flow settles onto a different node. */
  runStreak: number;
}
```

- `startRun` initializes `runStreak: 0`.
- `settle()` is unchanged except it sets `runStreak` to `0` when the settled node id differs from the previous `currentNodeId`, and otherwise carries it forward. (settle already stops at `condition` nodes without recording history — unchanged.)
- The gateway loop increments `runStreak` each time it actually runs the current worker.

**Eligible edges (the cap).** New helper:

```ts
export function eligibleEdges(graph: TeamGraph, state: GraphRunState, nodeId: string): TeamGraphEdge[]
```

Returns `outgoingEdges(graph, nodeId)`, but **drops the self-edge** (`e.to === nodeId`) when the node has a `maxCalls` and `state.runStreak >= maxCalls`. The gateway passes `eligibleEdges(...)` (not raw `outgoingEdges`) to the judge, so once the cap is hit the judge can only choose an exit edge. Global `maxHops` remains the outer backstop via `advance`.

**Diamond decisions in the judge.** `JudgeInput` gains optional `question?: string`. `buildJudgePrompt` renders it as a `## Decision` section when present, and frames the edges as outcomes. The gateway loop:

- **worker node:** run worker, ingest output, `[ASK_USER]` check, then `runJudge` over `eligibleEdges` (edges carry `condition`/`isDefault` as today).
- **condition node:** no worker run; call `runJudge` with `question = node.condition`, `workerOutput = lastWorkerOutput` (already threaded), and the two edges presented as `yes` / `no`. The judge returns the chosen edge id.

`resolveEdge` gains a diamond-aware fallback: for a `condition` node, when the judge's choice is absent/invalid, fall back to the **`no`** edge (conservative — don't loop/advance on an unreadable decision). For worker nodes, the existing `isDefault` fallback is unchanged.

### D. Editor — `codey-mac/src/components/FlowEditor.tsx`

**Node inspector (replaces the edge-only panel as the primary inspector).** Add `onNodeClick`; track `selNode`. The right panel becomes node-type-aware:

- **worker node:** shows the worker name and **full role/description** (not truncated). When the worker has a self-edge, shows a **"Max self-loops"** numeric input bound to `node.maxCalls` (empty = unbounded).
- **condition (diamond) node:** shows a **"Decision"** textarea bound to `node.condition` (the question), and a control to **flip** which outgoing edge is `yes` vs `no`.
- The existing **edge** panel (condition textarea + default checkbox) still opens on `onEdgeClick` for **worker** edges. Edges leaving a diamond are not freely edited there; they show a read-only `yes`/`no` label.

**Diamond edges auto-assigned.** When an edge is connected out of a diamond: the first becomes `branch: 'yes'`, the second `branch: 'no'`; connecting a third is rejected (validation will already flag >2). Edge labels render `yes` (green) / `no` (red); `branchColors` is extended so a diamond's yes edge is green and no edge is red, while worker branch edges keep their existing per-edge palette.

**Self-loop rendering.** Connecting a worker's source handle to one of its *own* target handles creates the self-edge (`from === to`); distinct source/target handles make React Flow draw a visible loop arc.

**Resizable worker cards.** Wrap `WorkerNodeView` with React Flow's `NodeResizer` (visible on selection). Persist the resulting size into the node's `width`/`height` via `onNodesChange`. `ConditionNodeView` and `TerminalNodeView` are **not** resizable.

### E. Editor model — `codey-mac/src/components/flowEditorModel.ts`

- `toFlow` / `fromFlow` round-trip the new fields: node `condition`, `maxCalls`, `width`, `height`; edge `branch`. `width`/`height` map to the React Flow node's `style.width`/`height` (or `node.width/height`).
- `branchColors` extended: for a `condition` source node, color its `yes` edge green and `no` edge red; worker-source branch edges unchanged.

### F. Wiring — `codey-mac/src/components/GlobalTeamsSection.tsx`

No new props. `workerRoles` (added previously) already supplies the description text the inspector shows in full.

## Migration / back-compat

- New fields are all optional; the runtime ignores `width`/`height`. Existing `gateway.json` graphs continue to validate and run **until a diamond is re-opened in the editor**.
- A pre-existing diamond authored under the old model (conditions on edges + `isDefault`, no node `condition`) will now fail the stricter `validateGraph` and fall back to linear Sequential — the same safe fallback already in place. Re-authoring the diamond in the editor (type a question, mark yes/no) upgrades it. This is acceptable because the diamond feature shipped this same session and is not yet relied upon in saved configs.

## Testing

Core (`packages/core`, vitest):
- `validateGraph`: diamond needs a question; diamond needs exactly one yes + one no; worker self-edge needs an exit; `maxCalls >= 1`.
- `settle`/`startRun`: `runStreak` resets on node change, carries within the same node.
- `eligibleEdges`: drops the self-edge at/after `maxCalls`; keeps it below; ignores nodes without `maxCalls`.
- `resolveEdge`: diamond falls back to the `no` edge on null/invalid choice; worker fallback unchanged.
- `buildJudgePrompt`: renders the `## Decision` question and yes/no edges when `question` is set.

Editor model (`codey-mac`, vitest):
- `toFlow`/`fromFlow` round-trip `condition`, `maxCalls`, `width`/`height`, and edge `branch`.
- `branchColors`: diamond yes=green / no=red; worker branches unchanged.

Gateway (no unit runner): build + manual smoke; relies on the core tests for settle/eligible/validate/resolve guarantees.

Manual (Mac app): tap a diamond → type question, edges show yes/no with green/red; tap a worker → full description + (with a self-edge) max-self-loops field; draw a worker self-edge and confirm a bounded loop runs `maxCalls` times then exits; resize a worker card and confirm size persists across Save → reopen → Raw config (shows `condition`, `maxCalls`, `branch`, `width`/`height`).

## Files touched

- `packages/core/src/team-graph.ts` — node/edge fields, `validateGraph` rules, `GraphRunState.runStreak`, `settle`, `eligibleEdges`, `resolveEdge` diamond fallback.
- `packages/core/src/judge.ts` — `JudgeInput.question`, `buildJudgePrompt` decision section.
- `src/gateway.ts` — loop branches on node type; uses `eligibleEdges`; increments `runStreak`; passes `question` for diamonds.
- `codey-mac/src/components/FlowEditor.tsx` — node inspector, diamond yes/no edges, self-loop, `NodeResizer`.
- `codey-mac/src/components/flowEditorModel.ts` — round-trip new fields; `branchColors` for diamonds.
