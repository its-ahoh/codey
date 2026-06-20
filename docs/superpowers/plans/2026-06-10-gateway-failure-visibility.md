# Gateway Failure Visibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the codey-mac in-process core fails to boot, show a prominent banner with the real error and a Relaunch App button, and disable the composer — instead of today's silent degradation.

**Architecture:** A pure, unit-testable state store (`electron/core-state.ts`) owns the `booting | ready | failed` phase; `bootInProcessCore()` drives transitions; each transition is pushed to the renderer over a `core:state` IPC event with a backfill getter (same pattern as updater state). The renderer surfaces it via `useGateway` → a banner component in `App.tsx` and a `coreFailed` prop on `ChatTab`. Recovery is `app.relaunch()`.

**Tech Stack:** Electron (main + preload), React 18, TypeScript, vitest.

**Spec:** `docs/superpowers/specs/2026-06-10-gateway-failure-visibility-design.md`

**Environment notes (IMPORTANT):**
- All commands run from `/Users/jackou/Documents/projects/codey/codey-mac`.
- Default Node on this machine is v16 and CANNOT run vitest/tsc. Before any command: `source ~/.nvm/nvm.sh && nvm use 22.17.1`.
- Work on branch `feat/gateway-failure-visibility` (already created).
- `docs/` is gitignored on purpose (private local specs/plans) — never force-add it.

---

### Task 1: Core state store (`electron/core-state.ts`)

**Files:**
- Create: `codey-mac/electron/core-state.ts`
- Test: `codey-mac/electron/core-state.test.ts`

- [ ] **Step 1: Write the failing test**

Create `codey-mac/electron/core-state.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { createCoreStateStore } from './core-state'

describe('createCoreStateStore', () => {
  it('starts in booting phase without notifying', () => {
    const notify = vi.fn()
    const store = createCoreStateStore(notify)
    expect(store.get()).toEqual({ phase: 'booting' })
    expect(notify).not.toHaveBeenCalled()
  })

  it('booting → ready notifies with the new state', () => {
    const notify = vi.fn()
    const store = createCoreStateStore(notify)
    store.setReady()
    expect(store.get()).toEqual({ phase: 'ready' })
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify).toHaveBeenCalledWith({ phase: 'ready' })
  })

  it('booting → failed carries the error message', () => {
    const notify = vi.fn()
    const store = createCoreStateStore(notify)
    store.setFailed('ENOENT: gateway.json missing')
    expect(store.get()).toEqual({ phase: 'failed', error: 'ENOENT: gateway.json missing' })
    expect(notify).toHaveBeenCalledWith({ phase: 'failed', error: 'ENOENT: gateway.json missing' })
  })

  it('setBooting resets state (relaunch path) and notifies', () => {
    const notify = vi.fn()
    const store = createCoreStateStore(notify)
    store.setFailed('boom')
    store.setBooting()
    expect(store.get()).toEqual({ phase: 'booting' })
    expect(notify).toHaveBeenLastCalledWith({ phase: 'booting' })
  })

  it('a thrown notify callback does not corrupt state', () => {
    const store = createCoreStateStore(() => { throw new Error('renderer gone') })
    expect(() => store.setReady()).not.toThrow()
    expect(store.get()).toEqual({ phase: 'ready' })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `source ~/.nvm/nvm.sh && nvm use 22.17.1 && npx vitest run electron/core-state.test.ts`
Expected: FAIL — `Cannot find module './core-state'` (or equivalent resolution error).

- [ ] **Step 3: Write minimal implementation**

Create `codey-mac/electron/core-state.ts`:

```ts
// Pure state store for the in-process core's lifecycle phase. Kept free of
// Electron imports so it is unit-testable; main.ts injects the notify
// callback that forwards transitions to the renderer.
export type CorePhase = 'booting' | 'ready' | 'failed'

export interface CoreState {
  phase: CorePhase
  error?: string
}

export interface CoreStateStore {
  get(): CoreState
  setBooting(): void
  setReady(): void
  setFailed(error: string): void
}

