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
         └── runs each automation's rendered brief as a turn in a hidden
             system chat (Chat.kind: 'automation'), via the existing
             sendToChat pipeline — see "Execution: the hidden system chat"
             below. There is no separate headless entry point.
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

  // What it runs. `workspaceName` replaces the originally-sketched `workingDir`:
  // the hidden chat this automation owns (see `chatId` below) is created in
  // that workspace, and `sendToChat` resolves the actual `workingDir` from the
  // chat's workspace the same way any normal chat does — there is no parallel
  // working-directory mechanism for automations.
  target:
    | { kind: 'prompt'; workspaceName: string; agent?: CodingAgent; model?: string }
    | { kind: 'team';   teamName: string; workspaceName: string };

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

  // The hidden system chat (Chat.kind: 'automation') this automation executes
  // in, created lazily on first run. This chat IS the headless entry point —
  // every run and every resume is just another turn sent into it via
  // `sendToChat` with a collecting sink, so team pause/resume
  // (`chat.pendingTeam` + the existing continuation machinery) and
  // conversation context work completely unchanged. There is no separate
  // headless code path (see "Execution: the hidden system chat" below).
  chatId?: string;

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
  question?: string;        // pending question when status === 'parked'
  options?: string[];       // choice options, when the parked question was [ASK_USER:choice]
  resumedFrom?: string;     // runId of the parked run this record resumed
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
  schedule path both funnel into `AutomationEngine.execute`, which calls out to a
  gateway-supplied `runTarget`/`resumeTarget` adapter.
- **Execution: the hidden system chat.** There is no separate headless entry point.
  Each automation lazily gets its own hidden system chat (`Chat.kind: 'automation'`,
  `Automation.chatId`), created on first run in the target's `workspaceName` (with a
  `team` selection for `kind: 'team'` targets). Every run — scheduled, manual, or
  resumed — is simply a turn sent into that chat through the existing `sendToChat`
  pipeline with a collecting sink (`runAutomationTurn` on `Codey`):
  - `kind: 'prompt'` → `sendToChat` runs the automation's `agent`/`model` override
    against the rendered brief (placeholders substituted from `params`), fully
    autonomous, with `workingDir` resolved from the chat's workspace exactly as any
    normal chat turn resolves it.
  - `kind: 'team'` → `sendToChat`'s existing team dispatch runs the brief as the task;
    flow graphs, the judge, and `chat.pendingTeam` pause/resume work unchanged because
    this is the same code path a real chat uses.
  - Because the run lives in a real (hidden) chat, conversation context and history
    carry between runs and across resumes for free — no parallel continuation store
    was needed.
- **Unattended safety & parked runs** — runs have **no interactive surface bound**. Two
  parking paths are detected after each turn (`detectParked`): a `team` target parks via
  the persisted `chat.pendingTeam` (the existing pause machinery — authoritative for
  teams); a `prompt` target parks when the single agent's response itself contains an
  `[ASK_USER]` marker (a solo prompt has no team pause state to consult, so the marker
  is the signal). Either way the run is recorded `parked` with the pending
  `question`/`options`, and the user is notified. The engine **never guesses**. A parked
  run is **resumable**: the run-history detail in the Mac app shows the question with an
  answer box; the answer is simply the **next turn sent into the same hidden chat**
  (conversation context carries the original question forward, so no separate
  continuation keying by `runId` was needed), and the resumed execution appends a new
  `resumed` run record linked by `runId` via `resumedFrom`. Parked state survives
  restarts (it is persisted on the chat and in the run record), but a parked run older
  than 7 days is expired to `failed` so stale questions don't resume against a changed
  world — see "Hardening" below for the exact expiry and resume-consumption semantics.
- **Concurrency** — a per-process `active` set skips an automation whose previous run is
  still in flight; a fresh fire is also skipped while the latest run record is `parked`.
  See "Hardening" for the v1 limits this accepts.
- **Result routing** — on finish: append to run-history `.jsonl`; then best-effort
  delivery, with any failure recorded in the run's `reportFailure` (not just logged):
  - `report.notify` → emit `automation-run-finished`; if an Electron main is attached it
    fires the OS notification. **If the daemon holds the lease and the Mac app is
    closed, there is no notification surface** — the run record's `seenAt` stays unset,
    and the Mac app badges the Automations view with unseen results on next launch
    (notification-on-launch for anything unseen and recent).
  - `report.channel` → post summary via channel machinery **if that platform is
    connected in this process**; otherwise record the delivery failure.

### Hardening (from implementation review)

Points below were tightened after an implementation-review pass; each is a one-line
guarantee the code (and its tests) rely on:

- **Resume consumes the parked record.** After a resume attempt — success or failure —
  the original run is patched to `resumed`, so it stops being answerable; a second
  answer against the same `runId` is rejected (`resume()` requires `status === 'parked'`).
- **Parked expiry is leader-only, idempotent, and observable.** Only the scheduler
  lease-holder runs `expireParked` (a non-leader running it could clobber the leader's
  concurrent `appendRun`, since `patchRun` is a whole-file rewrite); expiring an already-
  expired run is a no-op; and expiry emits `run-finished` with the patched (`failed`)
  run so the Mac app notifies exactly as it would for any other finish.
