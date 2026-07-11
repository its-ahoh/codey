# Conversational Automation Authoring + One-Pager — Design

**Date:** 2026-07-11
**Status:** Approved (brainstormed with visual mockups; user selected chat + live summary panel for creation, tabbed one-pager for viewing, hybrid editing, free-form Aide loop engine)
**Supersedes:** the form-based `AutomationEditor` and the scripted `InterviewManager` flow from `docs/superpowers/specs/2026-07-02-automations-design.md` (authoring surface only — execution, scheduling, store, and run history are unchanged).

## Problem

Creating an automation today is form-filling: name field, target dropdowns, a goal textarea, then a scripted Q&A card ("clarification interview") whose questions are generated up front and stepped through in order. It cannot react to answers that revise earlier choices ("actually make that 8am"), and reopening an automation drops the user back into the same form. The user wants:

1. Creation to feel like chatting with an AI that walks them through it, clarifies uncertainties, and ends with a single confirmation once it has everything.
2. Reopening an automation to show a readable one-pager: what it does, all its settings, and how it has been running.

## Decisions (user-selected)

| Decision | Choice |
|---|---|
| Creation UX | Chat with inline suggestion chips + a live summary panel that fills in as the conversation progresses; the completed panel is the confirmation surface ("Create automation" button appears when ready) |
| Existing-automation view | One-pager with **Overview** and **Runs** tabs |
| Editing | Hybrid: quick knobs (params, schedule time, notify, enabled) editable inline on the Overview; behavioral changes reopen the chat pre-loaded with the automation ("Edit in chat") |
| Conversation engine | Free-form Aide loop: one `runAideJson` call per user turn returning reply + draft updates + ready flag. The scripted `InterviewManager` is removed |

## Architecture

```
Renderer (AutomationsView)
  ├── list panel (unchanged)
  ├── AutomationChatCreate    — chat column + live summary panel
  └── AutomationOnePager      — Overview / Runs tabs, parked banner
        │ IPC (preload bridge: window.codey.automations)
        ▼
Electron main — automations:* handlers (chatStart / chatSend / chatCancel added;
                interviewStart / interviewAnswer / interviewCancel removed)
        ▼
@codey/gateway  automations/chat.ts — AutomationChatManager (session state)
        ▼
@codey/core     aide-automation.ts — automationChatTurn prompt + parsing (runAideJson)
```

Execution path (engine, store, schedule, lease, parked/resume) is untouched. The chat engine never writes to the store; the renderer calls the existing `create`/`update` IPC when the user confirms.

## Component 1: Conversational turn prompt (`@codey/core`)

New export in `packages/core/src/aide-automation.ts`:

```ts
export interface AutomationDraft {
  name?: string;
  target?: AutomationTarget;          // workspace/team chosen in-chat
  schedule?: AutomationSchedule;      // absent = manual-only
  notify?: boolean;
  brief?: string;                     // synthesized, self-contained, {{placeholders}}
  params?: Record<string, string>;
}

export interface AutomationChatContext {
  workspaces: string[];
  teams: string[];
  tz: string;                         // user's IANA zone
  nowIso: string;                     // current local datetime for "every morning" resolution
  mode: 'create' | 'edit';
}

export interface AutomationChatTurn {
  reply: string;                      // assistant chat bubble (may ask a question or confirm)
  draftPatch: Partial<AutomationDraft>; // shallow merge into the session draft
  suggestions: string[];              // quick-reply chips (may be empty)
  ready: boolean;                     // all required fields present, ambiguities resolved
}

export async function automationChatTurn(
  messages: Array<{ role: 'user' | 'assistant'; text: string }>,
  draft: AutomationDraft,
  context: AutomationChatContext,
  opts: AideOptions,
): Promise<AutomationChatTurn>;
```

Prompt requirements:

