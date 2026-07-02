# Codey Automations — Design (v1)

**Date:** 2026-07-02
**Status:** Approved (brainstorming) — pending implementation plan

## Summary

Automations let a user define a **fully actionable, self-contained process** that Codey
runs either **on demand ("run now")** or **on a time-of-day schedule** — for example,
"post the day's top AI news to my X account every morning." Each automation runs an
existing Codey execution primitive:

- a **plain prompt** to an agent, or
- an existing **team / flow graph**.

The defining principle: **all ambiguity is resolved at authoring time**, not at run
time. When you create an automation, Codey runs an **interactive clarification
interview** — the agent asks everything it would otherwise need mid-run, you answer,
and the answers are baked into a frozen brief. Scheduled runs are therefore **fully
autonomous**; a run that still hits an unforeseen `[ASK_USER]` **parks and notifies**
rather than guessing.

## Decisions (from brainstorming)

| # | Question | Decision |
|---|----------|----------|
| 1 | Execution unit | Plain **prompt** or existing **team/flow** |
| 2 | Triggers | **Manual (run-now) + scheduled (time-of-day)**; event triggers out of scope for v1 |
| 3 | Scheduler host | **Gateway/core layer** (shared), not the Electron main process |
| 4 | Runtime reality | Both standalone daemon **and** embedded-in-Mac-app gateway must run schedules |
| 5 | Unattended approvals | Clarify at **authoring**; runtime is autonomous; unexpected pause → **park + notify** |
| 6 | Clarification output | **Frozen brief + surfaced editable params** |
| 7 | Output/notifications | **Run history + Mac notification + optional post to a chat/channel** |
| 8 | Authoring surface | **Mac app only** for v1; `/automation` chat command is a fast-follow |

## Architecture

The scheduler cannot live in the Electron main process, because the user runs Codey
**both** as a standalone `packages/gateway` daemon and embedded inside the Mac app
(`codey-mac/electron/main.ts` imports `Codey` from `@codey/gateway`). Placing the engine
in the shared gateway layer means whichever process instantiates `Codey` gets the cron
loop for free — no duplication. The Mac app additionally gains a launch-at-login /
background mode so the app-only case can still fire schedules.

```
Mac app (Automations view)
    │  IPC (list/create/interview/runNow/history)
    ▼
Electron main (holds the Codey instance)
    ▼
@codey/gateway
    ├── AutomationStore     (~/.codey/automations.json + per-id run history .jsonl)
    ├── AutomationEngine    (cron loop, runNow, executeAutomation, result routing)
    └── AutomationInterviewer (authoring-time clarification, reuses Aide role)
         └── reuses existing run paths: agent chat run / runTeamTask + graph/judge
```

## Data model & storage

Definitions live in `~/.codey/automations.json` (owned by `@codey/gateway`, read/written
by both the daemon and the embedded gateway). Run history is **separate, append-only,
per-automation** so history never bloats the definition store.

```ts
interface Automation {
  id: string;
  name: string;
  enabled: boolean;

  // What it runs
  target:
    | { kind: 'prompt'; workingDir?: string; agent?: CodingAgent; model?: ModelConfig }
    | { kind: 'team';   teamName: string };

  // Baked at authoring time (Q6)
  brief: string;                    // frozen, enriched, self-contained instruction block
  params: Record<string, string>;   // surfaced editable knobs (account, count, tone, …)

  // When it runs (Q2/Q4)
  schedule?: { cron: string; tz: string };   // absent = manual-only

  // Where results go (Q7)
  report: {
    notify: boolean;                                  // Mac notification
    channel?: { platform: string; target: string };  // optional chat/channel post
  };

  lastFiredAt?: number;             // for missed-slot / double-fire protection
  createdAt: number;
  updatedAt: number;
}
```

Run history: `~/.codey/automation-runs/<id>.jsonl`, one JSON object per line:

```ts
interface AutomationRun {
  runId: string;
  startedAt: number;
  endedAt?: number;
  status: 'success' | 'failed' | 'parked';
  trigger: 'manual' | 'schedule';
  output?: string;
  error?: string;
}
```

Store requirements: load/save `automations.json`; append run records; filter by
`enabled`; **preserve unknown fields** on rewrite (forward-compatible migration).

## Scheduler & execution engine

`AutomationEngine` in `@codey/gateway`, instantiated by `Codey`:

- **Cron loop** — a single timer (~30s tick) evaluates each enabled automation's
  `schedule.cron` against its `tz`, using persisted `lastFiredAt` to:
  - avoid double-firing within one slot, and
  - **skip missed slots on restart** — if a scheduled slot elapsed while the process was
    down, **log and skip; never back-fire** (a 3am job must not blast at noon).
