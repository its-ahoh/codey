# Team runs as per-worker chat messages — design

**Date:** 2026-06-20
**Status:** Approved (design)
**Surface:** `codey-mac` Mac app (chat surface only); backend `packages/gateway`, `packages/core`

## Problem

A team run (multiple workers in `sequential` / `graph` / `auto` / `parallel` mode)
currently produces **one** assistant `ChatMessage`. Its `content` is a combined
transcript parsed post-hoc into per-worker "steps" (`parseTeamMessage`), and its
`toolCalls` is a flat stream of `info` markers + `tool_start`/`tool_end` across
every worker. In the context panel's **Tools** view this is unreadable for an
8-worker run: every worker's tool calls (including file edits already shown in
the **Files** tab) are interleaved into one wall.

## Goal

Render a team run as a **team chat**: each worker produces its **own** assistant
message with its own output, its own `toolCalls`, and its own thinking. Opening a
worker's message shows only that worker's tools/files. Worker messages of one run
are grouped under a collapsible team-run header.

Confirmed decisions:

- **Parallel mode:** pre-create one bubble per worker; every streaming event
  carries a worker id so concurrent events route to the right bubble. This worker
  id is the universal routing key across all modes.
- **Grouping:** worker messages share a `teamTurnId` and render under a
  `Team: X · mode` header, each captioned with the advisor's routing reason.
- **Identity & persistence (Approach A):** the backend assigns each worker
  message's id and persists incrementally (stub on start, patch on end), so live,
  reload, and `[ASK_USER]` resume all share one identity model.
- **No summary bubble:** a team run is just its worker bubbles. No synthesized
  summary/roundtable-digest message.

Non-goals: changing channel surfaces (Telegram/Discord/iMessage stay linear
text), data migration of old chats, or altering team execution logic itself.

## Architecture

### 1. Event contract (`packages/gateway/src/chat-runner.ts`)

The routing key for every per-worker event is a **backend-authoritative
`messageId`**.

New / changed `ChatStreamEvent` variants:

- `team_start` — `{ type, chatId, teamTurnId, teamName, mode, workers?: Array<{ messageId, step, worker, agent?, model? }> }`.
  Carries the full worker list up front when known (`sequential` / `graph` /
  `parallel`); omitted or empty for `auto`, whose set is decided dynamically.
- `worker_start` — `{ type, chatId, teamTurnId, messageId, step, worker, agent?, model?, reason? }`.
  Idempotent create-if-absent — the lazy signal for `auto` picks and revisions.
  `reason` is the advisor routing caption.
- `worker_end` — `{ type, chatId, messageId, step, status: 'done' | 'failed' | 'askedUser', tokens?, durationSec? }`.
- `stream`, `thinking`, `tool_start`, `tool_end` gain `messageId` (plus `step` /
  `worker` for display). `messageId` is what lets parallel interleave route
  correctly; the existing `step` on `thinking` is subsumed by this.
- `done` no longer carries the chat message body. It finalizes the turn (title,
  completion); it may reference `teamTurnId` but appends nothing new.

### 2. Persisted `ChatMessage` shape (`packages/core` types + `codey-mac/src/types`)

Each worker bubble is a normal assistant `ChatMessage` with its own `content`,
`toolCalls`, `thinking`, `tokens`, `durationSec`, plus new **optional** fields:

- `teamTurnId?: string` — groups the worker bubbles of one team run.
- `teamName?: string`
- `teamMode?: 'sequential' | 'graph' | 'auto' | 'parallel'`
- `step?: number`
- `worker?: string`
- `workerStatus?: 'running' | 'done' | 'failed' | 'askedUser'`
- `advisorReason?: string` — the routing caption shown on the bubble.

**Back-compat:** legacy team turns are a single combined message with no
`teamTurnId`. The renderer keeps the existing `parseTeamMessage` step-card path as
a fallback for any message lacking `teamTurnId`. No data migration.

### 3. Backend run path (`gateway.ts runTeamForChat` + team runners)

- Mint a `teamTurnId` at run start.
- Replace the single accumulating sink with a per-worker emitter:
  - **Worker begin:** `messageId = randomUUID()`; `chatManager.appendMessage` a
    stub (`workerStatus: 'running'`, `step`, `worker`, `advisorReason`,
    `teamTurnId`, `teamName`, `teamMode`); emit `worker_start`.
  - **During:** route that worker's agent events tagged with its `messageId`;
    emit `stream` / `thinking` / `tool_start` / `tool_end` with `messageId`.
  - **Worker end:** `chatManager.updateMessage(chatId, messageId, patch)` with
    final `content`, `toolCalls`, `thinking`, `workerStatus`, `tokens`,
    `durationSec`; emit `worker_end`.
- **Parallel:** emit `team_start` with all worker `messageId`s up front (append
  all stubs), then `ParallelTeamRunner` routes each worker's events by
  `messageId`.
