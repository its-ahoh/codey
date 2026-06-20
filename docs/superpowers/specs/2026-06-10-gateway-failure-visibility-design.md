# Gateway Failure Visibility — Design

**Date:** 2026-06-10
**Scope:** codey-mac (Electron main process + React renderer)
**Status:** Approved by user (pre-implementation)

## Problem

When the in-process core fails to boot, the Mac app degrades silently: the only
signal is a `[core] Boot failed: …` line in the Status tab's log view
(`bootInProcessCore()` catch block, `codey-mac/electron/main.ts:505-507`).
The chat UI stays fully interactive — sends fail with IPC errors rendered as
fake assistant messages, workers/settings tabs show empty state, and the
`useGateway` hook's `start`/`stop`/`toggle` methods are no-op stubs
(`codey-mac/src/hooks/useGateway.ts:75-77`).

## Decisions (user-approved)

1. **Recovery = relaunch the app**, not in-place core restart.
   `app.relaunch(); app.quit()`. Simpler and bulletproof; no risk of leaked
   listeners or half-torn-down state from re-instantiating `Codey`.
2. **Banner triggers on core-down only.** Channel-level problems
   (Telegram/Discord/iMessage disconnected → `degraded` health status) keep
   the normal UI and surface only in the Status tab, since local chats work
   fine in that state.
3. **Detection = explicit state pushed from main**, not inferred from polling.
   Precise, immediate, carries the real error message, and cannot flash the
   banner during a normal (slow) boot.

## Design

### Main process (`codey-mac/electron/main.ts`)

- Module-level state:
  ```ts
  type CorePhase = 'booting' | 'ready' | 'failed'
  let coreState: { phase: CorePhase; error?: string } = { phase: 'booting' }
  ```
- `bootInProcessCore()` transitions:
  - entry → `{ phase: 'booting' }`
  - after the `Codey` instance is constructed and chat/pairing listeners are
    wired (i.e. end of the `try` block) → `{ phase: 'ready' }`
  - catch block → `{ phase: 'failed', error: err?.message ?? String(err) }`
    (in addition to the existing `gateway-log` line)
- Every transition calls `sendToRenderer('core:state', coreState)`.
- New IPC handlers:
  - `core:state` → returns current `coreState` (backfill for renderers that
    mount after boot finished — same pattern as `updater:lastState` and
    `gateway:recentLogs`).
  - `app:relaunch` → `app.relaunch(); app.quit()`.
- The state transition logic is extracted into a small pure module
  (`codey-mac/electron/core-state.ts`) so it is unit-testable: it owns the
  state value, validates transitions, and invokes a notify callback.

### Preload bridge (`codey-mac/electron/preload.ts`)

New surface:

```ts
window.codey.core = {
  state: () => invoke('core:state'),
  onState: (cb) => subscribe('core:state', cb),
  relaunch: () => invoke('app:relaunch'),
}
```

### Renderer

- `useGateway` (`codey-mac/src/hooks/useGateway.ts`):
  - adds `coreState` React state, initialized by `window.codey.core.state()`
    backfill, kept current by `onState` subscription.
  - deletes the dead `start`/`stop`/`toggle` stubs; exposes `relaunchApp()`
    calling `window.codey.core.relaunch()`.
  - existing 3s `gateway:status` poll and `isRunning` are unchanged.
- **Offline banner:** when `coreState.phase === 'failed'`, a slim banner
  renders across the top of the chat area:
  > ⚠️ Codey's core failed to start: *\<error message\>* — [Relaunch App]
  - Not shown during `booting` (no startup flash) and not shown for
    `degraded` health status.
- **Composer:** while `phase === 'failed'`, the send path is disabled and the
  input shows placeholder text "Core offline — relaunch to continue". Voice
  insert and attachments are likewise inert (they target the same send path).

### Error handling

- If the `core:state` IPC surface itself is unavailable (e.g. stale preload
  during dev), the banner never shows — identical to today's behavior, no
  regression.
- Relaunch requires no confirmation dialog; it is an explicit user click and
  chats are persisted by the gateway.

### Out of scope

- In-place core restart.
- Watchdog for a core that goes silent mid-session after a successful boot
  (poll-based `isRunning` already exists; promoting it to the banner is a
  possible follow-up).
- Degraded-channel UI changes.

## Testing

- **Unit (vitest):**
  - `core-state.ts`: transition sequence booting → ready, booting → failed
    (with message), notify callback fired per transition, illegal transitions
    ignored or normalized.
  - `useGateway`: surfaces `failed` phase + error text from a mocked bridge;
    `relaunchApp` invokes the bridge.
- **Manual:** temporarily `throw new Error('boom')` at the top of
  `bootInProcessCore()`'s try block; verify banner text, disabled composer,
  and that Relaunch App restarts into a working session.
- Build with Node v22.17.1 (nvm) — default Node v16 cannot run vitest/tsc.
