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
| 9 | Scheduler leadership | **One scheduler at a time** — lease lockfile; daemon wins over embedded gateway |
| 10 | Schedule format | **Structured time-of-day** (`{hour, minute, daysOfWeek?, tz}`), not cron strings, for v1 |
| 11 | Parked runs | **Resumable** from the run-history detail (answer box → existing continuation path) |

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
    ├── AutomationEngine    (schedule loop, runNow, executeAutomation, result routing)
    └── AutomationInterviewer (authoring-time clarification, reuses Aide role)
         └── runs via a new headless entry point over the existing run paths
```

### Scheduler leadership (single scheduler across processes)

The user can run the standalone daemon and the embedded Mac-app gateway **at the same
time**, and both read the same `~/.codey/automations.json`. If both ran the schedule
loop, every automation would fire twice, and `lastFiredAt` cannot save us — each process
races to persist it, and concurrent `automations.json` writes are last-writer-wins.
Therefore exactly **one process holds the scheduler lease** at a time:

- **Lease lockfile** — `~/.codey/automation-scheduler.lock` containing
  `{ pid, role: 'daemon' | 'embedded', heartbeatAt }`. The holder refreshes
  `heartbeatAt` every tick; a lock whose heartbeat is older than 3 ticks is stale and
  may be taken over. Lock acquisition uses an atomic create (`wx` open) with a
  read-verify-steal path for stale locks.
- **Daemon wins** — the daemon always attempts to acquire (stealing a stale or
  embedded-held lease at startup is allowed after a takeover handshake: embedded holders
  re-check the lockfile each tick and stand down when they see a daemon claim). The
  embedded gateway acquires only if no live daemon holds the lease.
- **Non-leaders stay useful** — a process without the lease still serves the store
  (list/edit/history) and can `runNow`; it just never fires schedules.
- **Write discipline** — `automations.json` rewrites are read-modify-write on the latest
  file contents with an atomic rename, so an edit from the Mac app and a `lastFiredAt`
  update from the daemon don't clobber each other. Run-history `.jsonl` files are
  append-only per automation and safe to append from either process.

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
  // Params are injected as {{placeholders}} in the brief; any param without a
  // placeholder is appended as a trailing "Parameters:" block. The synthesizer
  // emits placeholders for every surfaced param so edits take effect without
  // re-synthesis.

  // When it runs (Q2/Q10). Structured time-of-day, NOT a cron string: the v1 UI
  // only expresses time-of-day, structured form is trivially tz-safe to evaluate
  // with Intl (no cron parser dep, no hand-rolled cron bugs). A `cron?: string`
  // field can be added later for power users without migration.
  schedule?: {
    hour: number;          // 0-23, in tz
    minute: number;        // 0-59
    daysOfWeek?: number[]; // 0=Sun … 6=Sat; absent = every day
    tz: string;            // IANA zone, e.g. "Asia/Shanghai"
  };                       // absent = manual-only

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
  status: 'success' | 'failed' | 'parked' | 'resumed';
  trigger: 'manual' | 'schedule';
  output?: string;          // capped (e.g. 32KB, truncation marked) — team runs can
                            // produce huge transcripts and the UI reads this file
  error?: string;
  reportFailure?: string;   // notify/channel delivery failure, recorded not just logged
  seenAt?: number;          // set when the Mac app has surfaced the result (badge clear)
}
```

Store requirements: load/save `automations.json` with read-modify-write + atomic rename
(see scheduler leadership); append run records; filter by `enabled`; **preserve unknown
fields** on rewrite of both definitions and run records (forward-compatible migration).

## Scheduler & execution engine

`AutomationEngine` in `@codey/gateway`, instantiated by `Codey`:

- **Schedule loop** — a single timer (~30s tick), active only while this process holds
  the scheduler lease. Each tick evaluates every enabled automation's structured
  `schedule` in its `tz` (via `Intl.DateTimeFormat` parts — no cron dep), using
  persisted `lastFiredAt` to:
  - avoid double-firing within one slot, and
  - **skip missed slots on restart** — if a scheduled slot elapsed while the process was
    down, **log and skip; never back-fire** (a 3am job must not blast at noon).
- **Triggers** — `runNow(id, trigger)` (manual, allowed even without the lease) and the
  schedule path both funnel into one `executeAutomation(automation, trigger)`.
- **Execution — a new headless entry point.** The existing run paths are not directly
  callable here: `runTeamTask` is `private` on the gateway and takes a channel-shaped
  `UserMessage` plus response plumbing, and the chat paths assume a chat to stream into.
  The gateway therefore exposes `runHeadless(automation, trigger)` which builds a
  synthetic message from the rendered brief (placeholders substituted from `params`)
  and a **collecting emitter sink** (a `TeamEmitter` sink that accumulates the
  transcript instead of streaming to a surface — mirroring what `sendToChat` does for
  the chat surface):
  - `kind: 'prompt'` → run through the agent adapter path with the automation's
    `workingDir`/`agent`/`model`, fully autonomous.
  - `kind: 'team'` → dispatch through `runTeamTask` (via the headless wrapper) with the
    brief as the task; flow graphs and the judge work unchanged.