- **Channels stay linear:** `runTeamForChat` still builds and returns the
  combined `output` string for Telegram/Discord/iMessage mirroring and for
  `pendingTeam` / `[ASK_USER]` choice parsing. Only the **Mac chat persistence**
  switches from one combined message to N worker messages. The single-append at
  `gateway.ts:4268` is bypassed for team-on-chat runs (the worker messages are
  appended by the emitter instead); the `done` event still fires once.

New store method: `chatManager.updateMessage(chatId, messageId, patch: Partial<ChatMessage>)`
in `packages/gateway/src/chats.ts` — locate by id, shallow-merge, `persist`.

### 4. Resume / `[ASK_USER]`

The asking worker's stub already exists (created at `worker_start`, persisted with
its partial output and `workerStatus: 'askedUser'`). `pendingTeam` continues to
track step/worker. On resume, the shared `TeamEmitter` continuation path
(`team-emitter.ts`) continues into that **same** `messageId`; subsequent workers
append as new messages. A reload during the pause already shows every completed
worker bubble.

### 5. Mac renderer (`codey-mac/src/hooks/useChats.tsx`)

- New in-flight model per chat: a `teamTurnId` plus the set of worker
  `messageId`s, instead of a single `assistantMessageId`.
- New reducer actions `teamStart` / `workerStart` / `workerEnd`. `workerStart`
  appends a stub using the backend's `messageId` (no local `asst-…` id, no
  dual-id reconciliation). `streamToken` / `thinkingToken` / `toolCall` switch
  from targeting `fl.assistantMessageId` to `action.messageId`.
- Non-team chats keep the existing single-message path unchanged.

### 6. Chat rendering (`codey-mac/src/components/ChatTab.tsx`)

- Consecutive assistant messages sharing a `teamTurnId` render inside one
  collapsible **team-run group** (header: `Team: X · mode`).
- Each worker bubble shows: worker name, `advisorReason` caption, Markdown
  output, and a running indicator while `workerStatus === 'running'`.
- Each worker bubble is **independently selectable** → opens the context panel
  scoped to that message.
- The combined-step `TeamMessage` renderer stays as the legacy fallback for
  messages without `teamTurnId`.

### 7. Context panel + flow overlay (`ChatContextPanel`, `TeamRunFlow`, `teamRunModel`)

- `deriveWorkerRuns` is refactored to build runs from the worker-message **group**
  (messages sharing `teamTurnId`) instead of parsing one content string.
- `toolCallsForStep` becomes "the selected worker message's own `toolCalls`."
- The **Tools** tab for a selected worker is now naturally scoped and short —
  this resolves the original complaint. The **Files** tab is unchanged (it
  already aggregates file changes across the whole chat).
- The "View flow" overlay derives nodes/statuses from the group.

### 8. File-edit rows in the per-worker Tools list

With per-worker scoping the Tools list is short, so we **keep** listing each
worker's tool calls including file edits, and continue to rely on the Files tab
for diffs. (Considered and rejected for now: hiding `Read`/`Edit`/`Write` rows —
unnecessary once scoped, and removes the per-worker "what did it touch" signal.)

## Data flow (new)

```
runTeamForChat (mode-specific runner)
  teamTurnId = uuid
  ── team_start { teamTurnId, mode, workers? }
  for each worker run:
      messageId = uuid
      chatManager.appendMessage(stub: running)   ── worker_start { messageId, step, worker, reason }
      agent stream  ───────────────────────────── stream/thinking/tool_* { messageId }
      chatManager.updateMessage(messageId, final) ── worker_end { messageId, status }
  ── done            (title/completion only; channels get combined `output`)
        │
        ▼  IPC chats:event  →  preload  →  useChats reducer
  teamStart → record group
  workerStart → append stub by backend messageId
  stream/thinking/toolCall → route by action.messageId
  workerEnd → set workerStatus
        │
        ▼
  ChatTab groups by teamTurnId → one collapsible team-run block, N selectable bubbles
```

## Testing

Vitest across the three workspaces:

- `packages/gateway`: `chatManager.updateMessage` locates + patches + persists;
  the team emitter appends a stub on begin and patches on end; `worker_start` /
  `worker_end` carry stable matching `messageId`s; channel `output` string is
  still produced.
- `packages/core` / model: `deriveWorkerRuns` builds correct runs from a
  worker-message group; status derivation (running/done/failed/askedUser).
- `codey-mac`: reducer routes interleaved `stream`/`tool` events to the correct
  message by `messageId` under a simulated parallel run; legacy single-message
  team turn still renders via the `parseTeamMessage` fallback.

## Risks / open points

- **Reload reconciliation:** because worker `messageId`s are backend-authoritative
  and persisted incrementally, a reload mid-run returns exactly the persisted
  bubbles — no id drift. The only gap is events in flight at the instant of
  reload, identical to today's single-message behaviour.
- **Auto-mode revisions:** a worker revisited by the advisor produces a second
  bubble (new `step`, new `messageId`) later in the group — intended.
- **`team_start` for `auto`:** workers are unknown up front, so stubs are created
  lazily via `worker_start`; the renderer must handle both pre-created (parallel)
  and lazily-created (auto) stubs uniformly.