- The system framing explains it is configuring an **unattended** automation: every ambiguity that would block a run with nobody present must be resolved during this conversation (same bar as the old interview + synthesis prompts, which this replaces).
- Grounding: the prompt embeds `context` verbatim — the model must only offer real workspace/team names as suggestions, and resolve relative times ("every morning") against `tz`/`nowIso` into a concrete `AutomationSchedule`.
- Ask **one thing per turn**; batch only trivially-related details. Prefer offering `suggestions` when the answer space is enumerable (workspace names, times, yes/no).
- The model maintains the draft incrementally: each turn's `draftPatch` contains only fields it newly learned or revised. Mid-conversation revisions ("make that 8am") are normal — patch and continue.
- `brief`/`params` are synthesized progressively and must meet the existing bar: self-contained (no "the user said"), concrete values, edge-case handling (e.g. quiet-day behavior), tweakable knobs as `{{placeholder}}` with current values in `params`.
- `ready: true` only when `name`, `target`, and `brief` are present and the model has no open questions; the `reply` on that turn summarizes the plan and invites confirmation. Schedule may legitimately be absent (manual-only) — but only after the model has explicitly asked about scheduling.
- Response is strict JSON (`runAideJson`); parsing tolerates missing optional fields (`suggestions` defaults to `[]`, `draftPatch` to `{}`). A missing/empty `reply` is a parse failure.

`renderBrief`, `generateAutomationQuestions`, `generateAutomationFollowup`, `synthesizeAutomationBrief`: `renderBrief` stays (execution uses it). The three interview functions are deleted with their tests once nothing references them.

## Component 2: `AutomationChatManager` (`@codey/gateway`)

New `packages/gateway/src/automations/chat.ts`, replacing `interview.ts`:

```ts
export interface ChatManagerDeps {
  /** Bound automationChatTurn with AideOptions pre-applied. */
  turn: (
    messages: Array<{ role: 'user' | 'assistant'; text: string }>,
    draft: AutomationDraft,
    context: AutomationChatContext,
  ) => Promise<AutomationChatTurn>;
  context: () => Omit<AutomationChatContext, 'mode'>;   // live workspace/team lists
}

export interface ChatStep {
  sessionId: string;
  reply: string;
  draft: AutomationDraft;     // full draft after the patch — drives the summary panel
  suggestions: string[];
  ready: boolean;
}

export class AutomationChatManager {
  start(mode: 'create' | 'edit', initialDraft?: AutomationDraft): Promise<ChatStep>;
  send(sessionId: string, text: string): Promise<ChatStep>;
  cancel(sessionId: string): void;
}
```

- Sessions are in-memory only (same rationale as the old interview: an authoring session is interactive Mac-app state, not a persisted run).
- `start('create')` seeds an empty draft and produces the opening assistant message ("What should this automation do?") — this first turn may be a fixed string with generic suggestions rather than an Aide call, to make opening the panel instant.
- `start('edit', draftFromAutomation)` seeds the draft from the stored automation and opens with "What should change?" (fixed string). The renderer builds `initialDraft` from the automation it already has.
- `send` appends the user message, calls `turn`, shallow-merges `draftPatch` into the session draft (a patch key explicitly set to `null` clears that field — how the model removes a schedule), appends the assistant reply, and returns the full draft.
- **Turn failure leaves the session intact**: the user message is not committed to the transcript until the Aide call succeeds, so a retry resends the same text without duplication.
- Reentrancy: a `send` while another `send` for the same session is in flight is rejected (same guard style as the old `answer`).
- `cancel` deletes the session; also called on a TTL sweep (30 min idle) so abandoned sessions don't leak.

Wiring in `gateway.ts`: construct with `turn` bound to the Aide options already used by the interview (advisor agent/model fallback), and `context()` pulling workspace and global-team names from the existing managers.

## Component 3: IPC surface

Preload bridge (`window.codey.automations`), replacing the three interview methods:

| Method | Returns |
|---|---|
| `chatStart(mode: 'create' \| 'edit', automationId?: string)` | `ChatStep` |
| `chatSend(sessionId, text)` | `ChatStep` |
| `chatCancel(sessionId)` | `void` |

For `mode: 'edit'`, the main-process handler loads the automation by id and builds the initial draft (name, target, schedule, notify from `report.notify`, brief, params). All other automation IPC (`list`, `create`, `update`, `delete`, `setEnabled`, `runNow`, `history`, `resume`, `markSeen`, `onEvent`) is unchanged. `create`/`update` payloads are built by the renderer from the final draft.

## Component 4: Renderer — creation chat (`AutomationChatCreate`)

Replaces `AutomationEditor` for new automations. The view's panel union becomes `{ kind: 'list' } | { kind: 'create' } | { kind: 'chat-edit'; id: string } | { kind: 'view'; id: string }` — `create`/`chat-edit` render this component (with the corresponding chat mode), `view` renders the one-pager.

