# Quick Question (QQ) — Design

**Date:** 2026-06-02
**Status:** Approved (pending spec review)

## Summary

Add a **Quick Question** feature to the Codey macOS app: a read-only side-thread
that answers questions using the current chat's content as context, **without
interfering** with the main chat's history, CLI session, or cross-channel
mirroring. It surfaces as a third tab — "Quick Question" — in the right-side
`ChatContextPanel`, alongside the existing **Tools** and **File changes** tabs.

It is reachable three ways:
- The "Quick Question" tab in the right panel.
- Typing `/qq <question>` in the main composer (submits one QQ turn; never added
  to the chat).
- Typing a bare `QQ` (case-insensitive, the entire input) in the main composer —
  opens the panel and switches to QQ mode, ready to chat.

## Goals

- Ask questions / do small read-only lookups grounded in the current chat.
- Zero side effects on the main chat: no new messages, no session-anchor changes,
  no channel mirroring, no persistence.
- A multi-turn QQ thread that itself carries context (so follow-ups work).

## Non-Goals

- Persisting QQ threads to disk (explicitly ephemeral / in-memory).
- Letting QQ write or edit files (read-only).
- QQ on channel surfaces (Telegram/Discord/iMessage) — Mac app only for now.

## Locked Decisions

| Decision | Choice |
|---|---|
| Capability | **Read-only Q&A** — restricted to read tools |
| Persistence | **Ephemeral, in renderer memory**; cleared on app restart |
| Context per turn | **Parent chat history (read-only reference) + the QQ thread's own prior turns** (multi-turn) |
| Model | **Aide** agent/model if configured, else the chat's effective agent/model |
| UI placement | **Third tab** "Quick Question" in `ChatContextPanel` |

### Smaller calls (sensible defaults)

- Read tool allowlist: `Read, Grep, Glob, LS, WebFetch, WebSearch` (no `Bash`).
- Bare-`QQ` trigger: case-insensitive, only when it is the *entire* trimmed input.
- QQ threads persist across chat-switching within a session (one thread per
  chatId), cleared on app restart.

## Architecture

### Backend — `packages/gateway/src/gateway.ts`

New method:

```ts
runQuickQuestion(
  chatId: string,
  question: string,
  qqHistory: Array<{ role: 'user' | 'assistant'; content: string }>,
  sink: (e: QQStreamEvent) => void,
  signal: AbortSignal,
): Promise<{ response: string; tokens?: number; durationSec?: number }>
```

Behavior:
1. Load the chat read-only; resolve `workingDir` from its `workspace.json`
   (same logic as the normal chat-send path).
2. Resolve agent/model via `getAideAgentAndModel()` (promoted to `public`):
   uses `config.aide` when set, otherwise the chat's effective agent/model
   (`chat.agent` / `chat.model` override → gateway default).
3. Build an ephemeral prompt (see Prompt Shape).
4. Run via `runWithFallback` with:
   - **no** `resumeSessionId` and **no** `newSessionId` (fully fresh; leaves no
     session anchor on the chat),
   - `allowedTools` set to the read-only allowlist,
   - `skipPermissions: true` (so it never blocks on a prompt; the allowlist is
     what bounds it),
   - `onStream`/`onStatus` wired to `sink`.
5. **Does not** call `chatManager.appendMessage`, `setSessionAnchor`, persist,
   or mirror to channels.

`QQStreamEvent` mirrors the relevant subset of `ChatStreamEvent` but carries a
`qqId` (the chatId it belongs to) and is emitted on a separate channel so QQ
tokens never collide with the main chat stream.

### Read-only enforcement — `packages/core/src/types.ts` + adapters

- Add optional `allowedTools?: string[]` to `AgentRequest`.
- `claude-code` adapter: when present, push `--allowedTools "<space-joined>"`.
  Combined with `--dangerously-skip-permissions`, the CLI can use only the
  listed tools and never prompts. This is a hard guarantee.
- `codex` / `opencode` adapters: no native allowlist flag. Enforce read-only via
  a strong read-only system instruction prepended to the prompt. **Known
  limitation:** weaker guarantee than claude-code; documented, acceptable for v1.

### IPC — `electron/main.ts`, `electron/preload.ts`, `src/services/api.ts`

- `main.ts`: `ipcMain.handle('qq:ask', …)` calling `gateway.runQuickQuestion`,
  forwarding stream events to the renderer via a dedicated `qq:event` webContents
  channel; `ipcMain.handle('qq:stop', …)` to abort an in-flight QQ run.
