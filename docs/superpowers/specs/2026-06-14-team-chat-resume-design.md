# Team Chat Resume (Emitter Abstraction) — Design

**Date:** 2026-06-14
**Status:** Approved (brainstorming complete, ready for implementation plan)
**Follow-up to:** PR #134 (Sequential flow graphs) — branch `feat/sequential-flow-graph`

## Summary

Make mid-flow `[ASK_USER]` **resume work on the chat / Mac-app surface** for every
team mode that pauses (`sequential`, `auto`, `graph`). Today resume only works on
unlinked channels: `resumeTeamFromAnswer` emits exclusively via `sendResponse`,
which is a no-op when no channel handler is registered (the Mac-app/linked path),
and it never persists the assistant message to the chat. The `sendToChat` entry
point has no pending-team detection at all, so a flow paused there restarts on the
next turn.

The fix introduces a `TeamEmitter` abstraction so one continuation path serves both
the channel surface (`sendResponse`) and the chat surface (`sink` + return string),
collapses the duplicated void/sink executors into single emitter-parameterized
ones, and wires pending-team detection + assistant-message persistence into
`sendToChat`.

## Goals

- `[ASK_USER]` pause → user answers in the Mac app → the SAME run resumes in place,
  for `sequential`, `auto`, and `graph` modes.
- Resumed output streams to the Mac UI and is persisted as the chat's assistant
  message (survives reload).
- No regression to the existing channel (Telegram/Discord/iMessage) resume path.
- Remove the void/sink executor duplication introduced across team modes (one
  emitter-parameterized executor per mode + thin wrappers).

## Non-Goals

- `parallel` mode: it uses a separate roundtable pause mechanism (not
  `persistPendingTeam`) and is out of scope.
- No change to how a team run *first* pauses (that already persists `pendingTeam`
  on both surfaces). This work is about *resuming*.

## Root Cause (verified)

- `sendResponse` (`gateway.ts`): `const handler = this.handlers.get(response.channel); if (!handler) return;` — for a Mac-originated chat there is no handler, so all
  `resumeTeamFromAnswer` output is dropped.
- `resumeTeamFromAnswer` is called only from `handleMessage` (`gateway.ts:947`),
  never from `sendToChat`.
- `resumeTeamFromAnswer` does not persist a chat assistant message.

## Architecture

### `TeamEmitter`

```ts
interface TeamEmitter {
  /** A discrete status / result / ASK_USER message to the user. */
  notify(text: string, choices?: string[]): Promise<void>;
  /** Per-worker streaming, handed to runOneWorker. */
  onStream(token: string): void;
  onThinking(token: string, step: number): void;
  /** Assistant transcript accumulated for the chat-return contract. '' for channels. */
  readonly transcript: string;
}
```

Two implementations (a new `packages/gateway/src/team-emitter.ts`):

- **`ChannelEmitter(gateway-callbacks, chatId, channel)`** — `notify` → `sendResponse`;
  `onStream` → `handler.streamText`; `onThinking` → no-op (channels don't render
  thinking today); `transcript` stays `''`. Behavior-identical to today's void
  executors.
- **`ChatEmitter(sink, chatId)`** — `notify(text, choices)` → `sink({type:'stream', chatId, token:text})` and records the text into the transcript parts; `onStream` →
  `sink({type:'stream'})` + accumulate; `onThinking` → `sink({type:'thinking'})`;
  `transcript` joins the recorded parts. Behavior-identical to today's sink
  executors. Holds the latest `choices` so the chat return can surface them.

To keep the emitters decoupled from the `Gateway` class, the constructors take the
small set of callbacks/handles they need (e.g. a `sendResponse` bound method and the
channel `handler` lookup for `ChannelEmitter`; the `sink` for `ChatEmitter`) rather
than the whole gateway.

### Executor refactor (collapse void/sink duplication)

- **Graph:** `continueGraphRun` gains a `TeamEmitter` param and emits the header,
  step lines, judge reasons, capped warning, and final results through it.
  `runSequentialGraphForChat` (channel) and `runSequentialGraphForChatSink` (chat)
  become thin wrappers: construct the emitter → `startRun` → `continueGraphRun(emitter)`
  → return `emitter.transcript`. The duplicated walk body in
  `runSequentialGraphForChatSink` is deleted.
- **Sequential:** `runAllMembersInOrder` gains a `TeamEmitter` param; the inline
  linear loop in `runTeamForChat` is replaced by a call to it with a `ChatEmitter`.