- **Triggers** — `runNow(id, trigger)` (manual) and the cron path both funnel into one
  `executeAutomation(automation, trigger)`.
- **Execution**:
  - `kind: 'prompt'` → build run prompt from `brief` + `params`, run through the existing
    agent run path, **fully autonomous** (no interactive channel bound).
  - `kind: 'team'` → call existing `runTeamTask` with the brief as the task.
- **Unattended safety** — runs with **no interactive channel bound**. An unexpected
  `[ASK_USER]` is caught: run ends `parked`, pause state persisted (reusing existing
  pause machinery), user notified. The engine **never guesses**.
- **Concurrency** — reuses the existing `RunSemaphore`. An automation that fires while its
  previous run is still active is **skipped and logged**, not double-queued.
- **Result routing** — on finish: append to run-history `.jsonl`; fire Mac notification if
  `report.notify`; post summary to `report.channel` if set (reusing channel machinery).

## Authoring flow (the clarification interview)

The interview is the gate: an automation cannot be scheduled until it has a synthesized
brief.

1. **Goal** — free text + choose target kind (prompt, or pick an existing team).
2. **Clarification pass** — an interviewer LLM (reuses the **Aide** role in
   `packages/core/src/aide.ts`) reads the goal (and, for a team target, the team/worker
   definitions) and produces the **open questions** it would otherwise hit at runtime:
   missing specifics, choices, accounts/credentials, ambiguities, edge cases ("what if
   there's no notable news today?"). Questions are presented **one at a time**.
3. **Answers** — user answers each; the interviewer may ask **one bounded follow-up** per
   question if an answer opens a new gap (guard against loops).
4. **Brief synthesis** — fold goal + answers into (a) the frozen self-contained `brief`
   (building on the existing `TaskBrief` shape) and (b) a small set of surfaced `params`.
5. **Dry-run (recommended)** — "Test run now" executes once immediately and shows output;
   user accepts or returns to answer more. This is the verification step before trusting
   a schedule.
6. **Schedule + report target** — time-of-day → `cron` + `tz`; notify toggle + optional
   channel. Save.

Editing `params` later is cheap (no re-interview). Changing the **goal** re-opens the
interview and regenerates the brief.

## Mac app UI & IPC

**New "Automations" view** in the renderer, alongside chats/flows:

- **List** — name, target kind, schedule summary ("daily 9:00"), enabled toggle,
  last-run status badge, **Run now**.
- **Create/Edit** — goal + target picker → clarification interview panel (chat-like, one
  question at a time) → read-only brief preview (regenerated on goal change) → editable
  `params` → schedule picker + report target → **Test run now**.
- **Run history** — per-automation timeline read from the `.jsonl`; each run expandable to
  output/error.

**IPC / wiring** (Electron main ↔ embedded `Codey`, following the existing pattern):

- `automations:list | get | create | update | delete | setEnabled`
- `automations:runNow(id)`
- `automations:interview:start | answer | next`
- Engine emits `automation-run-started | finished | parked` → forwarded to the renderer
  for live status and to `chat-notifications.ts` for the OS notification.

The renderer holds **no new persistence** — it is a pure client over the gateway store,
consistent with how chats already work.

## Testing strategy

Vitest, `*.test.ts` colocated per package; runs under `npm test`.

**`@codey/gateway` — engine (highest value):**
- Cron: fires at the right slot; **skips a missed slot on restart (no back-fire)**; no
  double-fire within one slot (`lastFiredAt`).
- `executeAutomation`: prompt- and team-targets dispatch to the correct existing run path
  (mocked).
- Unattended safety: `[ASK_USER]` → `parked` + pause state persisted; never guesses.
- Concurrency: overlapping fire skipped, not double-queued.
- Result routing: run appended to `.jsonl`; notify + channel called when configured.

**Store:** load/save `automations.json`; per-id run-history append; enabled filtering;
unknown-field preservation.

**`@codey/core` — interviewer/brief:** given goal + canned answers (mocked Aide),
synthesizes a non-empty self-contained brief + params; goal change re-opens interview;
follow-up bounded.

**Mac app (light):** cron ⇄ time-of-day mapping; "can't schedule without a brief" guard.
UI stays manual/visual.

## Out of scope (v1)

- Event/webhook/message triggers (design storage so they can be added without rework).
- `/automation` chat command (fast-follow once store + engine exist).
- Multi-user sharing of automations.
