# Team Run Flow View — Design

**Date:** 2026-06-18
**Status:** Approved (brainstorm), pending implementation plan
**Surface:** `codey-mac` (Mac app)

## Problem

When a `/team` run executes, the right-side context panel ("TOOLS" tab) shows a single **flat** list of tool calls and step-narration `info` lines for the whole team. There's no way to see the team as a *flow* or to focus on one worker's activity — every worker's Reads, Edits, and Bash calls are interleaved into one scroll. For multi-worker runs (the screenshot shows product-manager → architect → developer → code-reviewer) this is hard to follow.

The user wants, **for team mode**, a dedicated **flow view** (a graph of workers) where clicking a worker reveals *that worker's* tool calls — not the flat list.

## Goals

- In team mode, offer a graph view of the run: each worker is a node, wired in the team's flow.
- Clicking a worker node shows that worker's tool calls, status, duration, and thinking — isolated from other workers.
- The graph is **live**: nodes reflect run state (done / running / pending / failed / asked-user) and update as the run progresses, including when opened mid-run.
- The graph's visual style **matches the FlowEditor canvas** (same node renderers, theme tokens, dark/light behavior). This is an explicit requirement.

## Non-goals

- Editing the flow from this view (it is read-only; authoring stays in FlowEditor).
- Changing how teams execute or how tool calls are streamed/persisted.
- Replacing the existing flat `ToolTimeline` / `TeamFlow` step list in the panel — the overlay is additive, opened on demand.
- Perfect tool-call attribution for **parallel** teams in this iteration (see Known Limitations).

## Chosen approach (option B from brainstorm)

