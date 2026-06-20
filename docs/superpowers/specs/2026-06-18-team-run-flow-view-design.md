# Team Run Flow View — Design

**Date:** 2026-06-18
**Status:** Approved (brainstorm), revised after code audit — Mac-only scope
**Surface:** `codey-mac` (Mac app) only

## Problem

When a `/team` run executes, the right-side context panel ("TOOLS" tab) shows a single **flat** list of step-narration `info` lines for the whole team. There's no way to see the team as a *flow* or to focus on one worker's contribution — every worker's output is interleaved into one scroll. For multi-worker runs (the screenshot shows product-manager → architect → developer → code-reviewer) this is hard to follow.

The user wants, **for team mode**, a dedicated **flow view** (a graph of workers) where clicking a worker reveals *that worker's* contribution — its output and reasoning.

### Code audit finding (scope decision)

Per-worker **tool calls** (Read/Edit/Bash) are not available to show: during a team run the chat surface uses `ChatEmitter` (`packages/gateway/src/team-emitter.ts`), which emits only `stream`, `thinking`, and `info` events — never `tool_start`/`tool_end`. The worker path `runWorkerStep` forwards an `onStatus` callback to the agent (`gateway.ts:164`), but the team dispatch loop passes none, so worker tool events are discarded. Surfacing them would require a gateway change.

**Decision (user, 2026-06-18):** keep this iteration **Mac-only**. The worker drawer shows each worker's **output and thinking**, which are already available client-side (`parseTeamMessage` step output + `ChatMessage.thinkingByStep`). Per-worker tool calls are a **deferred follow-up** that needs the gateway to forward step-tagged tool events.

## Goals

- In team mode, offer a graph view of the run: each worker is a node, wired in the team's flow.
- Clicking a worker node shows that worker's output and thinking — isolated from other workers.
- The graph is **live**: nodes reflect run state (done / running / failed / asked-user / pending) and update as the run progresses, including when opened mid-run.
- The graph's visual style **matches the FlowEditor canvas** (same node renderers, theme tokens, dark/light behavior). Explicit requirement.

## Non-goals

- Editing the flow from this view (read-only; authoring stays in FlowEditor).
- Per-worker tool calls (deferred — needs gateway forwarding, see Follow-up).
- Changing how teams execute or stream (no `packages/core` / `packages/gateway` changes).
- Replacing the existing flat `TeamFlow` step list — the overlay is additive, opened on demand.

## Chosen approach (option B from brainstorm)

A **full-screen overlay** (modeled on FlowEditor's modal chrome) launched from the TOOLS tab via a "View flow ⤢" button, visible only when the selected chat is a team and the current turn is a team run.

- **Left:** a read-only, live React-Flow graph reusing FlowEditor's node/edge renderers.
- **Right:** a worker drawer. Selecting a node fills it with that worker's output (rendered via the existing `Markdown` component) and collapsed thinking, plus a status + step header.
- The currently-running worker is auto-selected when the overlay opens.

Rejected: A (vertical accordion in the narrow panel — too cramped for branching graphs) and C (mini-graph + expand — extra surface for little gain once B exists).

## Architecture

Three pieces, all in `codey-mac`: a **shared graph renderer** (extracted from FlowEditor), a **pure run-model deriver** (new, tested), and the **overlay component** that composes them.

### 1. Shared graph renderer — `codey-mac/src/components/flowGraph.tsx` (new)

Extract from `FlowEditor.tsx`, with **no behavior change to FlowEditor**:

- `WorkerNodeView`, `ConditionNodeView`, `TerminalNodeView`, `nodeTypes`, `edgeTypes`
- `FlowEdgeView`, `EDGE_COLOR`, the `resolveColor()` CSS-var→hex helper, `NodeHandles`, `ring()`
- a `rfNodeType(t)` helper for the `data.type → 'workerNode'|'conditionNode'|'terminalNode'` mapping that currently lives inline at `FlowEditor.tsx:142-143`

FlowEditor imports these instead of defining them inline. The node views gain an optional `data.status?: NodeRunStatus` that, when present, drives status styling (border/glow/icon). When absent (authoring mode), nodes render exactly as today. This is what guarantees the run view "matches the canvas style" — it *is* the same renderer.

`NodeRunStatus = 'pending' | 'running' | 'done' | 'failed' | 'askedUser'`, mapped to tokens: done→`C.green`, running→`C.accent` (with glow), pending→dim + dashed `C.border2`, failed→`C.red`, askedUser→`C.accent` (info tone). The status type is defined in `teamRunModel.ts` (no React) and imported here to avoid a circular dependency.

### 2. Run-model deriver — `codey-mac/src/components/teamRunModel.ts` (new, pure, unit-tested)

Pure functions, no React, mirroring `flowEditorModel.ts` / `teamMessageFormat.ts`:

```ts
export type NodeRunStatus = 'pending' | 'running' | 'done' | 'failed' | 'askedUser'

export interface WorkerRun {
  step: number
  worker: string
  status: NodeRunStatus
  output: string            // from parseTeamMessage step output
  thinking?: string         // from turn.thinkingByStep[step]
}

function deriveWorkerRuns(turn: ChatMessage, isStreaming: boolean): WorkerRun[]
function synthesizeChainGraph(runs: WorkerRun[]): TeamGraph
function nodeStatuses(graph: TeamGraph, runs: WorkerRun[], askingWorker?: string): Record<string, NodeRunStatus>
```

**`deriveWorkerRuns`:** `parseTeamMessage(turn.content)` already yields `steps[] = {step, worker, output}`. Map each step to a `WorkerRun`, attaching `turn.thinkingByStep?.[step]`. Status: the last step is `running` while `isStreaming`; a step whose output matches a failure marker (`❌` / `Failed`) is `failed`; otherwise `done`. (`askedUser` is applied later by `nodeStatuses` from `pendingTeam.askingWorker`.) Returns `[]` when the turn isn't a parseable team message. Output and thinking are available incrementally — `turn.content` is built up in `### Step N:` form as the run streams — so the drawer populates live.

**`synthesizeChainGraph`:** unique workers in first-appearance order → `start → w1 → … → wN → end`, vertical layout (`x≈120`, `y` stepped). Must pass `validateGraph(graph, workerNames)`. Used when the team has no authored graph.

**`nodeStatuses`:** maps each graph node id → status. Worker nodes: `askedUser` if `askingWorker` matches, else the latest matching `WorkerRun.status`, else `pending` (never reached). `start` → `done`. `end` → `done` when runs exist and none is `running`, else `pending`. Condition nodes are omitted (neutral default styling). A worker visited multiple times (loop) shows its latest status; the drawer lists each visit.

### 3. Overlay — `codey-mac/src/components/TeamRunFlow.tsx` (new)

Props: `{ turn, isStreaming, teamGraph?, askingWorker?, onClose }`.

- Resolves the graph: if the chat's team has an **authored** `TeamGraph` (the `graph` field on the team config), use it so real branches/loops render. Otherwise call `synthesizeChainGraph(runs)`.
- Builds React-Flow nodes via `toFlow` (from `flowEditorModel`), sets each node's React-Flow `type` via `rfNodeType`, and injects `data.status` from `nodeStatuses`. Re-derives on each render so it updates live.
- Left pane: `<ReactFlow ... nodeTypes edgeTypes colorMode={effectiveTheme} fitView>` — same config as FlowEditor, read-only (no `onConnect`/drag-edit; `onNodeClick` selects).
- Right drawer: selected worker's `WorkerRun` — status + step header, output via the existing `Markdown` component, a collapsed "Thinking ▸" section (`thinking`). Auto-selects the `running` worker (else the last) on open.
- Chrome mirrors FlowEditor's modal (fixed overlay, `C.bg` panel, `Close` using FlowEditor's `secondaryBtn` style — promoted to a shared style or re-declared locally).

