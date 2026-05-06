# Team Manager: Iterative Routing & Loop-Back

**Status:** Design
**Date:** 2026-05-06
**Supersedes (in part):** `2026-05-01-team-auto-dispatch-design.md`

## Problem

The current `dispatch: 'auto'` mode is a one-shot router: it picks a subset of team members up-front, preserves the team's input order, and runs each member sequentially with the previous worker's output as carry-context. This has three limitations:

1. **No task-driven ordering.** Order is whatever the user wrote in `workspace.json`.
2. **No loop-back.** A worker cannot be revisited after a later worker discovers their output needs revision.
3. **No per-step direction.** Each worker re-receives the original task, so a "revision" pass is indistinguishable from the first pass.

Goal: turn the dispatcher into an iterative *Manager* that, after each step, decides who runs next (or that the task is done) based on what has happened so far.

## Naming

- Module rename: `packages/core/src/dispatcher.ts` → `manager.ts`, `dispatcher-personality.ts` → `manager-personality.ts`.
- Symbol rename: `runDispatcher` → `runManager`, `DispatchResult` → `ManagerTurn`, `DispatchInput` → `ManagerInput`, `DispatcherRunner` → `ManagerRunner`, `DispatcherOptions` → `ManagerOptions`, `DispatchMember` → `ManagerMember`, `DISPATCHER_PERSONALITY` → `MANAGER_PERSONALITY`.
- Hard rename (no aliases). Sole consumer is `packages/gateway/src/gateway.ts`.
- The user-facing `dispatch: 'auto' | 'all'` field in `workspace.json` is **unchanged** to preserve backwards compatibility with existing configs. The `--all` override flag is unchanged.
- User-facing strings shift from "Dispatched" / "Auto-dispatch failed" to "Manager: …" / "Auto-routing failed".

## Manager Turn Contract

The Manager is invoked once per step instead of once up-front.

```ts
export interface ManagerMember {
  name: string;
  hint: string;
}

export interface ManagerHistoryEntry {
  worker: string;
  summary: string;
}

export interface ManagerInput {
  task: string;
  members: ManagerMember[];
  history: ManagerHistoryEntry[];   // prior steps, oldest first
  lastWorker: string | null;        // name of worker whose output is in lastOutput
  lastOutput: string | null;        // full output of most recent worker, or null on first turn
  finalize?: boolean;               // when true, only return final_summary
}

export interface ManagerTurn {
  /** Summary of lastOutput. Empty string on first turn (no last output). */
  summary_of_last: string;
  /** Next worker name (must be in members) or null when done. */
  next: string | null;
  /** Concrete instruction for the next worker. Required when next != null. */
  instruction: string;
  /** Short routing reason surfaced to the user. */
  reason: string;
  /** True when the task is satisfied; final_summary must be set. */
  done: boolean;
  final_summary?: string;
  /** True when caller should fall back to running all members in input order. */
  fallback: boolean;
  fallbackReason?: string;
}
```

The `instruction` field is the load-bearing addition: it lets the Manager say "architect, tighten the data model based on reviewer's concerns about idempotency" instead of just routing back to architect with the original task.

The Manager's JSON output schema is:

```json
{
  "summary_of_last": "<one to three sentences, '' if no last output>",
  "next": "<worker name or null>",
  "instruction": "<what should next worker do; '' when next is null>",
  "reason": "<one short sentence on routing choice>",
  "done": false,
  "final_summary": "<set when done is true; otherwise omit>"
}
```

## Loop Algorithm

Pseudocode replacing the one-shot dispatch + sequential loop in both `runTeamTask` (gateway.ts:1317) and `runTeamForChat` (gateway.ts:1434):

```
cap = clamp(2 * members.length, /*min*/ 4, /*max*/ 12)
history = []
lastWorker = null
lastOutput = null
parts = []     // [{ step, worker, output, isRevision }]
finalSummary = null

for step in 1..cap:
  turn = runManager({ task, members, history, lastWorker, lastOutput })
  if turn.fallback:
    return runAllMembersInInputOrder()   // current behavior, unchanged
  if lastWorker && turn.summary_of_last:
    history.push({ worker: lastWorker, summary: turn.summary_of_last })
  if turn.done || !turn.next:
    finalSummary = turn.final_summary ?? null
    break
  emit "🔄 Step <n>: <turn.next> — <turn.reason>"
  isRevision = parts.some(p => p.worker === turn.next)
  prompt = buildWorkerPrompt(turn.next, composeStepTask(originalTask, turn.instruction, lastOutput))
  output = runWorker(turn.next, prompt)
  parts.push({ step, worker: turn.next, output, isRevision })
  lastWorker = turn.next
  lastOutput = output

// Step cap exhausted without done — request a final summary
if finalSummary === null && parts.length > 0:
  closing = runManager({ task, members, history, lastWorker, lastOutput, finalize: true })
  finalSummary = closing.final_summary ?? null
```

`composeStepTask` builds the worker's task as:

