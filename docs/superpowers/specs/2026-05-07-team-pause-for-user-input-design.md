# Team Pause-for-User-Input Design

Date: 2026-05-07
Status: Draft

## Problem

When a `/team` runs, workers execute in sequence (sequential dispatch) or under the Manager (auto dispatch). If a worker needs the user to clarify or confirm something, there is currently no way to surface the question — it is buried in the worker's output and the next worker still runs, often producing irrelevant or wrong work because the prerequisite was never resolved.

Goal: when any worker in a team run needs user input, halt the team, surface the question, wait for the user's reply, and incorporate that reply into the continued run.

## Approach

Introduce an explicit, in-band marker that workers emit when they need user input. The runner detects the marker after each step and pauses the team. The chat persists pending state. The user's next non-command message is treated as the answer and resumes the team.

Detection lives at the runner (not in the Manager) so the same mechanism works in both sequential and auto-dispatch modes.

## Spec

### Marker convention

Workers signal a need for user input by emitting a single line in their output:

```
[ASK_USER]: <question text>
```

Rules:
- One marker per worker output. If multiple lines match, use the first; ignore the rest.
- The marker may appear anywhere in the output. Content before the marker is preserved (used in the user-facing message and in resume context); content after the marker is discarded for routing purposes but kept in any logs/history.
- Worker personality templates gain one instruction line:
  > "If you cannot proceed without input from the user, output a single line `[ASK_USER]: <your question>` and stop. Do not guess. Do not continue the work."
- A small parser utility lives in `@codey/core` (e.g. `parseAskUser(output: string): { question: string; preamble: string } | null`) and is used by both runners.

### Pending state on Chat

Extend `Chat` (`packages/core/src/types/chat.ts`) with an optional `pendingTeam` field:

```ts
export type PendingTeamState =
  | {
      teamName: string;
      task: string;             // original task as given to /team
      mode: 'sequential';
      memberIndex: number;       // index of the asking worker in team.members
      carry: string;             // carry passed to the asking worker
      askingWorker: string;
      question: string;
      askedAt: number;
    }
  | {
      teamName: string;
      task: string;
      mode: 'auto';
      history: ManagerHistoryEntry[];
      lastWorker: string;
      lastOutput: string;        // raw output of the asking worker (with marker line stripped from preamble for resume)
      partsSoFar: Array<{ step: number; worker: string; output: string; isRevision: boolean }>;
      seenWorkers: string[];
      step: number;              // next step number to use
      askingWorker: string;
      question: string;
      askedAt: number;
    };

export interface Chat {
  // ...existing fields...
  pendingTeam?: PendingTeamState;
}
```

Persisted with the chat by the existing chat store (`packages/gateway/src/chats.ts`) so pause survives restarts.

Only one paused team per chat at a time. Starting a new team while one is paused clears the pending state (with a notice to the user) and starts the new run.

### Gateway routing

Pre-dispatch hook in the gateway message handler:

```
on user message in chat C:
  if C.pendingTeam exists:
    if message is a slash command:
      clear C.pendingTeam
      send: "Cancelled paused team `<name>` (was waiting on: <question>)."
      proceed with normal command handling
    else:
      resume team using message.text as the answer
      return
  // ...existing dispatch...
```

This lives alongside the existing rate-limit and routing logic in `gateway.ts` `processMessage` (or its equivalent for the Mac/chats path).

### Sequential resume (mode = 'sequential')

Re-run the asking worker with the original carry plus the user's answer appended:

```
<original step prompt for members[memberIndex]>

[User answer to your question "<question>"]:
<user reply>
```

Behavior:
- If the re-run output contains `[ASK_USER]:` again, repause with updated question/asker (same `memberIndex`, refreshed `askedAt`).
- Otherwise, treat the re-run output as that worker's output, advance to `memberIndex + 1`, and continue the existing sequential loop with normal carry.
- Apply this in both `runAllMembersInOrder` (gateway.ts:1890) and the chat-stream sequential path (gateway.ts:2015). Refactor those into a shared helper that accepts a "resume from index N with carry+answer" entry point.

### Auto resume (mode = 'auto')

Extend `ManagerInput` (`packages/core/src/manager.ts`) with:

```ts
userClarification?: {
  worker: string;
  question: string;
  answer: string;
};
```

`buildManagerPrompt` renders an extra section when present:

```
## User Clarification
Worker <worker> asked: <question>
User answered: <answer>
```