### 4. Panel integration — `ChatContextPanel.tsx`

In the `tab === 'current'` branch, when `teamName` is set and a team `turn` exists, render a **"View flow ⤢"** button in the existing `TeamFlow` Section header. Clicking opens `TeamRunFlow`. The flat `TeamFlow` step list stays as-is. The chat's team graph is fetched in `ChatTab` via `apiService.getGlobalTeams()` (returns `Record<string, TeamConfigRaw>`, whose entry carries `graph`), keyed by `panelTeamName`, and passed down to the panel.

## Data flow

```
team run ──stream──> useChats reducer ──> ChatMessage{ content, thinkingByStep }
                                                   │
                       parseTeamMessage(content) ──┤── steps[] (step→worker, output)
                       deriveWorkerRuns(turn) ─────┴── WorkerRun[] (output + thinking per step)
                                                   │
   team config.graph (authored) ─or─ synthesizeChainGraph(runs) ──> nodeStatuses ──> live graph
                                                   │
                                TeamRunFlow: React-Flow (left) + worker drawer (right)
```

No changes to `packages/core` or `packages/gateway`. No new wire events.

## Testing

`codey-mac/src/components/teamRunModel.test.ts` (Vitest), covering:
- `deriveWorkerRuns`: two-step team message → two runs with correct worker/output; `thinking` joined from `thinkingByStep`; last step `running` when streaming, `done` when not; failure-marker output → `failed`; non-team turn → `[]`.
- `nodeStatuses`: worker run statuses mapped onto matching nodes; `askingWorker` → `askedUser`; unreached worker node → `pending`; `start` done, `end` pending while running then done; revisited worker shows latest status.
- `synthesizeChainGraph`: N runs → `start → w1 → … → wN → end`, passes `validateGraph`; single run and empty-run edge cases.

Renderer extraction is covered by the existing app build/`tsc` plus a manual visual pass in all four palettes (no snapshot infra today).

## Follow-up (out of scope here)

Per-worker **tool calls** in the drawer. Requires: add optional `step?: number` to `ToolCallEntry`; have the team dispatch loop pass an `onStatus` to `runWorkerStep` that forwards step-tagged `tool_start`/`tool_end` to the chat sink (plumbing to the agent already exists); add an `onTool(entry, step)` hook to `ChatEmitter` (no-op on `ChannelEmitter`); thread `step` through `useChats.tsx`. Then `deriveWorkerRuns` groups tool calls by `step` and the drawer renders them via `toolFormat`'s `ToolDetail`. Deferred at the user's request.

## Files

| File | Change |
|---|---|
| `codey-mac/src/components/flowGraph.tsx` | **new** — node/edge renderers + helpers extracted from FlowEditor; `status`-aware node styling; `rfNodeType` |
| `codey-mac/src/components/FlowEditor.tsx` | import renderers/helpers from `flowGraph`; no behavior change |
| `codey-mac/src/components/teamRunModel.ts` | **new** — pure run-model deriver |
| `codey-mac/src/components/teamRunModel.test.ts` | **new** — unit tests |
| `codey-mac/src/components/TeamRunFlow.tsx` | **new** — overlay (graph + worker drawer: output + thinking) |
| `codey-mac/src/components/ChatContextPanel.tsx` | "View flow ⤢" trigger in team mode; mount overlay; accept `teamGraph` prop |
| `codey-mac/src/components/ChatTab.tsx` | fetch team graph via `getGlobalTeams`, pass to panel |