- **Stale `pendingTeam` is cleared before fresh turns, not resumes.** A fresh automation
  turn (not a resume) clears any stale `chat.pendingTeam` on the hidden chat before
  calling `sendToChat` — this guards against an expiry/failed-resume desync where the
  chat still thinks a team is paused but the run record has already moved past `parked`.
  A resume turn relies on `pendingTeam` being present and does not clear it.
- **One bad automation can't stall the tick.** The engine tick evaluates each automation
  in its own `try/catch`; garbage schedule data (e.g. an invalid IANA tz, which makes
  `Intl` throw a `RangeError` inside `shouldFire`) logs and skips just that automation
  instead of aborting the whole tick and starving every other schedule.
- **Skill machinery is gated off for automation chats.** Auto-apply, skill-suggestion
  resolution, and the post-run crystallizer pass are all skipped when `chat.kind ===
  'automation'` — an unattended run executes a frozen brief and must not silently pick
  up or apply skills mid-run. Automation chat titles are also never LLM-rewritten.
- **`InterviewManager` is defensive about failure and reentrancy.** A session is removed
  from the in-memory map whether `synthesize` succeeds or throws (a failed interview
  restarts from scratch rather than retrying into duplicated state); `cancel(sessionId)`
  lets the Mac app drop an in-progress interview when its editor closes; and `answer()`
  clears the session's `current` question before awaiting the follow-up check, so a
  reentrant call for the same session hits the "unknown/no pending question" guard
  instead of racing.
- **The Mac IPC boundary validates before the store sees anything.** `automations:create`
  and `automations:update` run drafts/patches through `validateAutomationDraft` /
  `validateAutomationPatch` (hour/minute integer-range checks, an `Intl.DateTimeFormat`
  probe to reject a bad tz, and a `report.notify` boolean check) — bad data is rejected
  at the IPC handler, before it can reach `AutomationStore` and later starve the
  scheduler tick.
- **OS notifications respect global settings and window focus.** Both the launch-time
  unseen scan and the live `run-finished`/`run-parked` listener gate the actual
  `Notification` call behind `osNotificationsAllowed()`, which checks the app's global
  `notifications.enabled` setting and suppresses the OS notification while the main
  window is focused (the user is already looking at the app). Renderer-side events
  (`automation-event`, `automation-unseen`) and badges are unaffected by this gate —
  they always flow, since the renderer needs them to keep its own state in sync.
- **"Seen" is driven by display, not a separate acknowledgment step.** Simply displaying
  a run's status — the latest-status badge in the automations list, or opening the run
  history panel — marks that run `seenAt` via `automations:markSeen`. The launch-time
  scan only re-notifies runs that are still unseen *and* ended within the last 24h
  (`findUnseenRuns`), so a daemon-fired run from days ago doesn't resurface.
- **Accepted v1 limits.** These are known, intentional gaps, not bugs: the `active`-run
  guard is per-process only, so a second process (e.g. the standalone daemon and the
  embedded Mac-app gateway both pointed at the same store) can race two `runNow` calls
  for the same automation concurrently; `AutomationEngine.stop()` clears the tick timer
  and releases the lease but does not await any in-flight run; the Automations editor
  only authors daily/every-day schedules (`daysOfWeek` is preserved on an existing
  automation and round-tripped on save, but there is no UI control to edit which days
  fire); and a `report.notify`-only automation running on a headless daemon (no attached
  Electron main) produces no notification surface at all — the run simply waits in
  history for the Mac app's next launch scan. Two further gaps in the same class:
  daemon-fired runs are surfaced in the open Mac app only via the launch scan and
  App-mount recompute (there is no periodic re-scan, so a run the daemon fires while
  the app sits open shows up on next launch/navigation); and `report.channel` plus
  prompt-target `agent`/`model` overrides are fully plumbed end to end but have no
  editor UI yet — they are reachable only by editing `automations.json` directly.

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
- `execute`: prompt- and team-targets dispatch through the injected `runTarget`/
  `resumeTarget` adapter (mocked in engine tests; backed by the hidden-chat
  `runAutomationTurn` in the real gateway) to the correct run path; params substituted
  into brief placeholders.
- Unattended safety: `[ASK_USER]` (prompt targets) or `chat.pendingTeam` (team targets)
  → `parked`, never guesses; `resume(id, runId, answer)` continues the run, patches the
  original run to `resumed` (so a second answer is rejected), and appends a linked
  `resumed` record; parked runs expire to `failed` after 7 days, leader-only and
  idempotent.
- Concurrency: overlapping fire (active or parked previous run) skipped, not
  double-queued; a single bad automation's schedule data doesn't abort the tick.
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
- Flipping the Mac app's launch-at-login default: `setLoginItemSettings` already exists
  (`codey-mac/electron/main.ts`) and needed no new work here beyond documenting that a
  scheduled, app-only (no standalone daemon) automation setup requires it enabled —
  otherwise nothing fires the schedule while the app isn't running.
