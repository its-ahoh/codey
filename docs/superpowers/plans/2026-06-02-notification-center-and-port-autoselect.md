# Notification Center + Gateway Port Auto-Select Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the static "Running" pill in the codey-mac title bar with a notification center for chat updates, and auto-select a free gateway port in 3000–4000 when the preferred port is occupied.

**Architecture:** Two independent changes. (1) A pure `deriveNotifications()` function turns existing `useChats` state (`inFlight`, `unreadChats`, `chats`) into list/badge data, rendered by a new `NotificationCenter.tsx` component that replaces the title-bar pill. (2) A `findAvailablePort()` helper probes ports with Node `net`; `electron/main.ts` uses it before starting `ApiServer` and feeds the resolved port to the voice helper. The chosen port is runtime-only — `gateway.json` is never rewritten.

**Tech Stack:** TypeScript, React 18, Electron 28, Vitest (node environment), Node `net`.

---

## File Structure

- `codey-mac/electron/portUtils.ts` — **create.** `isPortAvailable()` + `findAvailablePort()`. Pure Node, no Electron deps, so it's unit-testable.
- `codey-mac/electron/portUtils.test.ts` — **create.** Vitest unit tests for the above.
- `codey-mac/electron/main.ts` — **modify.** Add `activeApiPort` module var; use `findAvailablePort` in `bootInProcessCore`; feed `activeApiPort` to the voice helper.
- `codey-mac/vitest.config.ts` — **modify.** Add `electron/**/*.test.ts` to `include`.
- `codey-mac/tsconfig.electron.json` — **modify.** Exclude `*.test.ts` from the electron tsc project.
- `codey-mac/src/components/notificationCenter.ts` — **create.** Pure `deriveNotifications()` + its types. Unit-testable (no React/DOM).
- `codey-mac/src/components/notificationCenter.test.ts` — **create.** Vitest unit tests for `deriveNotifications`.
- `codey-mac/src/components/NotificationCenter.tsx` — **create.** The React component (bell icon, badge, dropdown panel). Renders `deriveNotifications` output.
- `codey-mac/src/App.tsx` — **modify.** Replace the statusPill block with `<NotificationCenter />`; drop the now-unused `statusPill` style.

**Note on testing boundaries:** Vitest runs with `environment: 'node'` and only `*.test.ts` files (not `.tsx`). There is no DOM/React test harness in this repo. So all unit tests target the pure `.ts` logic modules (`portUtils.ts`, `notificationCenter.ts`). The `.tsx` component and `App.tsx` wiring are verified by typecheck/build and manual run, not unit tests.

---

## Task 1: Port probe utility

**Files:**
- Create: `codey-mac/electron/portUtils.ts`
- Test: `codey-mac/electron/portUtils.test.ts`
- Modify: `codey-mac/vitest.config.ts`
- Modify: `codey-mac/tsconfig.electron.json`

- [ ] **Step 1: Add electron tests to the vitest include**

Edit `codey-mac/vitest.config.ts` — change the `include` line:

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'electron/**/*.test.ts'],
  },
})
```

- [ ] **Step 2: Keep test files out of the electron tsc project**

Edit `codey-mac/tsconfig.electron.json` — change the `exclude` array so test files don't get type-checked/compiled into `dist-electron`:

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "commonjs",
    "moduleResolution": "node",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "./dist-electron",
    "rootDir": "."
  },
  "include": ["electron/**/*"],
  "exclude": ["node_modules", "dist", "dist-electron", "electron/**/*.test.ts"]
}
```

- [ ] **Step 3: Write the failing test**

