# Collapsible Sidebar & Per-Chat Startup Notification

Date: 2026-05-23

Three small, related UX fixes:

1. The codey-mac left chat-list panel cannot be collapsed; users with a single active chat have no way to reclaim that horizontal space.
2. The gateway's startup notification shows the global default workspace/working-dir even when chats are bound to different workspaces — so a user with a Telegram-linked chat for workspace `foo` (working dir `~/foo`) still sees the default `~/codey` path in the startup message.
3. When the gateway starts up, every chat that is linked to a channel should also receive a summary on its own linked route, not just the global `notifyChatId`.

## 1. Collapsible left panel

**State.** `Shell` (`codey-mac/src/App.tsx`) gains `leftCollapsed: boolean`, initialized from `localStorage['codey.leftPanelCollapsed'] === '1'`. Toggling writes the new value back.

**Toggle UI.** A sidebar icon button is added to the title bar, positioned to the left of the centered title area (after the macOS traffic-light spacer at `width: 76`). The button is `WebkitAppRegion: 'no-drag'`. Icon is an inline SVG (two-column sidebar glyph); no orientation flip needed — the visible/hidden panel is the affordance.

**Keyboard shortcut.** `Cmd+\` (and `Ctrl+\` on non-mac) toggles, registered in the existing `onKey` handler in `App.tsx`.

**Layout.** When `leftCollapsed === true`, `<ChatListPanel>` is not rendered. The content area already uses `flex: 1` so it naturally expands. No changes inside `ChatListPanel.tsx`.

## 2 + 3. Per-chat gateway startup notification

**Behavior.** When the gateway starts (`Gateway.sendStartupNotification`, `packages/gateway/src/gateway.ts:429`):

- Enumerate `chatManager.list()`.
- For each chat with `routes.length > 0`:
  - Resolve its working dir by reading `workspaces/<chat.workspaceName>/workspace.json` (the same lookup already inlined around `gateway.ts:2882`).
  - Compose a plain-text message:
    ```
    Codey is online

    Chat: <chat.title>
    Workspace: <chat.workspaceName>
    Working dir: <resolvedDir>
    ```
  - For each route on the chat, find the handler matching `route.channel` and call `handler.sendToRoute(route, text)` (interface already exists, see `telegram.ts:227`).
- **Fallback.** If no chat has any route, fall back to the current behavior: send the existing global summary to each handler via `handler.sendStartupMessage(text)`. This keeps `notifyChatId` working for setups that haven't linked any chats yet.

**Helper extraction.** The workspace.json lookup currently inlined in `gateway.ts:2882` is duplicated by this feature. Extract a private helper:

```ts
private async resolveChatWorkingDir(chat: Chat): Promise<string>
```

…and call it from both the existing dispatch path and the new startup-notification path.

**Formatting.** `sendToRoute` in `telegram.ts` currently sends plain text (`bot.sendMessage(route.channelChatId, text)`). We pass plain text here as well — no HTML wrapping — so we don't accidentally change behavior for any future caller of `sendToRoute`.

## Files touched

- `codey-mac/src/App.tsx` — collapse state, title-bar toggle button, `Cmd+\` shortcut, conditional `<ChatListPanel>` render.
- `packages/gateway/src/gateway.ts` — rewrite `sendStartupNotification`, extract `resolveChatWorkingDir` helper, replace the inlined workspace.json read near line 2882.
- (No changes to `ChatListPanel.tsx` or to `telegram.ts` / other channel handlers — `sendToRoute` is reused as-is.)

## Out of scope

- No persistence of "last collapsed state" per workspace; one global preference.
- No animation on collapse — instant show/hide.
- No retro-fitting of the global startup text for channels that have no routes; the fallback path is unchanged.
