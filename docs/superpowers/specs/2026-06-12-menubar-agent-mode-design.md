# Menubar-Agent Mode — Design

**Date:** 2026-06-12
**Scope:** codey-mac (Electron main process + React renderer)
**Status:** Approved by user (pre-implementation)

## Problem

The tray icon today only does Open/Quit (`createTray`, `electron/main.ts:244-276`).
An always-on agent gateway that mirrors Telegram/iMessage should live in the
menu bar as an ambient surface: show whether agents are running or need you,
list active chats with click-to-jump, survive reboots (launch at login), and
optionally drop its Dock icon.

## Decisions (user-approved)

1. **Tray dropdown = status header + chats + actions.** Header line, a
   Needs-attention section, a Running section, up to 5 Recent chats, then
   Open Codey / Quick Capture / Settings / Quit.
2. **Status shown via tooltip + menu header only; tray icon stays the single
   template image.** macOS template icons are monochrome, so a colored status
   dot can't render without dropping template mode; tooltip + header convey
   state with zero new assets.
3. **Launch-at-login: included**, `ui.launchAtLogin` (default off),
   `app.setLoginItemSettings`.
4. **Dock-less mode: included** as a toggle, `ui.dockless` (default off),
   `app.dock?.hide()/show()`.

## Design

### Pure state module: `codey-mac/electron/tray-state.ts`

Same testable-pure pattern as `core-state.ts` / `chat-notifications.ts`. No
Electron imports.

```ts
export interface ChatTrayState { inFlight: boolean; needsAttention: boolean }
export type TrayStateMap = Record<string, ChatTrayState>

// Reduce a chat stream event into the per-chat tray state map (immutable).
export function applyEvent(state: TrayStateMap, ev: { type: string; chatId: string; userQuestion?: unknown }): TrayStateMap

// Clear a chat's needsAttention (and it is no longer surfaced) — called when
// the user opens/selects that chat.
export function clearAttention(state: TrayStateMap, chatId: string): TrayStateMap

export interface TraySummary {
  header: string                                   // "Idle" | "2 running" | "1 needs attention · 2 running"
  needsAttention: string[]                         // chatIds, attention first
  running: string[]                                // chatIds in flight (not already in needsAttention)
}
export function summarize(state: TrayStateMap): TraySummary
```

Reducer rules:
- non-terminal event (`queued`/`stream`/`thinking`/`tool_*`/`info`) → `inFlight = true`;
  a *new* turn (first non-terminal after a terminal) clears `needsAttention`.
- `done` with truthy `userQuestion` → `inFlight = false`, `needsAttention = true`.
- `done` without userQuestion, or `stopped` → `inFlight = false` (attention unchanged → false on plain done).
- `error` → `inFlight = false`, `needsAttention = true`.
- `summarize` header: 0/0 → "Idle"; else join non-zero parts
  `"<n> needs attention"` and `"<n> running"` with " · ".

### Tray glue (`codey-mac/electron/main.ts`)

- Module-level `let trayState: TrayStateMap = {}`.
- In the existing `setChatEventListener` callback (already calls
  `sendToRenderer('chats:event', ev)` + `maybeNotify(ev)`), also
  `trayState = applyEvent(trayState, ev)` then schedule a debounced
  (~250ms) `rebuildTrayMenu()`.
- `rebuildTrayMenu()` (wrapped in try/catch — a bad chat record never crashes
  the tray):
  - `const summary = summarize(trayState)`
  - resolve chat titles/workspaces via `inProcessGateway.getChatManager().get(id)`
  - build `Menu` from template:
    - header `MenuItem` (`enabled: false`) = `summary.header`
    - if `needsAttention.length`: separator + "Needs attention" label + one
      item per chat
    - if `running.length`: separator + "Running" label + one item per chat
    - separator + up to 5 most-recent from `getChatManager().list()` (skip ids
      already shown above)
    - separator + Open Codey / Quick Capture / Settings / Quit
  - each chat item click → `openChatFromTray(chatId)`:
    `mainWindow?.show()`, `trayState = clearAttention(trayState, chatId)`,
    `sendToRenderer('notify:openChat', { chatId })`, rebuild.
  - Quick Capture click → `toggleCaptureWindow()`; Settings click →
    `mainWindow?.show()` + `sendToRenderer('notify:openSettings')` (new tiny
    renderer subscription opening the settings overlay on the General tab).
  - `tray.setToolTip('Codey — ' + summary.header)`.
- `rebuildTrayMenu()` also called once right after `createTray()` so the menu
  is correct before any event.

### Launch-at-login + dock-less (`main.ts`)

- `applyUiPreferences(rawCfg)`:
  - `app.setLoginItemSettings({ openAtLogin: !!cfg?.ui?.launchAtLogin })`
  - `if (cfg?.ui?.dockless) app.dock?.hide(); else app.dock?.show()`
- Called at boot (after `createTray`) and from the `coreConfigManager`
  `change` listener (next to `applyVoiceHotkey`/`applyCaptureHotkey`).

### Renderer

- Settings → General (AppearanceTab): two new toggles, same `Toggle` + config
  pattern as the skipPerms/notify/capture rows:
  - "Launch Codey at login" → `ui.launchAtLogin`.
  - "Hide Dock icon (menu bar only)" → `ui.dockless`, with sub-caption "Codey
    stays reachable from the menu bar."
- `notify:openSettings` subscription (App shell): opens the settings overlay on
  the General tab (the overlay + `initialTab` prop already exist in App.tsx).

### Error handling

- `rebuildTrayMenu` try/catch logs to gateway-log; tray keeps its last menu.
- `app.dock` is macOS-only and already optional-chained.
- `setLoginItemSettings` is a no-op-safe call on macOS.

### Out of scope

- Status dot / new icon assets (decision 2).
- Per-chat actions in the tray beyond jump-to.
- Windows/Linux tray behavior.

## Testing

- **Vitest** (`tray-state.ts`): reducer transitions (inflight set/clear,
  new-turn clears attention, question→attention, error→attention, plain
  done→no attention); `clearAttention`; `summarize` header variants ("Idle",
  single, both, ordering) and section membership / no-double-listing.
- **Manual:** run a turn → header "1 running", tooltip updates, chat appears
  under Running; trigger AskUserQuestion → moves to Needs attention; click it →
  window focuses + chat selected + attention cleared; toggle launch-at-login
  (verify via `app.getLoginItemSettings().openAtLogin`) and dock-less (Dock
  icon hides/shows) live.
- Node v22.17.1 via nvm.
