# Team Auto-Dispatch Design

**Date:** 2026-05-01
**Status:** Draft (pending review)

## Problem

Today `/team <name> <task>` runs every member of a team in declared order, passing each step's output to the next via a carry chain (`gateway.ts:1301` and `gateway.ts:1382`). Two issues:

1. Simple tasks waste time and tokens on workers that have nothing to contribute.
2. There's no way to scope a team to "only the relevant members for this task."

Goal: let a team optionally route each task to the subset of members that actually need to participate, while preserving the existing sequential carry-chain semantics for the chosen subset.

This spec covers **targeted dispatch only**. Non-linear flows (parallel, discussion loops) are explicitly out of scope and tracked as a separate future design.

## High-Level Approach

Add a built-in dispatcher role: a Codey-internal "worker" that runs once before the team executes. It reads the task plus a short hint per member and returns the subset that should run. The selected members then execute via the existing sequential path — no change to carry-chain logic.

Auto-dispatch is **opt-in per team**. Existing teams keep their current behavior unless the user explicitly switches them to `auto`.

## Schema Changes

### `workspace.json` — team config

Teams accept two forms (both supported simultaneously):

```json
{
  "teams": {
    "review": ["architect", "reviewer"],
    "fullstack": {
      "members": ["architect", "frontend", "backend", "reviewer"],
      "dispatch": "auto"
    }
  }
}
```

The loader normalizes both to `{ members: string[], dispatch: 'all' | 'auto' }`. Array form ⇒ `dispatch: 'all'` (zero behavior change for existing configs). `dispatch` defaults to `'all'`.

### Worker `config.json` — optional `dispatchHint`

```json
{
  "codingAgent": "claude-code",
  "model": "sonnet",
  "tools": [],
  "dispatchHint": "Reviews code for security and style issues"
}
```

`dispatchHint` is the one-line summary fed to the dispatcher. If absent, the dispatcher uses the first line of `personality.role` truncated to 120 characters. `personality.soul` and `personality.instructions` are **never** sent to the dispatcher (noise that hurts selection accuracy).

### `gateway.json` — dispatcher model

```json
{
  "dispatcher": {
    "agent": "claude-code",
    "model": "claude-haiku-4-5"
  }
}
```

Both optional. When unset, dispatcher falls back to the gateway's default agent/model. The codey-mac UI exposes these as two dropdowns populated from already-configured agents/models — users do not edit JSON by hand.

## Dispatcher Implementation

The dispatcher is a built-in worker conceptually identical to user-defined workers, except its personality is hard-coded in Codey and not user-editable. It reuses the existing `runWithFallback` execution path — no new LLM client, no new SDK, no provider abstraction.

### `packages/core/src/dispatcher.ts` (new)

```ts
export interface DispatchInput {
  task: string;
  members: { name: string; hint: string }[];
}
export interface DispatchResult {
  selected: string[];   // subset of input names, sorted to match members' original order
  reason: string;       // one-sentence explanation, surfaced to the user
  fallback: boolean;    // true when the dispatcher failed and all members should run
}
export async function runDispatcher(
  input: DispatchInput,
  opts: { agent: CodingAgent; model: string; runner: AgentRunner; signal?: AbortSignal }
): Promise<DispatchResult>;
```

### Prompt

```
You are a task router. Given a task and a list of available workers,
select the SUBSET that should handle this task. Preserve input order.
If unsure, include more rather than fewer.

Task: <task>

Workers:
- architect: Designs system structure
- frontend: Builds React UI
- ...

Respond with JSON only:
{"selected": ["name", ...], "reason": "<one sentence>"}
```

### Execution & failure handling

| Failure | Behavior |
|---|---|
| LLM call fails / times out (30s) | `fallback: true`, all members run |
| Output is not parseable JSON | Try to extract first `{...}` block; if still fails, fallback |
| `selected` is empty | fallback |
| `selected` contains unknown worker names | filter unknowns; if remainder non-empty use it, else fallback |
| `dispatcherAgent` / `dispatcherModel` unset | use gateway default agent/model |
| Worker missing `dispatchHint` | use first line of `personality.role` truncated to 120 chars |
| Old `string[]` team config | loader normalizes to `{ members, dispatch: 'all' }`, no behavior change |

