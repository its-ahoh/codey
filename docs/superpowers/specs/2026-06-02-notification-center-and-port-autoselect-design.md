# Notification Center + Gateway Port Auto-Select — Design

**Date:** 2026-06-02
**Status:** Approved, ready for implementation plan

## Background

The macOS app (`codey-mac/`) auto-starts the in-process gateway on launch, so the
top-right **"Running"** pill in `App.tsx` is now redundant — and it's actually a
static label (it always renders "Running" regardless of gateway state). Separately,
the gateway's HTTP `ApiServer` binds a fixed port (`gateway.json` → `gateway.port`,
default 3000) with no fallback, so a port collision with another app silently breaks
the API server and the voice helper.

This spec covers two independent changes:

1. Replace the "Running" pill with a **Notification Center** for chat updates.
2. **Auto-select** an available gateway port in the range 3000–4000 when the
   preferred port is occupied.

---

## Feature 1: Notification Center

### Goal

Replace the static "Running" status pill (`App.tsx:101-109`) with a notification
center in the top-right of the title bar that surfaces chat activity and lets the
user jump to a chat that has updates.

### Data sources (already exist — no new state)

From `useChats()` (`src/hooks/useChats.tsx`):

- **In-progress** = keys of `state.inFlight` (one in-flight turn per chat;
  `InFlight.agentStatus` is `'idle' | 'thinking' | 'working' | 'writing'`).
- **Unread-completed** = keys of `state.unreadChats`. Set in the `completeSend`
  reducer case when the completed chat is not the currently-selected one; cleared
  in the `select` case when the chat is opened.
- Chat metadata (title, workspaceName, updatedAt) from `state.chats[id]`.

### Trigger (replaces the statusPill)

- A bell icon button in the title bar, `WebkitAppRegion: 'no-drag'`.
- **Badge** = count of `unreadChats` **only**. Hidden when zero.
- When `inFlight` is non-empty, show a subtle pulse dot near the icon (reuse the
  existing `codey-pulse` keyframes defined in `App.tsx`). The pulse indicates
  in-progress work but does **not** contribute to the badge number.

### Panel (dropdown on click)

Two sections:

- **In progress** — chats present in `inFlight`: title + current agent status
  (`thinking` / `working` / `writing`) + pulse dot.
- **Completed** — chats present in `unreadChats`: title + workspace name + last
  updated time; an unread dot on the left.

Behavior:

- Click an item → `selectChat(chatId)`, then close the panel.
  - Completed items: selecting clears `unreadChats[id]` automatically (existing
    `select` reducer logic).
  - In-progress items: remain listed until the turn completes.
- Empty state (no in-progress and no unread): "No updates".
- Click outside the panel closes it.

### Components & wiring

- **New:** `src/components/NotificationCenter.tsx`. Reads `state.inFlight`,
  `state.unreadChats`, `state.chats` and calls `selectChat` from `useChats()`.
- **`App.tsx`:** replace the statusPill markup (`App.tsx:101-109`) with
  `<NotificationCenter />`. Remove the now-unused `statusPill` style entries
  (`statusPill`) if nothing else references them.
- **Keep:** `useGateway()`'s `isRunning` is still consumed by `ChatTab`
  (`isGatewayRunning={isRunning}`) — leave that path intact. Only the title-bar
  pill is removed.

### Running indicator decision

The gateway running indicator is **fully removed** from the title bar (the app
auto-starts the gateway, so a persistent "Running" badge adds no value). No
replacement health dot.

---

## Feature 2: Gateway Port Auto-Select (3000–4000)

### Problem

`bootInProcessCore()` in `electron/main.ts` starts `ApiServer` on
`config.gateway.port ?? 3001` (the on-disk config uses 3000). `ApiServer.start()`
(`packages/gateway/src/health.ts:188`) calls `server.listen(port)` with **no
`EADDRINUSE` handling** — a collision rejects the promise, logs an error, and the
voice helper is still told to connect to the old (dead) port.

### Who depends on the port

- ✅ `ApiServer` — health / metrics / `/voice/config`.
- ✅ Voice helper — spawned with `--gateway-port <port>` (`main.ts:724`).
- ❌ Renderer — communicates over IPC (`window.codey`), does not use the port.

### Design

1. **New port-probe helper** in `electron/main.ts` using Node's `net`:

   ```ts
   async function findAvailablePort(preferred: number, max = 4000): Promise<number>
   ```

   - Try each port from `preferred` upward: `net.createServer().listen(port)`;
     on success, close the probe server and return that port.
   - If none free up to `max`, throw. The caller logs the failure and falls back
     to `preferred`, letting the existing `ApiServer.start()` error path surface
     the problem.

2. **In `bootInProcessCore()`**, before starting `ApiServer`:
   - `const preferred = config.gateway.port ?? 3000`
   - `const actualPort = await findAvailablePort(preferred)`
   - Start `ApiServer` on `actualPort`.
   - Store `actualPort` in a module-level `let activeApiPort` so other code (voice
     helper) reads the real port instead of re-reading config.
   - If `actualPort !== preferred`, emit a `gateway-log` line:
     `port <preferred> in use, using <actualPort>`.

3. **Voice helper** reads `activeApiPort`: in `applyVoiceHelper()` the `port`
   computed at `main.ts:723` becomes `activeApiPort ?? preferred`, so the helper
   connects to the actual bound port.

4. **Do not write back to `gateway.json`.** 3000 stays the preferred port in
   config; auto-selection only affects the current run.

### Boundaries / known limitations

- There is a race between probing a port free and `ApiServer` actually binding it
  (another process could grab it in between). `ApiServer.start()` may still fail in
  that window; this is acceptable and the failure is logged. Making `ApiServer`
  self-retry would require changes in `packages/gateway` and is **out of scope**
  for this change.

---

## Out of scope

- Persisting the auto-selected port to `gateway.json`.
- Retry logic inside `packages/gateway`'s `ApiServer`.
- Any change to how the renderer reaches the gateway (stays IPC).
- A replacement gateway health indicator in the title bar.
