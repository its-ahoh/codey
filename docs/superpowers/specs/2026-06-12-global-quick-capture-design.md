# Global Quick-Capture — Design

**Date:** 2026-06-12
**Scope:** codey-mac (Electron main process + React renderer)
**Status:** Approved by user (pre-implementation)

## Problem

Starting a task today requires focusing the app, picking a workspace, clicking
New Chat, and typing. The distance between "I have a thought" and "the agent is
working" is the single biggest friction in the app. Quick-capture collapses it
to one global hotkey from anywhere on the desktop.

## Decisions (user-approved)

1. **Hotkey:** `Option+Space` by default (Electron accelerator `Alt+Space`),
   registered at startup; configurable in Settings → General; blank disables.
2. **Dispatch:** every capture creates a **new chat** in the chosen workspace
   and sends the text as its first turn immediately (Aide auto-titles from the
   first message, existing behavior).
3. **Post-send:** the window dismisses instantly (fire-and-forget). A quiet
   native notification "Task sent to <workspace>" confirms, and clicking it
   opens that chat. Completion/errors arrive via the background-notification
   feature (#115).

## Design

### Capture window (main process, `codey-mac/electron/main.ts`)

- One lazily-created, reusable `BrowserWindow`:
  - `frame: false`, `alwaysOnTop: true`, `resizable: false`, `skipTaskbar: true`,
    `show: false`, ~`width: 560, height: 120`, `webPreferences` identical to
    mainWindow (same `preload.js`, contextIsolation).
  - Loads the shared renderer: dev `http://localhost:5173/#/capture`, prod
    `loadFile(join(__dirname, '../dist/index.html'), { hash: '/capture' })`.
  - Shown centered on the display containing the cursor
    (`screen.getDisplayNearestPoint(screen.getCursorScreenPoint())`).
- Toggle behavior: hotkey shows + focuses it; hotkey again, `Escape` (renderer
  asks via IPC), or window `blur` hides it. Hidden, never destroyed (fast
  re-summon). `closed` event nulls the reference (recreate next time).
- Hotkey registration mirrors `applyVoiceHotkey`
  (`electron/main.ts:565-614`): `applyCaptureHotkey(cfg)` runs at boot and on
  every config change; unregisters the previous accelerator; registration
  failure (conflict) logs `[capture] hotkey registration failed` to
  gateway-log and does not crash.
- Config: `capture.hotkey` (string, default `"Alt+Space"`; empty string =
  disabled). Stored in gateway.json via existing `config:get/set`.

### Capture renderer (`#/capture` route)

- `codey-mac/src/main.tsx` branches on `window.location.hash === '#/capture'`
  → renders `CaptureWindow` (new component, `src/components/CaptureWindow.tsx`)
  instead of `App`. No router dependency.
- UI: one auto-focused multiline-capable input (Enter sends, Shift+Enter
  newline, Escape hides) + a compact workspace `<select>`:
  - options from `window.codey.workspaces.list()`,
  - default selection from `localStorage['codey.lastWorkspace']` (same origin
    as the main window in both dev and prod, so the value is shared), falling
    back to the first workspace,
  - choosing a workspace updates `codey.lastWorkspace`.
- Theme: reuses the existing CSS-variable palette (apply `applyTheme` /
  `applyPalette` from `src/theme.ts` on mount) so it matches the app.
- On window re-show, the renderer re-focuses the input (subscribe to a
  `capture:shown` push from main).

### Dispatch (main process)

- New IPC `capture:submit` with payload `{ workspaceName: string, text: string }`:
  1. Validate via pure helper (below). Invalid → return `{ ok: false, error }`.
  2. `const chat = inProcessGateway.getChatManager().create({ workspaceName })`
  3. `void inProcessGateway.sendToChat(chat.id, text, noopSink)` — fire and
     forget; the global chat-event listener mirrors events to the main window
     and the notification pipeline (#115) reports completion/error.
  4. Hide the capture window, then show a silent confirmation notification
     `Task sent to <workspaceName>` whose click opens the chat (same
     `mainWindow.show()` + `notify:openChat` path as #115).
  5. Return `{ ok: true, data: { chatId } }`.
- Gateway not booted / create throws → `{ ok: false, error }`; the renderer
  keeps the text in the input and shows the error inline in the capture window
  (no data loss).

### Pure logic (`codey-mac/electron/capture.ts`, vitest-tested)

```ts
export function resolveCaptureSubmit(
  text: string,
  workspaceName: string | undefined,
  knownWorkspaces: string[],
): { ok: true; text: string; workspaceName: string } | { ok: false; error: string }
```
- Trims text; empty → error 'Nothing to send'.
- No workspaces at all → error 'No workspaces configured'.
- `workspaceName` missing or not in `knownWorkspaces` → fall back to
  `knownWorkspaces[0]`.

Also `captureAccelerator(hotkey: string | undefined): string | null` —
normalizes the stored hotkey to an Electron accelerator (reuses/extends the
logic of `toElectronAccelerator`), `null` when blank/disabled.

### Settings UI

- `HotkeyRecorder` is currently private to `WhisperTab.tsx:150-231`; extract it
  to `src/components/HotkeyRecorder.tsx` unchanged and import from both places.
- New row in Settings → General (AppearanceTab): "Quick capture hotkey" with
  the recorder + reset; persists `capture.hotkey` via `config:set`.

### Voice

- No new code: the existing voice flow pastes transcribed text into the
  focused field; the capture input is auto-focused, so dictation works.

### Out of scope

- Attachments/images in the capture window.
- Capture history/recents UI.
- Per-capture agent/model overrides (workspace defaults apply).
- Windows/Linux behavior.

## Testing

- **Vitest:** `resolveCaptureSubmit` (trim/empty, fallback, no-workspaces) and
  `captureAccelerator` (default, custom, blank-disabled, Fn rejected if
  unsupported — match `toElectronAccelerator` semantics).
- **Manual (dev):** hotkey summons centered window; Escape/blur/hotkey-again
  hides; Enter creates a new chat in the chosen workspace and dispatches
  (verify in main window sidebar + completion notification); empty text
  rejected inline; workspace dropdown defaults to last-used; settings recorder
  rebinds live; blank disables.
- Node v22.17.1 via nvm for all commands.