- **Unattended safety & parked runs** — runs have **no interactive surface bound**. An
  unexpected `[ASK_USER]` is caught: the run is recorded `parked` with the pending
  question in `output`, pause state persisted via the existing `TeamEmitter`
  continuation machinery (keyed by `runId` instead of a chat id), and the user is
  notified. The engine **never guesses**. A parked run is **resumable**: the run-history
  detail in the Mac app shows the question with an answer box; the answer feeds the
  persisted continuation exactly like a chat reply would, and the resumed execution
  appends a new `resumed` run record linked by `runId`. Parked state survives restarts
  (it is persisted), but a parked run older than 7 days is expired to `failed` so
  stale questions don't resume against a changed world.
- **Concurrency** — reuses the existing `RunSemaphore`. An automation that fires while its
  previous run is still active (or parked) is **skipped and logged**, not double-queued.
- **Result routing** — on finish: append to run-history `.jsonl`; then best-effort
  delivery, with any failure recorded in the run's `reportFailure` (not just logged):
  - `report.notify` → emit `automation-run-finished`; if an Electron main is attached it
    fires the OS notification. **If the daemon holds the lease and the Mac app is
    closed, there is no notification surface** — the run record's `seenAt` stays unset,
    and the Mac app badges the Automations view with unseen results on next launch
    (notification-on-launch for anything unseen and recent).
  - `report.channel` → post summary via channel machinery **if that platform is
    connected in this process**; otherwise record the delivery failure.

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
6. **Schedule + report target** — time-of-day picker → structured `schedule`
   (`hour`/`minute`/`daysOfWeek`/`tz`); notify toggle + optional channel. Save.

Editing `params` later is cheap (no re-interview). Changing the **goal** re-opens the
interview and regenerates the brief.

## Mac app UI & IPC

**New "Automations" view** in the renderer, alongside chats/flows:

- **List** — name, target kind, schedule summary ("daily 9:00"), enabled toggle,
  last-run status badge, **Run now**.
- **Create/Edit** — goal + target picker → clarification interview panel (chat-like, one
  question at a time) → read-only brief preview (regenerated on goal change) → editable
  `params` → schedule picker + report target → **Test run now**.
- **Run history** — per-automation timeline read from the `.jsonl`; each run expandable
  to output/error. A **parked** run shows the pending question with an **answer box**;
  submitting resumes the run (Q11). Unseen results badge the Automations view; opening
  a run marks it `seenAt`.

**IPC / wiring** (Electron main ↔ embedded `Codey`, following the existing pattern):

- `automations:list | get | create | update | delete | setEnabled`
- `automations:runNow(id)`
- `automations:resume(id, runId, answer)` — answer a parked run's question
- `automations:markSeen(id, runId)`
- `automations:interview:start | answer | next`
- Engine emits `automation-run-started | finished | parked` → forwarded to the renderer
  for live status and to `chat-notifications.ts` for the OS notification. On app launch,
  the main process scans run history for unseen recent results and notifies/badges
  (covers runs fired by the daemon while the app was closed).

The renderer holds **no new persistence** — it is a pure client over the gateway store,
consistent with how chats already work.

## Testing strategy

Vitest, `*.test.ts` colocated per package; runs under `npm test`.

**`@codey/gateway` — engine (highest value):**
- Schedule eval: fires at the right slot across tz boundaries (structured schedule +
  `Intl`, incl. DST transitions); **skips a missed slot on restart (no back-fire)**; no
  double-fire within one slot (`lastFiredAt`).
- Leadership: only the lease holder ticks; embedded holder stands down when a daemon
  claims; stale lock (dead heartbeat) is stolen; non-leader still serves `runNow`.
- `executeAutomation`: prompt- and team-targets dispatch through the headless entry
  point to the correct run path (mocked); params substituted into brief placeholders.
- Unattended safety: `[ASK_USER]` → `parked` + continuation persisted; never guesses;
  `resume(runId, answer)` continues the run and appends a `resumed` record; parked runs
  expire to `failed` after 7 days.
- Concurrency: overlapping fire (active or parked previous run) skipped, not
  double-queued.
- Result routing: run appended to `.jsonl` with output capped; notify + channel called
  when configured; delivery failure lands in `reportFailure`.

**Store:** load/save `automations.json` (read-modify-write + atomic rename; concurrent
writers don't clobber); per-id run-history append; enabled filtering; unknown-field
preservation in definitions and run records.

**`@codey/core` — interviewer/brief:** given goal + canned answers (mocked Aide),
synthesizes a non-empty self-contained brief + params; goal change re-opens interview;
follow-up bounded.

**Mac app (light):** cron ⇄ time-of-day mapping; "can't schedule without a brief" guard.
UI stays manual/visual.

## Out of scope (v1)

- Event/webhook/message triggers (design storage so they can be added without rework).
- `/automation` chat command (fast-follow once store + engine exist).
- Multi-user sharing of automations.
