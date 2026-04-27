# Multi-Chat for the Codey Mac App

**Status:** Design
**Date:** 2026-04-24
**Scope:** Codey Mac app (`codey-mac/`) + Gateway (`packages/gateway/`)

## Summary

Today the Mac app presents a single chat surface tied to an ephemeral
`conversationId`. This design adds persistent, parallel, many-per-workspace
chats, surfaced as a left-side chat list. The existing tab-bar navigation
(Workers / Workspaces / Status / Settings) collapses behind a single
Settings button pinned at the bottom of the chat list.

Key properties:

- **Persistent.** Each chat is a disk-backed entity under its owning
  workspace; chats survive gateway and app restarts.
- **Parallel.** Multiple chats can be sending concurrently. Switching
  chats does not interrupt any in-flight send.
- **Many-per-workspace.** A workspace can own any number of chats; a chat
  belongs to exactly one workspace.
- **Backend-owned.** Chats are first-class in the gateway, not a frontend
  convenience. This keeps the door open for Telegram/Discord surfaces
  without reshaping the data model later.

## Data Model

One JSON file per chat, scoped under the owning workspace:

```
workspaces/<workspaceName>/chats/<chatId>.json
```

Schema:

```ts
type ChatSelection =
  | { type: 'none' }
  | { type: 'worker'; name: string }
  | { type: 'team' }

type ChatMessage = {
  id: string
  role: 'user' | 'assistant'
  content: string
  timestamp: number
  toolCalls?: ToolCallEntry[]
  tokens?: number
  durationSec?: number
  isComplete?: boolean
}

type Chat = {
  id: string              // uuid
  title: string           // auto from first user msg; user-renameable
  workspaceName: string
  selection: ChatSelection
  messages: ChatMessage[]
  createdAt: number
  updatedAt: number
}
```

### Write strategy

- The whole chat file is rewritten on every `isComplete` message, on
  rename, on delete, and on selection change.
- Streaming assistant deltas update in-memory only; a single write at
  completion persists the final message. This bounds disk I/O to one
  write per turn, which is already negligible next to agent latency.
- File writes use a write-to-tempfile + `rename` pattern for atomicity.

### Agent context window

When sending, the gateway replays the last **40** messages of the chat
(default, configurable via `gateway.json`). This replaces today's
`ConversationManager` cap of 10. The cap protects against unbounded
prompts on long-running chats; 40 is plenty for typical threads.

### Cascading deletes

Deleting a workspace deletes its `chats/` directory. Orphan detection
(workspace deleted out from under the gateway) is handled in the UI (see
Error Handling).

## Backend

### `ChatManager` — `packages/gateway/src/chats.ts`

Singleton, analogous to `ConversationManager` but durable.

API:

- `list(workspaceName?: string): Chat[]` — when no workspace, returns all
  chats grouped by workspace, newest-updated first.
- `get(chatId: string): Chat | undefined`
- `create({ workspaceName, selection }): Chat`
- `rename(chatId, title): Chat`
- `delete(chatId): void`
- `updateSelection(chatId, selection): Chat`
- `appendMessage(chatId, msg)` — internal; called by the send path on
  message completion.

Startup: lazily load on first `list` by scanning
`workspaces/*/chats/*.json`. Keep in memory after first read. Corrupt
files are skipped with a warning log.

### Gateway send path — `packages/gateway/src/gateway.ts`

New method:

```ts
sendToChat(chatId: string, userText: string, stream: Stream): Promise<Result>
```

Flow:

1. Resolve chat; resolve workspace → `workingDir`.
2. Build prompt from the last 40 persisted messages + the new user
   message; apply the existing worker/team prompt assembly based on
   `chat.selection`.
3. Spawn agent adapter via `AgentFactory`, bound to `workingDir`.
4. Pipe `tool_start` / `tool_end` / text deltas to `stream`, each
   tagged with `chatId`.
5. On completion: append user + assistant messages to the chat via
   `ChatManager.appendMessage`; persist; return the final payload.

### Concurrency

- Per-chat sends run in parallel. No shared mutex.
- A soft cap `MAX_CONCURRENT_AGENTS` (default **4**) is enforced via a
  simple semaphore. Extra sends queue; queued sends emit a
  `queued(position)` event to the stream so the UI can show a status.
- Today's 10-second rate-limit cooldown moves from global to per-chat.

### Team execution

When `selection.type === 'team'`, reuse the existing `runTeam` path.
Per-step updates stream through the same chat stream with a step-prefix
in the message, so the final assistant message aggregates team output
into one turn.

### IPC / HTTP API

Expose identical surfaces over Electron IPC and the existing HTTP
gateway so Mac and future headless use stay symmetric:

- `chats:list(workspaceName?)`
- `chats:create({ workspaceName, selection })`
- `chats:get(id)`
- `chats:rename(id, title)`
- `chats:delete(id)`
- `chats:updateSelection(id, selection)`
- `chats:send(id, text)` — streaming; each event carries `chatId` so
  the UI routes updates to the right chat even while the user is
  viewing a different one.

### Deprecations

`ConversationManager` stays unchanged for Telegram/Discord channels.
The Mac app no longer uses the ephemeral `conversationId` path; it
always goes through `chats:send`.

## Frontend (Mac app)

### Layout