`runManagerLoop` (gateway.ts:1642) gets a new entry point — `resumeManagerLoop(pending: PendingTeamState & { mode: 'auto' }, answer: string, ...)` — that:
1. Restores `history`, `lastWorker`, `lastOutput`, `partsSoFar`, `seenWorkers`, `step` from `pending`.
2. Calls `runManager` with `userClarification` populated and the same task/members/etc. as the original loop.
3. Continues from the returned turn exactly like a normal iteration: if `done`, finalize; if `next`, run that worker, parse its output, repause on marker, otherwise loop.
4. After the clarification turn, append `{ worker: askingWorker, summary: "User clarified: <question> → <answer>" }` to `history` so subsequent turns retain it; `userClarification` is only sent on the immediate next turn.

The Manager may choose to re-route to the same `askingWorker`, advance to a different worker, or set `done`. All three are valid.

### Worker step output parsing

The runner code path that calls `runOneWorker` in both modes wraps the result:

```ts
const askParsed = parseAskUser(response.output);
if (askParsed) {
  await persistPendingTeam(chatId, /* mode-specific state */);
  await sendUserVisible({
    chatId,
    channel,
    text: renderQuestion(workerName, askParsed.preamble, askParsed.question),
  });
  return; // halt run
}
```

`renderQuestion` produces:

```
❓ **<worker>** needs your input:

<question>

_Reply with your answer to continue, or send a slash command to cancel._
```

If `preamble` is non-empty and not just whitespace, it appears above the `❓` block as the worker's partial output (truncated to ~500 chars to match existing per-step truncation).

### UI/Mac surfacing

The Mac chat view renders the pause message as a normal assistant message. No new component required. The existing chat-message stream sink path already supports the `info`/text shape used by team status updates; the pause message uses the same path so it shows up inline with the run.

When the user types into the chat while `pendingTeam` is set, the message goes through the same `processMessage` entry; the new pre-dispatch hook handles the resume. From the Mac UI's perspective nothing changes.

### Cancellation

- Any slash command (`/team`, `/worker`, `/cancel`, `/workspace`, etc.) clears `pendingTeam` and proceeds.
- The existing abort flow (user-triggered cancel during a run) does not normally fire while paused (the run is not active), but a `/cancel` while paused is handled by the slash-command branch above.
- No automatic timeout. Pending state lives until the user replies or cancels.

### Out of scope

- No multi-question batching: one `[ASK_USER]:` per pause.
- No automatic TTL on pending state.
- No change to `/worker` single-worker runs (the user already replies naturally between turns).
- No change to `--all`/forceAll *parallel* semantics beyond the same pause/resume in the sequential carry loop they already use.
- No tooling for the user to amend previous turns; the answer only feeds the immediate resume.

## Components touched

- `packages/core/src/types/chat.ts` — add `PendingTeamState` and `Chat.pendingTeam`.
- `packages/core/src/manager.ts` — add `userClarification` to `ManagerInput`, render it in `buildManagerPrompt`.
- `packages/core/src/utils/` (new file `ask-user.ts`) — `parseAskUser` helper + tests.
- `packages/core/src/workers.ts` (worker prompt template) — add the ASK_USER instruction line to the standard worker prompt.
- `packages/gateway/src/gateway.ts` —
  - Pre-dispatch hook for paused chats in the user-message entry point.
  - Refactor `runAllMembersInOrder` and the chat-stream sequential loop into a shared helper that supports a resume entry point.
  - `runManagerLoop` gains a sibling `resumeManagerLoop` (or accepts a resume seed).
  - `runOneWorker` callsites parse output for the marker before recording the part.
- `packages/gateway/src/chats.ts` — persist `pendingTeam` (already serializes the Chat struct; just round-trip the new field).
- Mac UI — no changes; messages flow through existing channels.

## Testing

- Unit: `parseAskUser` — marker present mid-output, only marker, no marker, multiple markers (first wins), marker with leading whitespace, marker with empty question (treat as no-marker / log warning).
- Unit: `buildManagerPrompt` renders `userClarification` only when set.
- Integration (gateway): sequential team where worker 2 of 3 emits the marker → run pauses, pending state persists, user reply re-runs worker 2 with answer in prompt, then advances to worker 3.
- Integration (gateway): auto team where worker emits marker → Manager loop pauses, resume injects clarification, Manager picks next, run continues.
- Integration: slash command during pause clears state and proceeds; user gets the cancellation notice.
- Integration: starting a new `/team` while paused clears prior pending and runs the new team.

## Migration / compatibility

- New optional field on `Chat`; existing serialized chats deserialize unchanged.
- Worker personalities without the new instruction still work — they just never emit the marker, behavior unchanged from today.
- No protocol/wire changes for channels.