A **full-screen overlay** (modeled on FlowEditor's modal chrome) launched from the TOOLS tab via a "View flow ⤢" button, visible only when the selected chat is a team and the current turn is a team run.

- **Left:** a read-only, live React-Flow graph reusing FlowEditor's node/edge renderers.
- **Right:** a worker drawer. Selecting a node fills it with that worker's tool calls (rendered with the existing `toolFormat` helpers), status, duration, and collapsed thinking.
- The currently-running worker is auto-selected when the overlay opens.

Rejected: A (vertical accordion in the narrow panel — too cramped for branching graphs) and C (mini-graph + expand — extra surface for little gain once B exists).

## Architecture

Three pieces: a **shared graph renderer** (extracted from FlowEditor), a **pure run-model deriver** (new, tested), and the **overlay component** that composes them.

### 1. Shared graph renderer — `codey-mac/src/components/flowGraph.tsx` (new)

Extract from `FlowEditor.tsx`, with **no behavior change to FlowEditor**:

- `WorkerNodeView`, `ConditionNodeView`, `TerminalNodeView`, `nodeTypes`, `edgeTypes`
- the `resolveColor()` CSS-var→hex helper and edge-marker styling
- `toFlow(graph)` graph→React-Flow conversion

FlowEditor imports these instead of defining them inline. The node views gain an optional `data.status?: NodeRunStatus` that, when present, drives status styling (border/glow/icon). When absent (authoring mode), nodes render exactly as today. This is what guarantees the run view "matches the canvas style" — it *is* the same renderer.

`NodeRunStatus = 'pending' | 'running' | 'done' | 'failed' | 'askedUser'`, mapped to tokens: done→`C.green`, running→`C.accent` (with glow), pending→dim + dashed `C.border2`, failed→`C.dangerFg`, askedUser→`C.blue`/info tone.

### 2. Run-model deriver — `codey-mac/src/components/teamRunModel.ts` (new, pure, unit-tested)

Pure functions, no React, mirroring `flowEditorModel.ts` / `teamMessageFormat.ts`:

```ts
interface WorkerRun {
  step: number;
  worker: string;
  status: NodeRunStatus;
  toolCalls: ToolCallEntry[];   // this worker's slice of the flat stream
  thinking?: string;            // from turn.thinkingByStep[step]
  output?: string;              // from parseTeamMessage step output
}

function deriveWorkerRuns(turn: ChatMessage, isStreaming: boolean): WorkerRun[]
function synthesizeChainGraph(runs: WorkerRun[]): TeamGraph
function applyRunStatus(graph: TeamGraph, runs: WorkerRun[], pending?: PendingTeamState): TeamGraph  // returns graph whose node.data.status is set
```

**Attribution (the core trick):** the flat `turn.toolCalls` stream is already delimited by `info` entries whose message starts with `"Step N:"` (the same markers `TeamFlow` parses today). Walk the stream in order; each `info` "Step N:" marker opens a new slice; subsequent `tool_start`/`tool_end` entries belong to the worker at that step (worker name from `parseTeamMessage(turn.content).steps`). Pair each step with `turn.thinkingByStep[step]`. No core/gateway/data-model change is required — attribution is derived client-side from data the app already receives.

**Status derivation:**
- `done` — step completed (a later step's marker exists, or the turn is complete).
- `running` — the last step while `isStreaming`.
- `failed` — the step's output/tool slice contains an error (e.g. a `tool_end` error or the existing "❌ Failed" output marker).
- `askedUser` — matches `chat.pendingTeam.askingWorker`.
- `pending` — a graph worker node never reached by any step.
- A worker visited multiple times (loop/revision) maps to one node showing the **latest** run's status and a run-count badge; the drawer lists each visit.

### 3. Overlay — `codey-mac/src/components/TeamRunFlow.tsx` (new)

Props: `{ turn, isStreaming, teamGraph?, pendingTeam?, onClose }`.

- Resolves the graph: if the chat's team has an **authored** `TeamGraph` (the `graph` field already parsed in `GlobalTeamsSection`/`TeamsSection` and passed down), use it directly so real branches/loops render. Otherwise (auto/parallel/no graph) call `synthesizeChainGraph(runs)` to build a linear `start → w1 → … → wN → end` chain. Either way the same renderer draws it.
- Runs `applyRunStatus` to light up nodes; re-derives on each render so it updates live.
- Left pane: `<ReactFlow ... nodeTypes edgeTypes colorMode={effectiveTheme} fitView>` — identical config to FlowEditor (read-only: no `onConnect`/drag-to-edit handlers; `onNodeClick` selects).
- Right drawer: selected worker's `WorkerRun` rendered with `ToolDetail`/`normalizeTool` from `toolFormat.tsx` (consistent with the flat timeline), status + duration header, collapsed thinking section. Auto-selects the `running` worker (else the last) on open.
- Chrome mirrors FlowEditor's modal (fixed overlay, `C.bg` panel, `Close` using the existing `secondaryBtn` style).

### 4. Panel integration — `ChatContextPanel.tsx`

In the `tab === 'current'` branch, when `teamName` is set and a team `turn` exists, render a **"View flow ⤢"** button (in the existing `TeamFlow` Section header). Clicking opens `TeamRunFlow`. The flat `ToolTimeline`/`TeamFlow`/`FilesTouched` stay as-is for users who prefer the list.

## Data flow

```
gateway team run ──stream──> useChats reducer ──> ChatMessage{ content, toolCalls[], thinkingByStep }
                                                          │
                              parseTeamMessage(content) ──┤── steps[] (step→worker, output)
                              deriveWorkerRuns(turn) ─────┴── WorkerRun[] (slice toolCalls by "Step N:" info markers)
                                                          │
        team config.graph (authored) ─or─ synthesizeChainGraph(runs) ──> applyRunStatus ──> live graph
                                                          │
                                          TeamRunFlow: React-Flow (left) + worker drawer (right)
```

No new wire events, no changes to `packages/core` or `packages/gateway`.

## Testing

`codey-mac/src/components/teamRunModel.test.ts` (Vitest), covering:
- Partition a flat `toolCalls` stream with `Step 1:`/`Step 2:` markers into correct per-worker slices.
- Status derivation: running (streaming last step), done, failed (error slice), askedUser (matches `pendingTeam`), pending (unreached graph node).
- Loop/revisit: same worker at steps 2 and 4 → one node, latest status, both visits in the drawer data.
- `synthesizeChainGraph`: N runs → `start → w1 → … → wN → end` with valid edges (passes `validateGraph`).
- Edge cases: no `info` markers (single implicit step), empty `toolCalls`, non-team turn → `deriveWorkerRuns` returns `[]`.

Renderer extraction is covered by the existing app build + a manual visual pass in all four palettes (no snapshot infra today).

## Known limitations

- **Parallel teams:** sequential `Step N:` markers can't perfectly attribute interleaved concurrent tool calls. MVP attributes best-effort by marker order; nodes and per-worker thinking still render correctly. A robust fix is to tag tool events with an optional `step` at emit time (`ToolCallEntry.step?`, set in the gateway's `TeamEmitter`, which already threads `step` through `onThinking`) — deferred as a follow-up, not required for the sequential/auto case in the screenshot.
- Duration per worker is shown only when derivable from existing data; no new timing instrumentation is added.

## Files

| File | Change |
|---|---|
| `codey-mac/src/components/flowGraph.tsx` | **new** — node/edge renderers + helpers extracted from FlowEditor; `status`-aware node styling |
| `codey-mac/src/components/FlowEditor.tsx` | import renderers from `flowGraph`; no behavior change |
| `codey-mac/src/components/teamRunModel.ts` | **new** — pure run-model deriver |
| `codey-mac/src/components/teamRunModel.test.ts` | **new** — unit tests |
| `codey-mac/src/components/TeamRunFlow.tsx` | **new** — overlay (graph + worker drawer) |
| `codey-mac/src/components/ChatContextPanel.tsx` | "View flow ⤢" trigger in team mode; mount overlay |