The 60px icon rail is removed. The left panel becomes a chat list
(~240px). A single **Settings** button pinned at the bottom opens the
existing multi-tab config UI (Workers / Workspaces / Status / Settings)
as a full-surface overlay over the chat area; `X` or `⎋` returns to the
chat view.

```
┌──────────────────────────────────────────────────────┐
│  Codey · <workspace name of active chat>             │
├────────────────┬─────────────────────────────────────┤
│ [+ New Chat]   │  <active chat view — ChatTab>       │
│                │                                     │
│ ▸ Workspace A  │                                     │
│   · Chat 1 •   │   (• = pulsing dot: in-flight send) │
│   · Chat 2     │                                     │
│ ▸ Workspace B  │                                     │
│   · Chat 3     │                                     │
│                │                                     │
│ ────────────   │                                     │
│ ⚙ Settings     │                                     │
└────────────────┴─────────────────────────────────────┘
```

### Chat list UX

- Grouped by workspace (collapsible headers). Within a group,
  newest-updated first.
- Active chat highlighted; chats with in-flight sends show a pulsing
  dot.
- Hover → X icon to delete (confirm dialog).
- Double-click title → inline rename.
- `+ New Chat` creates a chat bound to the last-used workspace, selects
  it, focuses the input. Workspace is changeable from inside the chat
  view before or after the first message.

### Component changes

- `App.tsx` — drop the icon rail and `TabType`. Replace with
  `ChatListPanel`, a `selectedChatId`, and a `settingsOpen` boolean.
- `components/ChatListPanel.tsx` (new) — renders grouped chats, the
  `+ New Chat` button, and the Settings button. Talks to
  `apiService.chats.*`.
- `components/SettingsOverlay.tsx` (new) — wraps today's
  `WorkspacesTab` / `WorkersTab` / `StatusTab` / `SettingsTab` with an
  inner tab bar; covers the chat area when open.
- `components/ChatTab.tsx` — refactored to take `chatId` as prop. All
  chats stay mounted (same trick as today's single-chat persistence)
  so parallel sends continue streaming while the user switches chats.
  Top bar gains: workspace label (click to change), selection dropdown
  (workers + "Team"), title.
- `hooks/useChats.ts` (new) — global store (React context) holding
  `chats: Record<chatId, Chat>`, streaming states, and dispatches for
  chat events received from the backend. A single IPC subscription
  fans out to views by `chatId`.

### State routing

The streaming IPC handler dispatches by `chatId` into the global
store, not into local component state. This is the mechanism that
makes "send in A, switch to B, both keep updating" work: the store is
the source of truth; every `ChatTab` is a view.

### Chat titles

Auto-title from the first user message (first ~40 chars, trimmed).
Renameable via double-click. LLM-generated titles are out of scope.

### UI state persistence

`localStorage`:

- `codey.activeChatId` — restored on launch.
- `codey.collapsedWorkspaces` — remembered across sessions.
- `settingsOpen` — **not** persisted; always false on launch.

### Keyboard (nice-to-have)

- `⌘N` — new chat.
- `⌘,` — open Settings overlay.
- `⌘1..9` — jump to nth chat.

Defer if scope pressure; non-blocking.

## Error Handling

| Case                        | Behavior                                                                        |
| --------------------------- | ------------------------------------------------------------------------------- |
| Agent send failure          | Error attached to the chat's assistant message; persisted in history.           |
| Agent timeout (5min)        | Same as today; marks message complete with an error tool-call entry; persisted. |
| Corrupt chat JSON on load   | Skip with a warning log; toast in UI; do not crash the chat list.               |
| Workspace deleted externally | Chat marked orphaned in the list (greyed, "Workspace deleted"). Offer "delete chat" / "reassign workspace". No sends allowed. |
| Concurrency cap hit         | Send goes to queue; chat shows "Queued (#N in line)"; FIFO dequeue.            |

## Migration

No existing persisted chats. First launch on the new build shows an
empty chat list; `+ New Chat` is the entry point. No data-migration
code needed.

## Testing

No test runner is configured in the repo. Verification is manual:

- Create two chats in different workspaces; send in both; verify
  concurrent streaming.
- Kill the gateway mid-stream; restart; verify completed messages are
  restored and the in-flight one is marked errored; history intact.
- Delete a workspace; verify its chats are removed from disk and from
  the list.
- Rename a chat; reload the app; verify the title persists.
- Switch selection to "Team" mid-chat; verify the next send routes
  through the team path.

## Rollout

Single feature branch off `feat/codey-mac-app`. Phased commits:

1. Backend: `ChatManager` + file persistence (plus a small script to
   exercise it manually).
2. Backend: `chats:*` IPC/HTTP endpoints + streaming with `chatId`.
3. Frontend: `useChats` store + `ChatListPanel` + `SettingsOverlay` +
   `App.tsx` reshuffle.
4. Frontend: `ChatTab` refactor to `chatId`-keyed.
5. Polish: rename UX, delete confirmation, concurrency-cap UI, orphan
   handling.

## Out of Scope (Deferred)

- LLM-generated chat titles.
- Chat search.
- Chat archive (vs. delete).
- Keyboard shortcuts beyond `⌘N` / `⌘,` / `⌘1..9`.
- Surfacing chats to Telegram/Discord. The schema supports it; wiring
  is a follow-up.
- Drag-reorder chats; drag between workspaces.
