# Automation authoring: relaxed readiness gate + dry-run verification

**Date:** 2026-07-12
**Status:** Approved design, pre-implementation
**Builds on:** `2026-07-02-automations-design.md` (automations engine, parked runs) and the
chat-driven authoring flow shipped in #162.

## Problem

The authoring chat currently treats scheduling as part of the readiness gate: the Aide
withholds `ready=true` until scheduling has been "explicitly discussed", so users are
forced through a scheduling conversation before the flow considers the automation done.
Meanwhile the deeper question — *can this brief actually run unattended?* — is only
enforced rhetorically (the Aide tries to ask enough questions) and never verified.

Direction: whether an automation is unattended-safe should be **discovered, not
enforced by conversation ordering**. The schedule is just metadata; users may set it via
chat, or later via the one-pager knobs (which already exist). What deserves machinery is
verifying the brief against the real workspace before the user trusts a timer with it.

## Decisions

| # | Decision |
|---|----------|
| 1 | **No new schedule UI in the create chat.** The one-pager knobs remain the direct editing surface; chat can still set `draft.schedule` when the user mentions timing. |
| 2 | **Readiness gate relaxed.** `ready=true` requires name + target + brief complete and no open questions *about the task*. Scheduling discussion is no longer required. |
| 3 | **Dry-run at ready, automatic.** When a chat turn transitions `ready` false→true, the gateway runs a no-act dry-run of the brief in the target workspace. |
| 4 | **Dry-run mechanism: real agent, no-act prompt** (approach A). The rendered brief is wrapped in a preamble instructing the agent to take no real actions and instead report gaps/ambiguities. Runs through the existing agent-adapter path as a one-shot prompt. Team targets are NOT dispatched as teams — worker definitions are inlined as context in the same one-shot prompt. |
| 5 | **Never blocking.** The Save gate stays `draftComplete` (name + brief + target). Users can save/schedule before the check finishes, after it fails, or with gaps outstanding — such runs may park questions at run time via the existing parked-run mechanism. |
| 6 | **Gaps feed back into the chat.** Dry-run findings arrive as an assistant message; answers patch the brief through the normal turn loop; the next ready-transition re-runs the dry-run. |

## Component changes

### 1. Aide prompt — relaxed gate (`packages/core/src/aide-automation.ts`)

- Rule 5 of the system prompt changes to: set `ready=true` only when **name, target and
  brief** are complete and there are no open questions about the task itself.
- Scheduling: the Aide still patches `schedule` whenever the user's message settles it,
  and on the ready turn mentions once — informationally, not as a question that blocks —
  that the automation will be manual-only unless a schedule is set (now in chat, or later
  from the automation's page).
- No changes to `AutomationDraft`, `draftPatch` validation, or the JSON contract.

### 2. Dry-run orchestrator (new: `packages/gateway/src/automations/dry-run.ts`)

A small manager owned by the gateway, injected with deps (mirroring `AutomationChatManager`'s
DI style so it is unit-testable with fakes):

```ts
interface DryRunDeps {
  /** One-shot prompt execution in a workspace (existing agent-adapter path). */
  execute: (workspaceName: string, prompt: string) => Promise<string>;
  /** Aide call that classifies dry-run output into a verdict. */
  classify: (briefOutput: string) => Promise<DryRunVerdict>;
  /** Resolve team/worker definitions for context inlining. */
  teamContext: (workspaceName: string, teamName: string) => Promise<string>;
}

type DryRunVerdict =
  | { status: 'clean' }
  | { status: 'gaps'; questions: string[] }
  | { status: 'error'; message: string };   // agent failure/timeout — not gaps
```

Behavior:

- **Trigger.** After each successful `AutomationChatManager.send`, the gateway inspects
  the returned step: if `ready` transitioned false→true for that session, it starts a
  dry-run keyed by `sessionId`.
- **Prompt assembly.** Render the brief with param substitution (existing rendering
  helper), then wrap:
  > *"DRY RUN — do not perform any real actions (no messages sent, no files changed, no
  > external side effects). Walk through the brief below step by step as if executing it
  > unattended. Report: (a) anything missing or ambiguous you would need to ask a human
  > about, (b) anything in the workspace that contradicts the brief. If nothing blocks
  > unattended execution, say so explicitly."*
  For `kind: 'team'` targets, append the team and worker definitions as context; the
  execution itself is always the prompt path, never team dispatch.
- **Classification.** The raw agent output goes through `classify` (an Aide call) to
  produce the structured verdict; free-text hedging maps to `gaps` with concrete
  questions.