After a successful dispatch, `selected` is reordered to match each name's original index in `members`, so the user's declared ordering intent is preserved.

## Gateway Integration

`runTeamTask` (`gateway.ts:1301`) and `runTeamForChat` (`gateway.ts:1382`) gain a single pre-step:

```ts
const { members, dispatch } = workspaceManager.getTeam(name);   // normalized
let runMembers = members;
let dispatchInfo: DispatchResult | null = null;

if (dispatch === 'auto' && !forceAll) {
  dispatchInfo = await runDispatcher({
    task,
    members: members.map(n => ({ name: n, hint: workerManager.getDispatchHint(n) })),
  }, { agent: dispatcherAgent, model: dispatcherModel, runner });
  if (!dispatchInfo.fallback) runMembers = dispatchInfo.selected;
}

// Existing for-loop over runMembers, unchanged.
```

The downstream sequential carry-chain loop is untouched.

### User-visible output

- `dispatch: 'all'` — unchanged: `👥 Running team **review** (architect → reviewer)`
- `dispatch: 'auto'` success: `🧭 Dispatched **review**: architect → reviewer (skipped: coder, designer)\nReason: <dispatcher reason>`
- `dispatch: 'auto'` fallback: same as `'all'` plus a warning line `⚠️ Auto-dispatch failed, running all members.`

### `--all` flag

`/team review --all <task>` forces full-team execution regardless of the team's `dispatch` setting. `REGEX_TEAM` is extended to parse the optional flag; gateway treats it as `dispatch: 'all'` for that call. Cheap escape hatch when the dispatcher misroutes.

## File Change List

| File | Change |
|---|---|
| `packages/core/src/workspace.ts` | Normalize team loader; `getTeam` returns `{ members, dispatch }`; `listTeams` shows mode |
| `packages/core/src/workers.ts` | Add optional `dispatchHint` to `WorkerConfig`; new `getDispatchHint(name)`; `saveWorker` persists new field |
| `packages/core/src/dispatcher.ts` | **New.** `runDispatcher` per spec above |
| `packages/core/src/dispatcher-personality.ts` | **New.** Hard-coded dispatcher role/instructions |
| `packages/gateway/src/gateway.ts` | Pre-dispatch step in `runTeamTask` / `runTeamForChat`; `--all` flag in `REGEX_TEAM`; UI text |
| `packages/gateway/src/config.ts` (or equivalent) + `gateway.json.example` | Optional `dispatcherAgent` / `dispatcherModel` |
| `codey-mac` settings panel | New "Dispatcher (Auto Mode)" section: agent + model dropdowns |
| `README.md` / `README.zh-CN.md` | Document `dispatch: 'auto'`, `dispatchHint`, `--all` flag |
| `scripts/test-dispatcher.md` | **New.** Manual test checklist (project has no test runner) |

## Manual Test Checklist

Project has no test runner; verification is manual.

1. Old-format team (`string[]`) still runs all members in declared order.
2. New-format team with `dispatch: 'all'` behaves identically to old format.
3. New-format team with `dispatch: 'auto'`, normal path: only the selected subset runs, UI shows the dispatch reason.
4. Force fallback (set `dispatcherModel` to a non-existent value): UI shows ⚠️ and all members run.
5. `--all` flag bypasses dispatcher even when team has `dispatch: 'auto'`.
6. Dispatcher response containing an unknown worker name: unknowns are filtered; remaining selection runs.

## Out of Scope (YAGNI)

- Parallel / discussion / loop execution modes (separate future design)
- DAG-based member orchestration
- Caching dispatcher decisions across calls
- Running multiple teams concurrently
- User-editable dispatcher personality
- Embedded local inference engine (`node-llama-cpp` etc.)
- Auto-starting Ollama on Codey boot