Create `codey-mac/electron/portUtils.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest'
import { createServer, type Server } from 'net'
import { isPortAvailable, findAvailablePort } from './portUtils'

const servers: Server[] = []

function occupy(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = createServer()
    s.once('error', reject)
    s.listen(port, '127.0.0.1', () => {
      servers.push(s)
      resolve()
    })
  })
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(s => new Promise<void>(r => s.close(() => r()))))
})

describe('isPortAvailable', () => {
  it('returns true for a free port', async () => {
    // 3999 is unlikely to be bound by the test environment.
    expect(await isPortAvailable(3999)).toBe(true)
  })

  it('returns false for an occupied port', async () => {
    await occupy(3987)
    expect(await isPortAvailable(3987)).toBe(false)
  })
})

describe('findAvailablePort', () => {
  it('returns the preferred port when it is free', async () => {
    expect(await findAvailablePort(3995, 4000)).toBe(3995)
  })

  it('skips an occupied port and returns the next free one', async () => {
    await occupy(3990)
    const port = await findAvailablePort(3990, 4000)
    expect(port).toBeGreaterThan(3990)
    expect(port).toBeLessThanOrEqual(4000)
  })

  it('throws when no port is available in range', async () => {
    await occupy(3992)
    await expect(findAvailablePort(3992, 3992)).rejects.toThrow(/No available port/)
  })
})
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `cd codey-mac && npm test -- portUtils`
Expected: FAIL — cannot resolve `./portUtils` (module does not exist yet).

- [ ] **Step 5: Implement the utility**

Create `codey-mac/electron/portUtils.ts`:

```ts
import { createServer } from 'net'

/**
 * Resolves true if `port` can be bound on localhost right now. Probes by
 * actually listening (then immediately closing) so we catch the same
 * EADDRINUSE the real server would hit.
 */
export function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer()
    server.once('error', () => resolve(false))
    server.once('listening', () => {
      server.close(() => resolve(true))
    })
    server.listen(port, '127.0.0.1')
  })
}

/**
 * Returns the first available port at or after `preferred`, up to and
 * including `max`. Throws if every port in the range is occupied.
 */