- **Supersede/cancel.** At most one dry-run in flight per session. A newer ready
  transition supersedes the old run (its result is discarded on arrival). Session cancel
  or TTL expiry discards any in-flight result. The underlying agent process is not
  forcibly killed — its result is simply dropped (consistent with how the 5-minute agent
  timeout already bounds runaway processes).
- **Timeout.** Reuses the agent adapter's existing 5-minute timeout; timeout or spawn
  failure yields `status: 'error'`, never `gaps`.

### 3. Chat integration (`packages/gateway/src/automations/chat.ts` + gateway wiring)

- `ChatStep` gains an optional `check?: 'pending' | 'clean' | 'gaps' | 'error'` field so
  the renderer can show status without a second IPC channel for state.
- When a dry-run completes and the session still exists:
  - `clean` → an assistant message is appended: *"Dry run passed — this can run
    unattended. Save when ready."*
  - `gaps` → the questions are appended as a normal assistant message (one message,
    questions listed); the user answers through the ordinary turn loop, which patches the
    brief. The next false→true ready transition triggers a fresh dry-run.
  - `error` → no chat message; the failure surfaces only in the summary-panel status
    (decision 5: verification informs, it never nags or blocks).
- Delivery to the renderer reuses the existing `automation-event` push channel
  (gateway `setAutomationEventListener` → `sendToRenderer('automation-event', ev)` in
  `codey-mac/electron/main.ts`) with a new event type
  `{ type: 'chat-check', sessionId, check, questions? }` — session-keyed rather than
  automation-keyed, since the draft isn't saved yet. `AutomationChatCreate` subscribes
  via the existing `onEvent` preload hook and ignores events for other sessions. The
  notification logic in `main.ts` only reacts to `run-finished`/`run-parked`, so the new
  type flows through untouched. If the session died meanwhile, the result is dropped.
- The `send()` response itself carries `check: 'pending'` on the turn that triggered a
  dry-run, so the panel can show `checking…` immediately without waiting for a push
  event.

### 4. Mac app UI (`codey-mac/src/components/AutomationChatCreate.tsx`)

- Summary panel gains one status row under the existing rows:
  - in flight → `checking…` (subtle spinner)
  - `clean` → `✓ unattended-ready`
  - `gaps` → `⚠ may need input during runs`
  - `error` → `check failed` (dim; tooltip/title carries the message)
  - no dry-run yet → row hidden.
- Save button logic unchanged (`draftComplete` only). Saving with `⚠`/pending/failed is
  allowed; the automation may park questions at run time, which the run-history answer
  box already handles.
- `automationsModel.ts` gains a pure helper mapping `check` → row label, unit-tested.

### 5. Explicitly out of scope

- No engine (`engine.ts`), store, lease, or parked-run changes — the attended path is the
  existing parked-run mechanism, untouched.
- No changes to the one-pager knobs or the edit flow beyond what falls out of `ChatStep`
  (edit-mode chats get the same dry-run behavior for free).
- No persistence of dry-run verdicts on the saved automation (a verdict describes a
  moment in authoring, not a durable property; re-verification can be a later feature).

## Data flow

```
user msg ──► AutomationChatManager.send ──► Aide turn ──► draft patch
                                              │
                              ready false→true?
                                              │ yes
                                              ▼
                               DryRunManager.start(sessionId, draft)
                                              │
                     render brief + no-act preamble (+ team context)
                                              ▼
                        agent adapter (one-shot prompt, 5-min timeout)
                                              ▼
                              Aide classify ──► verdict
                                              │
                    session alive & not superseded?
                                              │ yes
              clean/gaps → assistant chat message + check status
              error      → check status only
                                              ▼
                          IPC push ──► summary panel status row
```

## Error handling

- Dry-run agent failure or timeout → `error` verdict; panel shows `check failed`; no
  chat message; nothing blocked.
- Classification (Aide) failure → treated as `error` (same path).
- Chat turn failure semantics unchanged (user message committed only on success; retry by
  resending).
- Race: verdict arriving after session cancel/TTL sweep is dropped silently.

## Testing

- **`aide-automation.test.ts`** — prompt no longer demands scheduling discussion;
  `ready` semantics assertions updated.
- **`dry-run.test.ts`** (new) — with fake deps: triggers only on false→true ready
  transitions; prompt assembly for prompt vs team targets; verdict mapping; supersede on
  re-trigger; drop-on-cancel; timeout → `error`.
- **`chat.test.ts`** — `check` field population; gap questions appended as assistant
  message; clean message wording; error produces status but no message.
- **`automationsModel.test.ts`** — `check` → status-row label mapping; `draftComplete`
  unchanged (regression guard that save is not gated on the check).
