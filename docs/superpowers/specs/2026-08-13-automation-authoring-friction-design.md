# Automation authoring friction — design

Date: 2026-08-13
Status: approved, ready for implementation plan

## Problem

Creating an automation through the Mac app's authoring panel is unreliable and
slow, in two independent ways.

**Chat turns fail often.** Every message is one Aide call (`packages/core/src/aide.ts`)
with a hard 30s timeout and no retry. The prompt carries the full draft plus the
entire transcript (`packages/core/src/aide-automation.ts`), so it grows with the
conversation and gets more likely to hit the timeout the longer you talk. On
failure the UI shows only "That message did not go through." — the real cause
(timeout, HTTP 402, unparseable JSON) is never surfaced.

**Verification is slow and gates saving.** The "check" is not form validation: it
spawns a real agent process that walks the brief inside the workspace
(`Gateway.runDryRunPrompt`), then makes a *second* Aide call to classify the
report. It therefore takes minutes even when the user filled in every field by
hand. Worse, it is a hard gate: `AutomationChatManager.finalize()` throws unless
the check is `clean`, so any failure in that chain — agent crash, classifier
call failing, timeout — becomes `error` and blocks the save behind a "Save
anyway…" button and a `confirm()` dialog. The failure is almost never about the
data being wrong.

Actual data validation (`codey-mac/electron/automation-validate.ts`) is already
pure and instantaneous. It is not the source of the delay and is not changed here.

## Decisions

1. The dry run becomes **advisory, never a gate**. A complete draft saves immediately.
2. The dry run runs **after save, in the background**, and its verdict is
   **persisted on the automation** so it survives closing the panel.
3. Chat turns get a **larger time budget, one bounded retry, a capped transcript,
   and honest error text**.

## Part 1 — Dry run as persisted advice

### Data

`packages/core/src/types/automation.ts`:

```ts
/** Advisory result of the last unattended dry run. Never blocks saving. */
export interface AutomationCheck {
  status: 'pending' | 'clean' | 'gaps' | 'error'
  /** Present when status === 'gaps'. */
  questions?: string[]
  /** Present when status === 'error'. */
  detail?: string
  at: number
}
```

`Automation` gains `check?: AutomationCheck`. Optional, so existing records load
unchanged and simply show no banner.

`AutomationEvent` gains a variant:

```ts
| { type: 'automation-check'; automationId: string; check: AutomationCheck }
```

The existing `chat-check` event variant is removed along with the session-scoped
check.

### Backend

- `packages/gateway/src/automations/chat.ts`
  - `finalize()` drops the check condition; the only remaining precondition is
    `draftComplete`. The `allowUnchecked` parameter is removed.
  - `Session.check` / `Session.checkFingerprint`, `reconcileCheck()`,
    `retryCheck()`, `resolveCheck()` and `ChatManagerDeps.onReadyTransition` are
    removed. `ChatStep.check` is removed. The authoring panel no longer has a
    notion of verification.
  - `ready` keeps its current meaning (the assistant has no open questions) and
    still drives nothing more than copy in the panel.
- `executionFingerprint` moves to `packages/core/src/aide-automation.ts` and is
  exported, so gateway can compute it for both a draft and a persisted automation.
- `Gateway.saveAutomationChat(sessionId)`
  - persists first, exactly as today;
  - then decides whether to check: **always** on create; on edit, only when the
    execution fingerprint (`target` + trimmed `brief` + `params`) differs from
    the pre-edit automation. Renaming, rescheduling or changing notify does not
    trigger a run.
  - when it decides to check, writes `check = { status: 'pending', at: now }`
    through the store, emits `automation-check`, and starts the dry run.
- `packages/gateway/src/automations/dry-run.ts`
  - `DryRunManager` is keyed by **automation id** instead of chat session id.
    The generation-counter semantics are unchanged: a newer `start()` or a
    `cancel()` makes an in-flight verdict be dropped on arrival.
  - `onResult` writes the verdict into the store (`check` with `at` stamped at
    delivery) and emits `automation-check`.
- Deleting an automation cancels its in-flight dry run.
- A `Re-run` action from the UI is a new gateway method
  (`recheckAutomation(id)`) that re-arms `pending` and starts a run from the
  persisted automation. `Dismiss` clears `check`.
- `aide-automation.ts` prompt rule 5 loses its trailing clause about keeping
  `ready=false` while unaddressed "Dry run found things to pin down" findings are
  in the transcript — that mechanism no longer exists inside the chat.

### IPC

- `automations:chat:save` loses its `allowUnchecked` argument.
- `automations:chat:retryCheck` is removed.
- New: `automations:recheck(id)` and `automations:dismissCheck(id)`.

### Frontend

- `codey-mac/src/components/AutomationChatCreate.tsx`
  - Remove `check`, `checkDetail`, `applyCheck`, `saveAfterCheckRef`,
    `retryCheck`, the `chat-check` event subscription, and the `confirm()`
    dialog.
  - The footer has exactly one action button, enabled when `draftComplete(draft)`.
    The status line lists missing fields, or reads "Ready to save".
  - `save()` keeps its pre-save form flush (the `chatPatch` that prevents a
    click racing an unblurred text field), then saves directly.
- `AutomationOnePager` gets a check banner at the top:
  - `pending` → neutral, "Dry run in progress…"
  - `gaps` → warning tone, the questions as a list, with `Re-run` and `Dismiss`
  - `error` → muted single line, "Last dry run didn't complete · Re-run".
    Deliberately low-key: this almost always means an environment problem, not a
    configuration problem.
  - `clean` → no banner.
- `AutomationsView` list rows show a small marker only for `gaps`.

## Part 2 — Chat turn reliability

- `AideOptions` gains `retries?: number`, default `0`, so no other Aide caller
  changes behaviour. The retry loop lives in `runAide`.
- Retries are only for transient failures. An error whose message matches a
  configuration problem — HTTP 402, unknown/invalid model, invalid API key — is
  rethrown immediately rather than burning a retry.
- `automationChatTurn` runs with `timeoutMs: 90_000`, `retries: 1`, and a 1s
  backoff between attempts.
- The prompt caps transcript history at the most recent 24 messages; anything
  earlier collapses to a single `[earlier turns omitted]` line. The draft is a
  complete state snapshot, so truncation loses no settled information. The
  session keeps the full transcript for display.
- The failure bubble in `AutomationChatCreate` shows the real error message plus
  one line: "You can also fill in the form on the right and save directly."

## Part 3 — Explicitly unchanged

`codey-mac/electron/automation-validate.ts` keeps its current IPC-boundary
validation. Its `validateAutomationChatPatch` still guards the structured form.

## Testing

- **core**: transcript truncation keeps the newest 24 and marks the elision;
  `retries: 1` retries a transient failure and returns the second attempt's
  result; a 402/unknown-model error is not retried; `renderBrief` unchanged.
- **gateway**: `finalize()` succeeds for a complete draft regardless of any
  prior check state; `saveAutomationChat` starts a dry run on create and on a
  fingerprint change but not on a rename/reschedule-only edit; a delivered
  verdict is written to the store and emitted as `automation-check`; deleting an
  automation cancels its in-flight run and drops the verdict.
- **mac**: banner renders the right branch per status; the create footer enables
  on `draftComplete` alone.

## Migration

`check` is optional and absent on existing records, which renders as no banner.
No data migration. The removed `allowUnchecked` IPC argument and the
`chat:retryCheck` channel are internal to this repo, so they are deleted rather
than deprecated.