export async function findAvailablePort(preferred: number, max = 4000): Promise<number> {
  for (let port = preferred; port <= max; port++) {
    if (await isPortAvailable(port)) return port
  }
  throw new Error(`No available port between ${preferred} and ${max}`)
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd codey-mac && npm test -- portUtils`
Expected: PASS — all 5 tests green.

- [ ] **Step 7: Commit**

```bash
git add codey-mac/electron/portUtils.ts codey-mac/electron/portUtils.test.ts codey-mac/vitest.config.ts codey-mac/tsconfig.electron.json
git commit -m "Add port probe utility for gateway auto-select"
```

---

## Task 2: Wire port auto-select into the Electron main process

**Files:**
- Modify: `codey-mac/electron/main.ts` (import; module var near line 13-20; `bootInProcessCore` ApiServer block ~473-483; voice helper port ~723)

No unit test — this is Electron main-process glue verified by typecheck + manual run (covered in Task 5's verification).

- [ ] **Step 1: Import the helper**

In `codey-mac/electron/main.ts`, just below `import { pathToFileURL } from 'url'` (line 3), add:

```ts
import { findAvailablePort } from './portUtils'
```

- [ ] **Step 2: Add a module-level variable for the resolved port**

In `codey-mac/electron/main.ts`, with the other top-level `let` declarations (after `let apiServer: ApiServer | null = null` near line 20), add:

```ts
let activeApiPort: number | null = null
```

- [ ] **Step 3: Use findAvailablePort before starting ApiServer**

In `bootInProcessCore`, replace this block (currently ~lines 473-483):

```ts
    try {
      const apiPort = (coreConfigManager.get() as any)?.gateway?.port ?? 3001
      apiServer = new ApiServer(apiPort, (): any => inProcessGateway!.getHealthStatus(), coreConfigManager)
      void apiServer.start().then(() => {
        sendToRenderer('gateway-log', `[core] API server listening on ${apiPort}`)
      }).catch((err: any) => {
        sendToRenderer('gateway-log', `[core] ApiServer.start failed: ${err?.message ?? err}`)
      })
    } catch (err: any) {
      sendToRenderer('gateway-log', `[core] ApiServer init failed: ${err?.message ?? err}`)
    }
```

with:

```ts
    try {
      const preferredPort = (coreConfigManager.get() as any)?.gateway?.port ?? 3000
      let apiPort = preferredPort
      try {
        apiPort = await findAvailablePort(preferredPort, 4000)
        if (apiPort !== preferredPort) {
          sendToRenderer('gateway-log', `[core] port ${preferredPort} in use, using ${apiPort}`)
        }
      } catch (scanErr: any) {
        sendToRenderer('gateway-log', `[core] port scan failed: ${scanErr?.message ?? scanErr}; falling back to ${preferredPort}`)
      }
      activeApiPort = apiPort
      apiServer = new ApiServer(apiPort, (): any => inProcessGateway!.getHealthStatus(), coreConfigManager)
      void apiServer.start().then(() => {
        sendToRenderer('gateway-log', `[core] API server listening on ${apiPort}`)
      }).catch((err: any) => {
        sendToRenderer('gateway-log', `[core] ApiServer.start failed: ${err?.message ?? err}`)
      })
    } catch (err: any) {
      sendToRenderer('gateway-log', `[core] ApiServer init failed: ${err?.message ?? err}`)
    }
```

(`bootInProcessCore` is already `async`, so `await findAvailablePort(...)` is valid here.)

- [ ] **Step 4: Feed the resolved port to the voice helper**

In `applyVoiceHelper`, replace the line (currently ~line 723):

```ts
    const port = (coreConfigManager?.get() as any)?.gateway?.port ?? 3001
```

with:

```ts
    const port = activeApiPort ?? (coreConfigManager?.get() as any)?.gateway?.port ?? 3000
```

- [ ] **Step 5: Typecheck the electron project**

Run: `cd codey-mac && npx tsc -p tsconfig.electron.json --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add codey-mac/electron/main.ts
git commit -m "Auto-select free gateway port (3000-4000) on boot"
```

---

## Task 3: Notification derivation logic

**Files:**
- Create: `codey-mac/src/components/notificationCenter.ts`
- Test: `codey-mac/src/components/notificationCenter.test.ts`

- [ ] **Step 1: Write the failing test**

Create `codey-mac/src/components/notificationCenter.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { deriveNotifications, type InFlightLike } from './notificationCenter'
import type { Chat } from '../types'

function chat(id: string, over: Partial<Chat> = {}): Chat {
  return {
    id,
    title: `Title ${id}`,
    workspaceName: 'ws',
    selection: {} as any,
    messages: [],
    createdAt: 0,
    updatedAt: 0,
    ...over,
  } as Chat
}

const inflight = (over: Partial<InFlightLike> = {}): InFlightLike => ({
  agentStatus: 'working',
  ...over,
})

describe('deriveNotifications', () => {
  it('lists in-flight chats under inProgress with their agent status', () => {
    const chats = { a: chat('a', { updatedAt: 5 }) }
    const r = deriveNotifications(chats, { a: inflight({ agentStatus: 'thinking' }) }, {})
    expect(r.inProgress).toHaveLength(1)
    expect(r.inProgress[0]).toMatchObject({ chatId: 'a', agentStatus: 'thinking' })
    expect(r.completed).toHaveLength(0)
    expect(r.unreadCount).toBe(0)
  })

  it('lists unread-completed chats and counts them in unreadCount', () => {
    const chats = { a: chat('a'), b: chat('b') }
    const r = deriveNotifications(chats, {}, { a: true, b: true })
    expect(r.completed).toHaveLength(2)
    expect(r.unreadCount).toBe(2)
    expect(r.inProgress).toHaveLength(0)
  })

  it('shows a chat that is both unread and in-flight only under inProgress', () => {
    const chats = { a: chat('a') }
    const r = deriveNotifications(chats, { a: inflight() }, { a: true })
    expect(r.inProgress).toHaveLength(1)
    expect(r.completed).toHaveLength(0)
    expect(r.unreadCount).toBe(0)
  })

  it('skips ids that have no matching chat', () => {
    const r = deriveNotifications({}, { ghost: inflight() }, { phantom: true })
    expect(r.inProgress).toHaveLength(0)
    expect(r.completed).toHaveLength(0)
  })

  it('sorts each group by updatedAt descending', () => {
    const chats = {
      a: chat('a', { updatedAt: 1 }),
      b: chat('b', { updatedAt: 9 }),
    }
    const r = deriveNotifications(chats, {}, { a: true, b: true })
    expect(r.completed.map(c => c.chatId)).toEqual(['b', 'a'])
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd codey-mac && npm test -- notificationCenter`
Expected: FAIL — cannot resolve `./notificationCenter`.

- [ ] **Step 3: Implement the logic module**

Create `codey-mac/src/components/notificationCenter.ts`:

```ts
import type { Chat } from '../types'

/** Subset of useChats' internal InFlight needed to render a notification. */
export interface InFlightLike {
  agentStatus: 'idle' | 'thinking' | 'working' | 'writing'
  queuedPosition?: number
}

export interface NotificationItem {
  chatId: string
  title: string
  workspaceName: string
  updatedAt: number
}

export interface InProgressItem extends NotificationItem {
  agentStatus: InFlightLike['agentStatus']
  queuedPosition?: number
}

export interface NotificationData {
  inProgress: InProgressItem[]
  completed: NotificationItem[]
  /** Badge count: number of unread-completed chats (in-progress is excluded). */
  unreadCount: number
}

/**
 * Turns raw chat state into notification-center view data.
 *
 * - inProgress: one entry per chat with an in-flight turn.
 * - completed: unread-completed chats that are NOT currently back in flight
 *   (a re-sent chat shows only under inProgress).
 * - unreadCount: length of `completed`, used for the badge.
 *
 * Each group is sorted by updatedAt descending. Ids with no matching chat
 * (e.g. a chat removed mid-flight) are skipped.
 */
export function deriveNotifications(
  chats: Record<string, Chat>,
  inFlight: Record<string, InFlightLike>,
  unreadChats: Record<string, true>,
): NotificationData {
  const inProgress: InProgressItem[] = []
  for (const chatId of Object.keys(inFlight)) {
    const chat = chats[chatId]
    if (!chat) continue
    inProgress.push({
      chatId,
      title: chat.title,
      workspaceName: chat.workspaceName,
      updatedAt: chat.updatedAt,
      agentStatus: inFlight[chatId].agentStatus,
      queuedPosition: inFlight[chatId].queuedPosition,
    })
  }
  inProgress.sort((a, b) => b.updatedAt - a.updatedAt)

  const completed: NotificationItem[] = []
  for (const chatId of Object.keys(unreadChats)) {
    if (inFlight[chatId]) continue
    const chat = chats[chatId]
    if (!chat) continue
    completed.push({
      chatId,
      title: chat.title,
      workspaceName: chat.workspaceName,
      updatedAt: chat.updatedAt,
    })
  }
  completed.sort((a, b) => b.updatedAt - a.updatedAt)

  return { inProgress, completed, unreadCount: completed.length }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd codey-mac && npm test -- notificationCenter`
Expected: PASS — all 5 tests green.

- [ ] **Step 5: Commit**

```bash
git add codey-mac/src/components/notificationCenter.ts codey-mac/src/components/notificationCenter.test.ts
git commit -m "Add deriveNotifications logic for the notification center"
```

---

## Task 4: NotificationCenter component

**Files:**
- Create: `codey-mac/src/components/NotificationCenter.tsx`

No unit test (no DOM harness). Verified by typecheck in Task 5.

- [ ] **Step 1: Create the component**

Create `codey-mac/src/components/NotificationCenter.tsx`:

```tsx
import React, { useEffect, useRef, useState } from 'react'
import { C } from '../theme'
import { useChats } from '../hooks/useChats'
import { deriveNotifications, type InFlightLike } from './notificationCenter'

const STATUS_LABEL: Record<InFlightLike['agentStatus'], string> = {
  idle: 'Idle',
  thinking: 'Thinking…',
  working: 'Working…',
  writing: 'Writing…',
}

export const NotificationCenter: React.FC = () => {
  const { state, selectChat } = useChats()
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  const { inProgress, completed, unreadCount } = deriveNotifications(
    state.chats,
    state.inFlight as Record<string, InFlightLike>,
    state.unreadChats,
  )
  const hasInProgress = inProgress.length > 0

  // Close the panel on any click outside its root.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open])

  const pick = (chatId: string) => {
    selectChat(chatId)
    setOpen(false)
  }

  return (
    <div ref={rootRef} style={styles.root}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        title="Notifications"
        aria-label="Notifications"
        style={styles.bellButton}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
        {hasInProgress && <span style={styles.pulseDot} />}
        {unreadCount > 0 && (
          <span style={styles.badge}>{unreadCount > 9 ? '9+' : unreadCount}</span>
        )}
      </button>

      {open && (
        <div style={styles.panel}>
          {inProgress.length === 0 && completed.length === 0 && (
            <div style={styles.empty}>No updates</div>
          )}

          {inProgress.length > 0 && (
            <div style={styles.section}>
              <div style={styles.sectionTitle}>In progress</div>
              {inProgress.map(item => (
                <div key={item.chatId} style={styles.item} onClick={() => pick(item.chatId)}>
                  <span style={styles.itemPulse} />
                  <div style={styles.itemBody}>
                    <div style={styles.itemTitle}>{item.title}</div>
                    <div style={styles.itemMeta}>
                      {item.workspaceName} · {STATUS_LABEL[item.agentStatus]}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {completed.length > 0 && (
            <div style={styles.section}>
              <div style={styles.sectionTitle}>Completed</div>
              {completed.map(item => (
                <div key={item.chatId} style={styles.item} onClick={() => pick(item.chatId)}>
                  <span style={styles.unreadDot} />
                  <div style={styles.itemBody}>
                    <div style={styles.itemTitle}>{item.title}</div>
                    <div style={styles.itemMeta}>
                      {item.workspaceName} · {formatTime(item.updatedAt)}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function formatTime(ts: number): string {
  if (!ts) return ''
  try {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  } catch {
    return ''
  }
}

const styles: Record<string, React.CSSProperties> = {
  root: {
    position: 'relative',
    // @ts-ignore Electron
    WebkitAppRegion: 'no-drag',
  },
  bellButton: {
    position: 'relative',
    background: 'transparent',
    border: 'none',
    cursor: 'pointer',
    color: C.fg3,
    padding: 4,
    borderRadius: 4,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  pulseDot: {
    position: 'absolute',
    top: 2,
    right: 2,
    width: 6,
    height: 6,
    borderRadius: '50%',
    background: C.green,
    animation: 'codey-pulse 1.4s ease-in-out infinite',
  },
  badge: {
    position: 'absolute',
    top: -2,
    right: -2,
    minWidth: 14,
    height: 14,
    padding: '0 3px',
    borderRadius: 7,
    background: '#E5484D',
    color: '#fff',
    fontSize: 9,
    fontWeight: 700,
    lineHeight: '14px',
    textAlign: 'center',
  },
  panel: {
    position: 'absolute',
    top: 30,
    right: 0,
    width: 300,
    maxHeight: 420,
    overflowY: 'auto',
    background: C.surface,
    border: `1px solid ${C.border}`,
    borderRadius: 8,
    boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
    padding: 6,
    zIndex: 1000,
  },
  empty: {
    padding: '18px 10px',
    textAlign: 'center',
    color: C.fg3,
    fontSize: 12,
  },
  section: { marginBottom: 4 },
  sectionTitle: {
    padding: '6px 8px 4px',
    color: C.fg3,
    fontSize: 10,
    fontWeight: 700,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  item: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 8,
    padding: '8px',
    borderRadius: 6,
    cursor: 'pointer',
  },
  itemPulse: {
    marginTop: 5,
    width: 6,
    height: 6,
    borderRadius: '50%',
    background: C.green,
    flexShrink: 0,
    animation: 'codey-pulse 1.4s ease-in-out infinite',
  },
  unreadDot: {
    marginTop: 5,
    width: 6,
    height: 6,
    borderRadius: '50%',
    background: '#E5484D',
    flexShrink: 0,
  },
  itemBody: { minWidth: 0, flex: 1 },
  itemTitle: {
    color: C.fg,
    fontSize: 13,
    fontWeight: 500,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  itemMeta: {
    color: C.fg3,
    fontSize: 11,
    marginTop: 2,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
}
```

- [ ] **Step 2: Commit**

```bash
git add codey-mac/src/components/NotificationCenter.tsx
git commit -m "Add NotificationCenter component"
```

---

## Task 5: Wire NotificationCenter into the title bar

**Files:**
- Modify: `codey-mac/src/App.tsx` (import; replace statusPill block at ~101-109; remove `statusPill` style at ~205-210)

No unit test. Verified by typecheck + manual run.

- [ ] **Step 1: Import the component**

In `codey-mac/src/App.tsx`, after the existing component imports (e.g. after the `VoiceRecorder` import on line 5), add:

```tsx
import { NotificationCenter } from './components/NotificationCenter'
```

- [ ] **Step 2: Replace the statusPill block with the notification center**

In `codey-mac/src/App.tsx`, replace this block (currently lines 101-109):

```tsx
        <div style={{
          ...styles.statusPill,
          borderColor: C.green + '55',
          background: C.green + '11',
          color: C.green,
        }}>
          <div style={{ width: 6, height: 6, borderRadius: '50%', background: C.green }} />
          Running
        </div>
```

with:

```tsx
        <NotificationCenter />
```

- [ ] **Step 3: Remove the now-unused statusPill style**

In `codey-mac/src/App.tsx`, delete the `statusPill` entry from the `styles` object (currently lines 205-210):

```tsx
  statusPill: {
    display: 'flex', alignItems: 'center', gap: 5, padding: '4px 10px',
    borderRadius: 6, border: '1px solid', fontSize: 11, fontWeight: 600,
    // @ts-ignore Electron
    WebkitAppRegion: 'no-drag',
  },
```

Leave `useGateway()` / `isRunning` and the `<ChatTab ... isGatewayRunning={isRunning} />` prop untouched — that path is still used.

- [ ] **Step 4: Typecheck the renderer**

Run: `cd codey-mac && npx tsc -p tsconfig.json --noEmit`
Expected: no errors (in particular, no "unused `C`" — `C` is still referenced elsewhere in `App.tsx`).

- [ ] **Step 5: Run the full unit-test suite**

Run: `cd codey-mac && npm test`
Expected: PASS — including the new `portUtils` and `notificationCenter` suites.

- [ ] **Step 6: Manual verification**

Run: `cd codey-mac && npm run dev`
Confirm:
- Title bar top-right shows a bell icon, no "Running" pill.
- Send a message in an unselected chat and let it finish → bell shows a red badge; opening the panel lists it under "Completed"; clicking it selects the chat and clears the badge.
- While a turn is running in a non-active chat → the panel's "In progress" section lists it with a pulse dot (badge stays unchanged).
- Launch with port 3000 already occupied (e.g. `nc -l 3000` in another terminal) → gateway log reads `port 3000 in use, using 3001` (or next free port), and the app still works.

- [ ] **Step 7: Commit**

```bash
git add codey-mac/src/App.tsx
git commit -m "Replace Running pill with NotificationCenter in title bar"
```

---

## Self-Review Notes

- **Spec coverage:** F1 trigger/badge/pulse → Task 4 + Task 3 (`unreadCount` = unread-completed only; pulse from `inFlight`, not counted). F1 panel two sections + click-to-select + empty state + click-outside → Task 4. F1 remove pill / keep `isRunning` for ChatTab → Task 5. F2 `findAvailablePort` → Task 1. F2 boot wiring + `activeApiPort` + log line + no config writeback → Task 2 Step 3. F2 voice helper uses resolved port → Task 2 Step 4. F2 fallback-to-preferred on scan failure → Task 2 Step 3 (inner try/catch).
- **Type consistency:** `deriveNotifications(chats, inFlight, unreadChats)` and `InFlightLike` / `NotificationData` used identically across Tasks 3 and 4. `findAvailablePort(preferred, max)` signature matches between Tasks 1 and 2. `activeApiPort` declared once (Task 2 Step 2) and read in Task 2 Step 4.
- **Known limitation (from spec):** a port can be grabbed between probe and bind; `ApiServer.start()` may then still fail and is logged. Out of scope to retry inside `packages/gateway`.