Layout: two columns inside the existing Automations window.

- **Left — chat.** Scrolling transcript of assistant/user bubbles; suggestion chips under the latest assistant bubble (tapping a chip sends it as the user message); text input pinned at the bottom. While a turn is in flight: input disabled, typing indicator. On turn failure: an error bubble with a Retry button that resends the failed text.
- **Right — live summary panel.** Read-only during the conversation. Rows: name, schedule (plain language), where (workspace · prompt/team), notify, brief (collapsed preview, expandable), params. Unfilled rows render dimmed placeholders; each `draft` update fills rows in as they arrive. When `ready: true`, the panel header shows a **Create automation** (or **Save changes** in edit mode) primary button plus a secondary "keep chatting" affordance (the input stays live — the user can still type changes, which may flip `ready` back off).
- **Confirm:** the button validates the draft client-side (non-empty name, brief, workspace present) and calls `automations.create({ ...draft, enabled: true, report: { notify } })` or `automations.update(id, …)`, then returns to the list.
- **Lifecycle:** `chatCancel` on unmount/navigation, same ref pattern as the current editor's interview cancel.

## Component 5: Renderer — one-pager (`AutomationOnePager`)

Replaces `AutomationEditor` for existing automations (panel `{ kind: 'view', id }`); absorbs the `history` panel as its Runs tab (the list's separate History button goes away; Edit → the one-pager).

**Header (both tabs):** automation name; subtitle "Daily at 09:00 (Asia/Shanghai) · next run in 14h" (or "Manual only"); actions: **Run now**, **Edit in chat**, enabled toggle, Delete (with confirm).

**Parked banner (both tabs):** when the latest run is `parked`, a banner shows the pending question with option buttons and a free-text answer — the same resume controls as today's history rows, surfaced at the top.

**Overview tab:**
- *What it does* — the brief, rendered readably (pre-wrap box, `{{placeholders}}` visible).
- *Knobs — edit directly* — params (text inputs), schedule time + days, notify toggle. Edits are staged and saved via `automations.update` with an explicit Save affordance per the existing config-persistence conventions; saving updates `updatedAt` only.
- *Setup* — workspace/target, created date, last-updated date.

**Runs tab:** the existing `RunHistory` component content (50 runs, parked-resume per row, mark-seen behavior) rendered as a tab, with the run count in the tab label.

## Component 6: `automationsModel.ts` helpers (pure, tested)

- `scheduleSummary` (exists) — keep.
- `nextRunAt(schedule, nowMs): number | null` — next firing instant for "next run in 14h" (mirror of the engine's slot logic, computed via `Intl` like `schedule.ts`; returns null for manual-only).
- `humanizeDelta(ms): string` — "in 14h", "in 3m", "in 6d".
- `draftComplete(draft): boolean` — client-side create validation.

## Error handling summary

| Failure | Behavior |
|---|---|
| Aide call fails / malformed JSON | Error bubble + Retry; transcript uncommitted, retry is idempotent |
| Session lost (gateway restart, TTL) | `chatSend` rejects with unknown-session; UI offers "Start over" keeping the user's last text in the input |
| Create/update IPC fails | Error banner (existing pattern); chat session stays open so nothing is lost |
| Concurrent `send` on one session | Rejected by the manager's in-flight guard; UI prevents it anyway (disabled input) |

## Testing

- **core:** `automationChatTurn` parsing — happy path, missing optional fields, malformed JSON rejection, empty-reply rejection (mock Aide runner, same style as existing `aide-automation.test.ts`).
- **gateway:** `AutomationChatManager` — create flow to ready; edit flow seeds initial draft; draftPatch merge including `null`-clears; failure leaves transcript intact and retry works; in-flight guard; cancel and TTL sweep.
- **renderer model:** `nextRunAt` (daily, daysOfWeek, tz), `humanizeDelta`, `draftComplete`.
- Existing engine/store/schedule/lease/parked tests unchanged.
- Interview tests and `interview.ts` deleted in the same change that removes the last reference.

## Out of scope

- Automation execution, scheduling, lease, parked/resume mechanics — unchanged.
- Channel-side (Telegram/Discord) automation authoring.
- Streaming Aide responses (turns render whole; acceptable at interview-length replies).
- Persisting authoring transcripts.
