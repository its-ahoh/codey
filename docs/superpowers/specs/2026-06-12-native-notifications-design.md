# Native macOS Notifications — Design

**Date:** 2026-06-12
**Scope:** codey-mac (Electron main process + React renderer)
**Status:** Approved by user (pre-implementation)

## Problem

When the Mac app is in the background, the user has no way to know a turn
finished, errored, or — worst — is blocked on an AskUserQuestion. The in-app
NotificationCenter bell only helps while looking at the app. Errors are doubly
invisible: `errorSend` in `codey-mac/src/hooks/useChats.tsx:259-273` never
marks the chat unread, so background errors don't even reach the bell.

## Decisions (user-approved)

1. **Triggers:** `done` (turn completion), `done` carrying `userQuestion`
   (distinct "needs your input" treatment), and `error`. `permission_denials`,
   `queued`, `stream`, `thinking`, `tool_*`, `info`, `stopped` never notify.
2. **Gating:** notify only when the main window is NOT focused
   (`mainWindow.isFocused() === false`, tracked via window `focus`/`blur`
   events). When focused, the in-app bell covers it. No renderer→main
   selected-chat sync.
3. **Click + answer buttons in v1:** clicking a notification focuses the
   window and selects that chat. AskUserQuestion notifications additionally
   carry action buttons (one per option, max 4) that send the chosen option's
   label into the chat directly from the main process.
   - macOS caveats accepted: buttons render reliably only in signed/packaged
     builds (dev fallback = click-to-focus); macOS shows one button inline and
     the rest in the hover dropdown; **multi-select questions get no buttons**
     (inexpressible) — just the "needs your input" notification.
4. **Settings:** single toggle in Settings → General, persisted as
   `notifications.enabled` in gateway.json config (default ON), read live.

## Design

### Pure decision module: `codey-mac/electron/chat-notifications.ts`

Same testable-pure-module pattern as `electron/core-state.ts`. No Electron
imports.

```ts
export interface NotificationDecision {
  chatId: string
  title: string
  body: string
  actions?: Array<{ label: string }>   // present only for single-select userQuestion
}

export interface NotifyContext {
  focused: boolean
  enabled: boolean
  chatTitle?: string
}

export function decideNotification(ev: ChatStreamEvent-like, ctx: NotifyContext): NotificationDecision | null
```

Rules:
- `!ctx.enabled || ctx.focused` → null.
- `ev.type === 'done'` with `userQuestion` (≥1 option):
  - title `Codey needs your input`, body = question text (truncated ~180 chars,
    prefixed with chat title when available).
  - `actions` = first 4 option labels — but ONLY when not multiSelect.
- `ev.type === 'done'` otherwise: title `Codey finished` (+ chat title), body =
  response snippet (truncated ~180 chars).
- `ev.type === 'error'`: title `Codey hit an error` (+ chat title), body =
  error message (truncated).
- All other event types → null.
- **Dedupe:** module also exports a tiny per-chat tracker so one turn emits at
  most one notification (a `done` following an `error` for the same turn, or
  duplicate `done` events, don't double-notify). Tracker resets per new turn
  (caller resets on `queued`/send).

### Electron glue (in `codey-mac/electron/main.ts`)

- Track focus: `mainWindow.on('focus'/'blur')` updating a module boolean.
- In the existing `setChatEventListener` callback (which currently just does
  `sendToRenderer('chats:event', ev)`), additionally call
  `maybeNotify(ev)`:
  - reads `notifications.enabled` from `coreConfigManager` (default true),
  - calls `decideNotification`,
  - if non-null, shows `new Notification({ title, body, actions })`.
- `click` handler → `mainWindow.show()` + `sendToRenderer('notify:openChat',
  { chatId })`.
- `action` handler (button index) → resolve the option label and send it into
  the chat through the same in-process send path the `chats:send` IPC handler
  uses. Existing event mirroring (same as Telegram-initiated turns) updates the
  renderer UI automatically. Guard: if a turn is already in flight for that
  chat, ignore the action (stale notification).
- Chat title for the notification body comes from
  `inProcessGateway.getChatManager().get(chatId)?.title` (best-effort).

### Renderer

- Preload + `codey-api.d.ts`: `window.codey.notify.onOpenChat(handler)`
  subscription (event `notify:openChat`).
- `useChats` (or App shell) subscribes and calls `selectChat(chatId)`.
- **Bug fix:** `errorSend` reducer marks the chat unread when it is not
  `selectedChatId` (one line), making background errors visible in the in-app
  bell — consistent with the new native error notification.

### Settings UI

- Settings → General: checkbox "Notify when Codey finishes or needs input in
  the background", bound to config `notifications.enabled` via the existing
  `config:get`/`config:set` IPC.

### Error handling

- Notification construction wrapped in try/catch (Notification can throw on
  unsupported platforms); failures log to gateway-log, never crash main.
- Action send failures log and fall back to focusing the window.

### Out of scope

- Notifying on `permission_denials`.
- Inline text reply (`hasReply`).
- Buttons for multi-select questions.
- Notification history/persistence.

## Testing

- **Vitest** on `chat-notifications.ts`: full matrix of event types ×
  focused/enabled; userQuestion single vs multiSelect (buttons vs none);
  option cap at 4; truncation; dedupe behavior across done/error sequences.
- **Manual:** app backgrounded — completion, question (click a button → answer
  lands in chat), error; click-to-focus selects the right chat; toggle off
  silences everything. Dev build: buttons may not render (accepted), click
  path still verified; button path re-verified in a signed build when next
  packaged.
- Node v22.17.1 via nvm for all commands.