export function createCoreStateStore(notify: (state: CoreState) => void): CoreStateStore {
  let state: CoreState = { phase: 'booting' }
  const set = (next: CoreState) => {
    state = next
    try { notify(state) } catch { /* renderer gone */ }
  }
  return {
    get: () => state,
    setBooting: () => set({ phase: 'booting' }),
    setReady: () => set({ phase: 'ready' }),
    setFailed: (error: string) => set({ phase: 'failed', error }),
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `source ~/.nvm/nvm.sh && nvm use 22.17.1 && npx vitest run electron/core-state.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add electron/core-state.ts electron/core-state.test.ts
git commit -m "feat(codey-mac): add testable core lifecycle state store

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Wire the store into main, preload, and types

**Files:**
- Modify: `codey-mac/electron/main.ts` (imports ~line 1-17; module state ~line 18; `bootInProcessCore()` lines 416-508; IPC handlers near `gateway:status` ~line 847)
- Modify: `codey-mac/electron/preload.ts` (add `core` section near `gateway`, ~line 143)
- Modify: `codey-mac/src/codey-api.d.ts` (add `core` to `Window['codey']`, near `gateway` ~line 130)

- [ ] **Step 1: Add store to main.ts**

In `codey-mac/electron/main.ts`:

1. Add to the existing import block at the top of the file:

```ts
import { createCoreStateStore } from './core-state'
```

2. `sendToRenderer` is declared as a hoisted `function` (line ~99), so a module-level store next to the other module state (`let inProcessGateway: Codey | null = null`, line 18) is safe:

```ts
const coreStateStore = createCoreStateStore((s) => sendToRenderer('core:state', s))
```

3. In `bootInProcessCore()` (line 416):
   - First statement inside the function body (before `const root = resolveDataRoot()`): `coreStateStore.setBooting()`
   - Last statement of the `try` block (immediately after the `inProcessGateway.setPairingEventListener(...)` call, ~line 504): `coreStateStore.setReady()`
   - In the `catch (err: any)` block (line 505-507), add after the existing `sendToRenderer('gateway-log', ...)` line:

```ts
    coreStateStore.setFailed(err?.message ?? String(err))
```

4. Register two IPC handlers inside `app.whenReady().then(...)` **before** `await bootInProcessCore()`, next to `registerUpdaterIpc(...)` — NOT next to `gateway:status`, which registers after the boot await; a renderer mounting during a slow boot would hit "No handler registered for 'core:state'":

```ts
  // Must be registered before the boot await: the renderer can mount and
  // query core state while bootInProcessCore() is still running.
  ipcMain.handle('core:state', async () =>
    wrap(async () => coreStateStore.get())
  )
  ipcMain.handle('app:relaunch', async () =>
    wrap(async () => { app.relaunch(); app.quit() })
  )
```

- [ ] **Step 2: Expose in preload.ts**

In `codey-mac/electron/preload.ts`, after the `gateway:` section (line 143-146), add:

Also add at the top of preload.ts: `import type { CoreState } from './core-state'` (type-only, erased at compile time).

```ts
  core: {
    state: () => ipcRenderer.invoke('core:state'),
    relaunch: () => ipcRenderer.invoke('app:relaunch'),
    onState: (handler: (state: CoreState) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, state: any) => handler(state)
      ipcRenderer.on('core:state', listener)
      return () => ipcRenderer.removeListener('core:state', listener)
    },
  },
```

- [ ] **Step 3: Add renderer types**

In `codey-mac/src/codey-api.d.ts`:

1. Add to the import block at the top:

```ts
import type { CoreState } from '../electron/core-state'
```

2. Inside `Window['codey']`, after the `gateway` section (~line 138), add:

```ts
      core: {
        state: () => Promise<IpcResult<CoreState>>
        relaunch: () => Promise<IpcResult<void>>
        onState: (handler: (state: CoreState) => void) => () => void
      }
```

- [ ] **Step 4: Typecheck both targets**

Run:
```bash
source ~/.nvm/nvm.sh && nvm use 22.17.1 \
  && npx tsc -p tsconfig.electron.json --noEmit \
  && npx tsc -p tsconfig.json --noEmit
```
Expected: both exit 0 with no output.

- [ ] **Step 5: Commit**

```bash
git add electron/main.ts electron/preload.ts src/codey-api.d.ts
git commit -m "feat(codey-mac): push core lifecycle state to renderer; add app:relaunch IPC

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Renderer view helpers (banner text + composer placeholder)

**Files:**
- Create: `codey-mac/src/components/coreOfflineView.ts`
- Test: `codey-mac/src/components/coreOfflineView.test.ts`

This follows the existing pattern of extracting pure view logic for testing (see `src/components/notificationLogic.test.ts`, `src/hooks/updaterState.test.ts`) since vitest runs in a node environment with no DOM.

- [ ] **Step 1: Write the failing test**

Create `codey-mac/src/components/coreOfflineView.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { coreBannerText, composerPlaceholder } from './coreOfflineView'

describe('coreBannerText', () => {
  it('returns null while booting and when ready', () => {
    expect(coreBannerText({ phase: 'booting' })).toBeNull()
    expect(coreBannerText({ phase: 'ready' })).toBeNull()
  })

  it('returns message with error detail when failed', () => {
    expect(coreBannerText({ phase: 'failed', error: 'ENOENT: gateway.json' }))
      .toBe("Codey's core failed to start: ENOENT: gateway.json")
  })

  it('returns generic message when failed without detail', () => {
    expect(coreBannerText({ phase: 'failed' })).toBe("Codey's core failed to start.")
    expect(coreBannerText({ phase: 'failed', error: '  ' })).toBe("Codey's core failed to start.")
  })
})

describe('composerPlaceholder', () => {
  it('core failure wins over everything', () => {
    expect(composerPlaceholder({ coreFailed: true, isGatewayRunning: false, isSending: false }))
      .toBe('Core offline — relaunch to continue')
    expect(composerPlaceholder({ coreFailed: true, isGatewayRunning: true, isSending: true }))
      .toBe('Core offline — relaunch to continue')
  })

  it('matches existing placeholders otherwise', () => {
    expect(composerPlaceholder({ coreFailed: false, isGatewayRunning: false, isSending: false }))
      .toBe('Start gateway to chat')
    expect(composerPlaceholder({ coreFailed: false, isGatewayRunning: true, isSending: true }))
      .toBe('Sending…')
    expect(composerPlaceholder({ coreFailed: false, isGatewayRunning: true, isSending: false }))
      .toBe('Message Codey… (↵ to send)')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `source ~/.nvm/nvm.sh && nvm use 22.17.1 && npx vitest run src/components/coreOfflineView.test.ts`
Expected: FAIL — cannot find module `./coreOfflineView`.

- [ ] **Step 3: Write minimal implementation**

Create `codey-mac/src/components/coreOfflineView.ts`:

```ts
import type { CoreState } from '../../electron/core-state'

// Pure view logic for the core-offline banner and composer, extracted for
// unit testing (vitest runs in a node environment with no DOM).

export function coreBannerText(state: CoreState | null | undefined): string | null {
  if (!state || state.phase !== 'failed') return null
  const detail = state.error?.trim()
  return detail
    ? `Codey's core failed to start: ${detail}`
    : "Codey's core failed to start."
}

export function composerPlaceholder(opts: {
  coreFailed: boolean
  isGatewayRunning: boolean
  isSending: boolean
}): string {
  if (opts.coreFailed) return 'Core offline — relaunch to continue'
  if (!opts.isGatewayRunning) return 'Start gateway to chat'
  return opts.isSending ? 'Sending…' : 'Message Codey… (↵ to send)'
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `source ~/.nvm/nvm.sh && nvm use 22.17.1 && npx vitest run src/components/coreOfflineView.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/components/coreOfflineView.ts src/components/coreOfflineView.test.ts
git commit -m "feat(codey-mac): pure view helpers for core-offline banner and composer

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Surface core state in `useGateway`; delete dead stubs

**Files:**
- Modify: `codey-mac/src/hooks/useGateway.ts`

- [ ] **Step 1: Update the hook**

Replace the full contents of `codey-mac/src/hooks/useGateway.ts` with:

```ts
import { useEffect, useState } from 'react'
import type { CoreState } from '../../electron/core-state'

export interface GatewayStatus {
  status: 'healthy' | 'degraded' | 'stopped' | 'starting'
  uptime: number
  messagesProcessed: number
  errors: number
  channels: { telegram: boolean; discord: boolean; imessage: boolean }
}

const EMPTY_STATUS: GatewayStatus = {
  status: 'starting',
  uptime: 0,
  messagesProcessed: 0,
  errors: 0,
  channels: { telegram: false, discord: false, imessage: false },
}

export const useGateway = () => {
  const [logs, setLogs] = useState<string[]>(['Gateway running in-process'])
  const [status, setStatus] = useState<GatewayStatus>(EMPTY_STATUS)
  const [isRunning, setIsRunning] = useState(false)
  const [coreState, setCoreState] = useState<CoreState>({ phase: 'booting' })

  useEffect(() => {
    // The renderer subscribes after main has already emitted boot-time logs,
    // so backfill the ring buffer before subscribing to live updates.
    let cancelled = false
    window.codey.gateway.recentLogs().then(res => {
      if (cancelled) return
      if (res.ok && res.data && res.data.length > 0) {
        setLogs(prev => {
          const initial = prev.length === 1 && prev[0] === 'Gateway running in-process' ? [] : prev
          return [...initial, ...res.data!].slice(-100)
        })
      }
    }).catch(() => {})
    const off = window.codey.onLog(msg => {
      setLogs(prev => [...prev.slice(-99), msg])
    })
    return () => { cancelled = true; off() }
  }, [])

  useEffect(() => {
    // Same backfill-then-subscribe pattern: boot may have finished (or failed)
    // before this component mounted.
    let cancelled = false
    window.codey.core.state().then(res => {
      if (!cancelled && res.ok && res.data) setCoreState(res.data)
    }).catch(() => {})
    const off = window.codey.core.onState(s => setCoreState(s))
    return () => { cancelled = true; off() }
  }, [])

  useEffect(() => {
    let stopped = false
    const tick = async () => {
      try {
        const res = await window.codey.gateway.status()
        if (stopped) return
        if (res.ok && res.data) {
          const d = res.data
          setStatus({
            status: d.status,
            uptime: d.uptime,
            messagesProcessed: d.stats.messagesProcessed,
            errors: d.stats.errors,
            channels: d.channels,
          })
          setIsRunning(true)
        } else {
          setIsRunning(false)
        }
      } catch {
        if (!stopped) setIsRunning(false)
      }
    }
    tick()
    const id = setInterval(tick, 3000)
    return () => { stopped = true; clearInterval(id) }
  }, [])

  return {
    isRunning,
    status,
    logs,
    coreState,
    relaunchApp: () => { void window.codey.core.relaunch() },
  }
}
```

Notes: the dead `start`/`stop`/`toggle` no-op stubs are removed. Verified consumers: `src/App.tsx:25` uses `isRunning`; `src/components/SettingsOverlay.tsx:33` uses `isRunning, status, logs`. Nothing references the stubs.

- [ ] **Step 2: Typecheck**

Run: `source ~/.nvm/nvm.sh && nvm use 22.17.1 && npx tsc -p tsconfig.json --noEmit`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add src/hooks/useGateway.ts
git commit -m "feat(codey-mac): useGateway exposes coreState + relaunchApp, drop dead stubs

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Banner component + App mount + composer gating

**Files:**
- Create: `codey-mac/src/components/CoreOfflineBanner.tsx`
- Modify: `codey-mac/src/App.tsx` (Shell, lines 24-128)
- Modify: `codey-mac/src/components/ChatTab.tsx` (Props line ~21, component signature line 221, `canSend` line 728, composer lines 1188-1226)

- [ ] **Step 1: Create the banner component**

Create `codey-mac/src/components/CoreOfflineBanner.tsx`:

```tsx
import React from 'react'
import { C } from '../theme'
import { coreBannerText } from './coreOfflineView'
import type { CoreState } from '../../electron/core-state'

export const CoreOfflineBanner: React.FC<{
  state: CoreState
  onRelaunch: () => void
}> = ({ state, onRelaunch }) => {
  const text = coreBannerText(state)
  if (!text) return null
  return (
    <div style={styles.banner}>
      <span style={styles.text} title={text}>⚠️ {text}</span>
      <button type="button" onClick={onRelaunch} style={styles.button}>
        Relaunch App
      </button>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  banner: {
    display: 'flex', alignItems: 'center', gap: 10,
    padding: '8px 14px', flexShrink: 0,
    background: C.dangerBg, borderBottom: `1px solid ${C.dangerBorder}`,
    color: C.dangerFg, fontSize: 12,
  },
  text: {
    flex: 1, minWidth: 0,
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  button: {
    background: 'transparent', border: `1px solid ${C.dangerBorder}`,
    color: C.dangerFg, borderRadius: 5, padding: '3px 10px',
    fontSize: 12, cursor: 'pointer', flexShrink: 0,
  },
}
```

- [ ] **Step 2: Mount in App.tsx**

In `codey-mac/src/App.tsx`:

1. Add import:

```tsx
import { CoreOfflineBanner } from './components/CoreOfflineBanner'
```

2. Line 25, take the new fields:

```tsx
  const { isRunning, coreState, relaunchApp } = useGateway()
```

3. In the content area (line 112), render the banner at the top of the chat column — it must show with or without an active chat:

```tsx
        <div style={styles.content}>
          <CoreOfflineBanner state={coreState} onRelaunch={relaunchApp} />
          {activeChat && (
```

4. Pass the failure flag to ChatTab (line 118):

```tsx
              <ChatTab chatId={activeChat.id} isGatewayRunning={isRunning} coreFailed={coreState.phase === 'failed'} />
```

- [ ] **Step 3: Gate the composer in ChatTab.tsx**

In `codey-mac/src/components/ChatTab.tsx`:

1. Add import near the other component imports at the top of the file:

```tsx
import { composerPlaceholder } from './coreOfflineView'
```

2. Props (line ~21): add the new optional field below `isGatewayRunning: boolean`:

```tsx
  coreFailed?: boolean
```

3. Component signature (line 221):

```tsx
export const ChatTab: React.FC<Props> = ({ chatId, isGatewayRunning, coreFailed }) => {
```

4. `canSend` (line 728) — add the core check:

```tsx
  const canSend = isGatewayRunning && !coreFailed && !isSending && (!!input.trim() || pendingAttachments.length > 0) && !orphaned
```

5. Attach button (line 1188): change `disabled={!isGatewayRunning || isSending}` to:

```tsx
              disabled={!isGatewayRunning || !!coreFailed || isSending}
```

6. Textarea (lines 1205-1206): replace the placeholder ternary and disabled with:

```tsx
              placeholder={composerPlaceholder({ coreFailed: !!coreFailed, isGatewayRunning, isSending })}
              disabled={!isGatewayRunning || !!coreFailed}
```

(The send path is additionally belt-and-braces gated: line 640's early return already requires `isGatewayRunning`, and `canSend` now requires `!coreFailed`.)

- [ ] **Step 4: Typecheck + full test suite**

Run:
```bash
source ~/.nvm/nvm.sh && nvm use 22.17.1 \
  && npx tsc -p tsconfig.json --noEmit \
  && npx tsc -p tsconfig.electron.json --noEmit \
  && npx vitest run
```
Expected: typechecks clean; all vitest suites pass (existing 6 test files + the 2 new ones).

- [ ] **Step 5: Commit**

```bash
git add src/components/CoreOfflineBanner.tsx src/App.tsx src/components/ChatTab.tsx
git commit -m "feat(codey-mac): core-offline banner with Relaunch App + composer gating

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Manual verification (failure injection)

**Files:**
- Temporarily modify (then revert): `codey-mac/electron/main.ts`

- [ ] **Step 1: Inject a boot failure**

In `bootInProcessCore()` in `codey-mac/electron/main.ts`, add as the first line of the `try` block:

```ts
    throw new Error('TEST: injected boot failure')
```

- [ ] **Step 2: Run the app and verify the failure UX**

Run: `source ~/.nvm/nvm.sh && nvm use 22.17.1 && npm run dev` (in a second terminal: `npx electron .` if the dev script only starts vite — check how the app is normally launched in dev; if `npm run dev` alone doesn't open an Electron window, build with `npx vite build` and run `npx electron .`).

Verify:
- Banner reads: `⚠️ Codey's core failed to start: TEST: injected boot failure` with a Relaunch App button.
- Composer textarea is disabled with placeholder "Core offline — relaunch to continue".
- Attach + send buttons disabled.
- No banner flash before the failure (and none in the success case later).

- [ ] **Step 3: Verify relaunch**

Click **Relaunch App** while the injected throw is still present.
Expected: app quits and reopens, banner shows again (boot fails again) — proves the relaunch round-trip works.

- [ ] **Step 4: Revert the injection and verify the healthy path**

Remove the injected `throw` line. Relaunch the dev app.
Expected: no banner at any point, composer enabled, chats send normally.

Run: `git diff electron/main.ts`
Expected: no diff (injection fully reverted).

- [ ] **Step 5: Final check**

Run: `source ~/.nvm/nvm.sh && nvm use 22.17.1 && npx vitest run && git status`
Expected: all tests pass; working tree clean except untracked `docs/` (gitignored).