- `preload.ts`: expose `window.codey.qq.ask(...)`, `qq.stop(...)`,
  `qq.onEvent(...)`.
- `api.ts`: `apiService.qq = { ask, stop, onEvent }`.
- Register `/qq` in the gateway slash-command list returned to the renderer so it
  appears in the existing slash menu (`agents:slashCommands` path / gateway
  commands, near the `clear`/`compact` entries in `main.ts`).

### Frontend

**State (`src/hooks/useChats.tsx` / `ChatsProvider`)**
- In-memory map: `qqThreads: Record<chatId, QQThread>` where
  `QQThread = { messages: QQMsg[]; inFlight: boolean }` and
  `QQMsg = { id; role: 'user' | 'assistant'; content: string; streaming?: boolean }`.
- Actions: `askQuickQuestion(chatId, question)`, `stopQuickQuestion(chatId)`,
  and a `qq:event` subscription (set up alongside the existing `chats.onEvent`
  subscription) that appends/streams into the right thread.
- Independent of the main `flight` state, so a running chat never blocks QQ and
  vice versa.

**`src/components/ChatContextPanel.tsx`**
- Add a `'qq'` value to the tab state (`'current' | 'files' | 'qq'`) and a third
  tab button "Quick Question".
- New `QuickQuestionView` sub-component: a mini chat — scrollable QQ message list
  + a composer (textarea + send/stop). Reads/writes the chat's `qqThread` via
  props/hook. Renders assistant output with the existing `Markdown` component.
- Panel needs the `chatId` (and a way to reach QQ state/actions) — thread the
  needed props from `ChatTab` (which already owns the panel and `useChats`).

**Triggers — `src/components/ChatTab.tsx` `send()`**
- Before the normal send:
  - If `input.trim().toLowerCase() === 'qq'`: open the panel
    (`setContextPanelOpen(chat.id, true)`), switch panel tab to `'qq'`, focus the
    QQ composer, clear the input. Nothing sent to the chat.
  - If `input` matches `/^\/qq(\s|$)/i`: strip the `/qq` prefix; open panel +
    switch to `'qq'`; call `askQuickQuestion(chat.id, remainder)`; clear input.
    If remainder is empty, behave like the bare-`QQ` case (just open the tab).
- The active panel tab currently lives as local state inside `ChatContextPanel`.
  Lift it to `ChatTab` (or expose a controlled `tab`/`onTabChange` prop) so the
  triggers can switch it.

## Prompt Shape

```
[Main chat — read-only reference; do not continue or modify it]
<buildChatPrompt-style windowed transcript of chat.messages, incl. compaction summary>

[Quick Question thread so far]
[user] …
[assistant] …

[New quick question — answer using the reference above. You are READ-ONLY:
you may inspect files and search, but must not modify anything.]
<question>
```

The main-chat block reuses the existing windowing + compaction-summary logic from
`buildChatPrompt` (extract a shared helper rather than appending a real user
turn).

## Data Flow

```
/qq … or QQ-tab input
  → apiService.qq.ask(chatId, question, qqHistory)
  → ipc 'qq:ask' → gateway.runQuickQuestion
  → runWithFallback (read-only, fresh session)
  → 'qq:event' stream → renderer appends/streams into qqThreads[chatId]
```

## Error Handling

- Workspace missing / model unresolvable: emit a `qq` error event; show inline in
  the QQ view. Never throws into the main chat.
- Abort via `qq:stop` (AbortController per chatId QQ run); finalizes the
  streaming QQ assistant message with whatever was received.
- QQ runs share the existing run semaphore? **No** — QQ uses its own lightweight
  path and should not consume the main chat semaphore slots (so it can't starve
  or be starved by chat turns). It still respects an internal cap if needed, but
  v1 runs unbounded per chat (one in-flight QQ per chat enforced client-side via
  `inFlight`).

## Testing

No test runner is configured in this repo, so verification is manual:
- `/qq what files were changed?` → answers in QQ tab; main chat history unchanged;
  no session anchor created.
- Bare `QQ` → opens panel on the QQ tab, empty thread.
- Multi-turn: a follow-up QQ references the earlier QQ answer.
- Running a QQ while the main chat is streaming does not interrupt either.
- Attempt to get QQ to write a file → refused / not possible (claude-code).
- App restart → QQ threads are gone (ephemeral).

## Known Limitations

- Read-only is a hard guarantee only on `claude-code` (`--allowedTools`); on
  `codex`/`opencode` it is prompt-enforced.
- QQ threads are not persisted by design.