```
<turn.instruction>

Original task: <originalTask>

[when lastOutput present]
Previous worker (<lastWorker>) output:
<lastOutput>
```

This replaces the current carry shape (`Previous worker output: …\n\nYour task: <original>`) so the worker sees an explicit instruction in addition to the original task and prior output.

## Step Cap

`cap = max(min(2 * members.length, 12), 4)`. Examples:

| members | cap |
|---------|-----|
| 1       | 4   |
| 2       | 4   |
| 3       | 6   |
| 5       | 10  |
| 6       | 12  |
| 10      | 12  |

Rationale: scales with team size for routine loop-back room, but a flat ceiling of 12 prevents large teams from running away. Floor of 4 means even a 1-worker team can be revisited a few times.

No new config surface; cap is a constant in `manager.ts`.

## Roster Strictness

The Manager can only pick from `team.members`. Names returned that are not in the roster are filtered (same as today's `runDispatcher`); if filtering empties the selection on a given turn, that turn falls back to running all members in input order. This matches the team-as-roster contract users opt into when invoking `/team`.

## Manager Prompt (`manager-personality.ts`)

New prompt instructs the Manager to:

- Read TASK, the ROSTER (each with one-line hint), the HISTORY (ordered list of `{worker, summary}`), and the LAST OUTPUT (full text, when present).
- Summarize LAST OUTPUT in one to three sentences (`summary_of_last`). Use `""` on the first turn.
- Decide whether the task is satisfied. If yes, set `done: true`, `next: null`, and write a `final_summary`.
- Otherwise pick the worker most likely to advance the task next from the ROSTER only. Looping back to a worker who already ran is **encouraged** when their output needs revision based on a later worker's findings — say so explicitly in the prompt.
- Write a concrete `instruction` for the next worker (especially on revisions: cite what to change and why).
- Provide a one-sentence `reason` for the routing choice, surfaced to the user.
- Output JSON only — no prose, no markdown fences.
- Honor a `finalize: true` flag by emitting only `done: true` + `final_summary`.

The prompt keeps the "if unsure, include" bias for revisions: when in doubt that the task is done, route to a reviewer or loop back rather than declaring done.

## Output Presentation

Both `runTeamTask` (chat-bridge response) and `runTeamForChat` (TUI sink) format results chronologically with a leading summary:

```
🧭 Manager summary: <final_summary>

### Step 1: architect
<output>

---

### Step 2: reviewer
<output>

---

### Step 3: architect (revision)
<output>
```

- `(revision)` is appended on the 2nd+ appearance of a worker name in `parts`.
- During the run, each step emits a live message: `🔄 Step <n>: <worker> — <reason>`. (Replaces today's single up-front "Dispatched X → Y → Z" header.)
- Truncation rules for the chat-bridge `runTeamTask` (currently `output.substring(0, 500)`) are preserved per step.

## Fallback Behavior

Any of the following routes the run to the legacy "run all members in input order" path, exactly as today:

- Manager runner throws.
- Manager response is non-success or returns no parseable JSON.
- Manager returns a `next` that, after roster filtering, leaves no valid choice on the first turn.
- `dispatch: 'auto'` with `--all` override (existing behavior).

Per-turn fallbacks after step 1 (e.g. malformed JSON on step 3) end the loop gracefully: the parts collected so far are returned with a Manager summary noting the routing failure. They do **not** trigger a full restart.

## Files Touched

- `packages/core/src/dispatcher.ts` → renamed `packages/core/src/manager.ts`, rewritten for per-turn contract.
- `packages/core/src/dispatcher-personality.ts` → renamed `packages/core/src/manager-personality.ts`, new prompt.
- `packages/core/src/index.ts` — update exports (add `runManager`, `ManagerTurn`, etc.; drop `runDispatcher`, `DispatchResult`).
- `packages/gateway/src/gateway.ts` — rewrite the loop bodies of `runTeamTask` (line 1317) and `runTeamForChat` (line 1434); update `/help` text mentioning auto-dispatch routing.
- No changes to `workspace.json` schema, `WorkerConfig`, `WorkerManager.getDispatchHint`, or the `--all` override.

## Non-Goals

- Workspace-wide worker recruitment (rejected: violates team-as-roster contract).
- Reviewer-as-arbiter pattern (rejected: Manager owns termination).
- Per-team `maxSteps` config (deferred until cap proves insufficient in practice).
- Parallel worker execution within a team run (out of scope).

## Testing

No test runner is configured in this repo (`README` / `CLAUDE.md` confirm). The implementation plan should rely on:

- A unit-style harness for `runManager` using a mock `ManagerRunner` (parallel to today's untested `runDispatcher` flow), exercising: first turn, mid-run with history, finalize turn, malformed JSON fallback, unknown worker filtering, `done` termination, cap exhaustion.
- Manual end-to-end via `/team <name>` with a 3-worker roster on a real workspace, confirming live `🔄 Step N` messages and chronological output with `(revision)` markers.