- **Auto:** `runAdvisorLoop` already drives both surfaces via a message callback;
  its user-facing emissions route through the `TeamEmitter` so the resume tail and
  both fresh paths share one implementation.
- `runOneWorker` already accepts `onStream`/`onThinking`; these are sourced from
  `emitter.onStream`/`emitter.onThinking`.

### Resume integration in `sendToChat`

- `resumeTeamFromAnswer(message, pending, answer, emitter: TeamEmitter): Promise<string>`
  — its three branches (`sequential` / `graph` / `auto`) emit through `emitter` and
  call the emitter-based executors. Returns `emitter.transcript`.
- The existing `handleMessage` call site passes a `ChannelEmitter` (behavior
  preserved).
- At the **top of `sendToChat`** (after `chat` is loaded), mirror `handleMessage`'s
  pending handling:
  1. `const pending = chat.pendingTeam;`
  2. resolve a choice digit in `userText` against `pending.options` (reuse
     `resolveChoiceDigit`);
  3. if `userText` is a slash command → clear pending, `notify` a cancel notice,
     fall through to normal turn handling;
  4. otherwise → clear pending, build `ChatEmitter(sink, chatId)`, call
     `resumeTeamFromAnswer(message, pending, userText, emitter)`, persist the
     returned transcript as the chat's assistant message via `sendToChat`'s existing
     user/assistant persistence, and `return { response: transcript, chatId }`.

  Note the `sendToChat` rate-limit/semaphore wrapping still applies; pending
  detection happens inside `sendToChat` after `chat` load and before the normal
  prompt-building path.

## Data Flow

```
Mac app answer → IPC → sendToChat(chatId, answer, sink)
  → detect chat.pendingTeam → ChatEmitter(sink)
  → resumeTeamFromAnswer(..., emitter)
       → [sequential] runAllMembersInOrder(emitter, startIndex…)
       → [graph]      continueGraphRun(emitter, restored state, {question,answer})
       → [auto]       runAdvisor(userClarification) + emitter-based step loop
  → emitter.transcript → persist as assistant message → return {response}
```

## Error Handling

- Semantics unchanged, but routed through `notify` so they reach whichever surface:
  advisor fallback on resume, worker failure on resume, dropped run when the team/
  graph no longer exists (also clears the stale `pendingTeam`).
- `ChatEmitter`/`ChannelEmitter` swallow downstream emit errors the same way the
  current `sink`/`sendResponse` call sites do.

## Testing

- Unit: `ChannelEmitter` and `ChatEmitter` — `notify` (with/without choices),
  `onStream`/`onThinking`, and `transcript` accumulation; `ChannelEmitter.transcript`
  stays `''`.
- Unit/integration: a scripted `resumeTeamFromAnswer` over a `ChatEmitter` for each
  mode (with stubbed worker/judge/advisor runners) asserting the produced transcript
  and surfaced choices; and that a `ChannelEmitter` resume still calls `sendResponse`.
- `tsc --noEmit` clean for `packages/gateway`; full gateway + core + mac vitest
  suites stay green (no regression to channel resume or fresh runs).
- Manual: in the Mac app, pause a `graph` flow on `[ASK_USER]`, answer, confirm the
  run resumes in place and the assistant message persists across a reload; repeat
  for `sequential` and `auto`.

## Implementation Staging (bounds regression risk)

1. `TeamEmitter` + `ChannelEmitter` + `ChatEmitter` (+ unit tests).
2. Graph: `continueGraphRun` onto the emitter; collapse the two graph executors into
   wrappers; delete the duplicated sink walk.
3. Sequential: `runAllMembersInOrder` onto the emitter; replace `runTeamForChat`'s
   linear loop.
4. Auto: route `runAdvisorLoop` user emissions through the emitter; update the auto
   resume tail.
5. `resumeTeamFromAnswer` takes the emitter; wire pending-detection + assistant
   persistence into `sendToChat`; pass `ChannelEmitter` at the `handleMessage` site.

Each stage compiles and keeps the existing suites green before moving on.

## Open Risks

- Touching the working channel path and the working chat fresh-run path for all
  modes. Mitigation: behavior-preserving emitters (each mirrors today's exact
  emit calls), mode-by-mode staging, and the existing gateway test suite as a
  regression net.
- Subtle differences between the void and sink fresh-run executors (e.g. output
  truncation, step labels) must be preserved by whichever emitter — call these out
  during implementation so the collapse doesn't silently change user-visible output.
