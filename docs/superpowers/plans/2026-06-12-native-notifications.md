# Native macOS Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Native macOS notifications from the codey-mac Electron app for turn completion, errors, and blocking AskUserQuestion — with click-to-focus-chat and answer buttons — shown only while the app is unfocused.

**Architecture:** A pure, unit-tested decision module (`electron/chat-notifications.ts`) turns ChatStreamEvents + context (focused/enabled/chatTitle) into notification payloads, with a turn tracker for per-turn dedupe and an in-flight guard for stale answer buttons. Thin glue in `main.ts` taps the existing `setChatEventListener` forwarding point, shows Electron `Notification`s, and routes clicks (`notify:openChat` → renderer selects chat) and action buttons (answer sent via `inProcessGateway.sendToChat` with a no-op sink — the global event listener already mirrors the turn to the renderer, same as Telegram-initiated turns). Plus: settings toggle in AppearanceTab, and a one-line fix so background errors mark chats unread in the in-app bell.

**Tech Stack:** Electron Notification API (main process), React 18, TypeScript, vitest.

**Spec:** `docs/superpowers/specs/2026-06-12-native-notifications-design.md`

**Environment notes (IMPORTANT):**
- All commands run from `/Users/jackou/Documents/projects/codey/codey-mac`.
- Default Node is v16 and CANNOT run vitest/tsc. Before any command: `source ~/.nvm/nvm.sh && nvm use 22.17.1`.
- Branch: create `feat/native-notifications` **from `feat/gateway-failure-visibility`** (both features modify the same region of `electron/main.ts`; this will be a stacked PR based on #114).
- `docs/` is gitignored on purpose — never force-add it.
- macOS caveat (accepted in spec): notification action buttons may not render in unsigned dev builds; click-to-focus is the fallback and the only part verifiable in dev.

---

### Task 0: Branch setup

- [ ] **Step 1: Create the stacked branch**

```bash
cd /Users/jackou/Documents/projects/codey
git checkout feat/gateway-failure-visibility && git pull
git checkout -b feat/native-notifications
```

---

### Task 1: Pure decision module (`electron/chat-notifications.ts`)

**Files:**
- Create: `codey-mac/electron/chat-notifications.ts`
- Test: `codey-mac/electron/chat-notifications.test.ts`

- [ ] **Step 1: Write the failing test**

Create `codey-mac/electron/chat-notifications.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { decideNotification, createTurnTracker, truncate } from './chat-notifications'

const ctx = { focused: false, enabled: true }

describe('decideNotification', () => {
  it('returns null when disabled or focused', () => {
    const done = { type: 'done' as const, chatId: 'c1', response: 'hi' }
    expect(decideNotification(done, { focused: true, enabled: true })).toBeNull()
    expect(decideNotification(done, { focused: false, enabled: false })).toBeNull()
  })

  it('plain done → "Codey finished" with response snippet and chat title', () => {
    const d = decideNotification(
      { type: 'done', chatId: 'c1', response: 'All tests pass.' },
      { ...ctx, chatTitle: 'My project' },
    )
    expect(d).toEqual({ chatId: 'c1', title: 'Codey finished — My project', body: 'All tests pass.' })
  })

  it('done without chat title uses bare title', () => {
    const d = decideNotification({ type: 'done', chatId: 'c1', response: 'ok' }, ctx)
    expect(d?.title).toBe('Codey finished')
  })

  it('done with single-select userQuestion → input title + up to 4 action buttons', () => {
    const d = decideNotification(
      {
        type: 'done', chatId: 'c1', response: 'irrelevant',
        userQuestion: {
          question: 'Which approach?',
          options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }, { label: 'D' }, { label: 'E' }],
        },
      },
      { ...ctx, chatTitle: 'My project' },
    )
    expect(d?.title).toBe('Codey needs your input — My project')
    expect(d?.body).toBe('Which approach?')
    expect(d?.actions).toEqual([{ label: 'A' }, { label: 'B' }, { label: 'C' }, { label: 'D' }])
  })

  it('multi-select userQuestion → notification but NO action buttons', () => {
    const d = decideNotification(
      {
        type: 'done', chatId: 'c1', response: '',
        userQuestion: { question: 'Pick several', options: [{ label: 'A' }, { label: 'B' }], multiSelect: true },
      },
      ctx,
    )
    expect(d?.title).toBe('Codey needs your input')
    expect(d?.actions).toBeUndefined()
  })

  it('userQuestion with fewer than 1 option falls back to plain done', () => {
    const d = decideNotification(
      { type: 'done', chatId: 'c1', response: 'resp', userQuestion: { question: 'q', options: [] } },
      ctx,
    )
    expect(d?.title).toBe('Codey finished')
  })

  it('error → "Codey hit an error" with message', () => {
    const d = decideNotification({ type: 'error', chatId: 'c1', message: 'boom' }, ctx)
    expect(d).toEqual({ chatId: 'c1', title: 'Codey hit an error', body: 'boom' })
  })

  it('all other event types → null', () => {
    for (const type of ['queued', 'tool_start', 'tool_end', 'info', 'stream', 'thinking', 'stopped', 'permission_denials']) {
      expect(decideNotification({ type, chatId: 'c1' } as any, ctx)).toBeNull()
    }
  })

  it('bodies are truncated to 180 chars with ellipsis', () => {
    const long = 'x'.repeat(300)
    const d = decideNotification({ type: 'done', chatId: 'c1', response: long }, ctx)
    expect(d?.body.length).toBe(180)
    expect(d?.body.endsWith('…')).toBe(true)
  })
})

describe('truncate', () => {
  it('leaves short strings alone and trims whitespace', () => {
    expect(truncate('  hi  ', 10)).toBe('hi')
  })
})

describe('createTurnTracker', () => {
  it('dedupes: second terminal event for the same turn is suppressed', () => {
    const t = createTurnTracker()
    t.observe({ type: 'stream', chatId: 'c1' })
    expect(t.alreadyNotified('c1')).toBe(false)
    t.markNotified('c1')
    t.observe({ type: 'done', chatId: 'c1' })
    expect(t.alreadyNotified('c1')).toBe(true) // duplicate done / error-after-done suppressed
  })

  it('a new turn resets the notified flag', () => {
    const t = createTurnTracker()
    t.markNotified('c1')
    t.observe({ type: 'queued', chatId: 'c1' }) // new turn begins
    expect(t.alreadyNotified('c1')).toBe(false)
  })

  it('tracks in-flight per chat from non-terminal vs terminal events', () => {
    const t = createTurnTracker()
    expect(t.isInFlight('c1')).toBe(false)
    t.observe({ type: 'tool_start', chatId: 'c1' })
    expect(t.isInFlight('c1')).toBe(true)
    t.observe({ type: 'done', chatId: 'c1' })
    expect(t.isInFlight('c1')).toBe(false)
    t.observe({ type: 'stream', chatId: 'c2' })
    expect(t.isInFlight('c2')).toBe(true)
    expect(t.isInFlight('c1')).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `source ~/.nvm/nvm.sh && nvm use 22.17.1 && npx vitest run electron/chat-notifications.test.ts`
Expected: FAIL — cannot find module './chat-notifications'.

- [ ] **Step 3: Write minimal implementation**

Create `codey-mac/electron/chat-notifications.ts`:

```ts
// Pure decision logic for native macOS notifications. No Electron imports so
// it is unit-testable; main.ts supplies context (focus, enabled, chat title)
// and renders the returned decision with the Notification API.

// Structural subset of ChatStreamEvent — only the fields this module reads.
export interface NotifyEvent {
  type: string
  chatId: string
  response?: string
  message?: string
  userQuestion?: {
    question: string
    options: Array<{ label: string; description?: string }>
    multiSelect?: boolean
  }
}

export interface NotifyContext {
  focused: boolean
  enabled: boolean
  chatTitle?: string
}

export interface NotificationDecision {
  chatId: string
  title: string
  body: string
  actions?: Array<{ label: string }>
}

const MAX_BODY = 180
const MAX_ACTIONS = 4

export function truncate(s: string, max: number): string {
  const t = s.trim()
  return t.length <= max ? t : t.slice(0, max - 1) + '…'
}

function withTitle(base: string, chatTitle?: string): string {
  return chatTitle ? `${base} — ${chatTitle}` : base
}

export function decideNotification(ev: NotifyEvent, ctx: NotifyContext): NotificationDecision | null {
  if (!ctx.enabled || ctx.focused) return null
  if (ev.type === 'error') {
    return { chatId: ev.chatId, title: withTitle('Codey hit an error', ctx.chatTitle), body: truncate(ev.message ?? '', MAX_BODY) }
  }
  if (ev.type !== 'done') return null
  const q = ev.userQuestion
  if (q && q.options.length >= 1) {
    const decision: NotificationDecision = {
      chatId: ev.chatId,
      title: withTitle('Codey needs your input', ctx.chatTitle),
      body: truncate(q.question, MAX_BODY),
    }
    if (!q.multiSelect) decision.actions = q.options.slice(0, MAX_ACTIONS).map(o => ({ label: o.label }))
    return decision
  }
  return { chatId: ev.chatId, title: withTitle('Codey finished', ctx.chatTitle), body: truncate(ev.response ?? '', MAX_BODY) }
}

const TERMINAL_TYPES = new Set(['done', 'error', 'stopped'])

// Per-chat turn state: dedupes notifications (one per turn) and tells the
// action-button handler whether a new turn is already running (stale button).
export interface TurnTracker {
  observe(ev: { type: string; chatId: string }): void
  markNotified(chatId: string): void
  alreadyNotified(chatId: string): boolean
  isInFlight(chatId: string): boolean
}

export function createTurnTracker(): TurnTracker {
  const notified = new Set<string>()
  const inFlight = new Set<string>()
  return {
    observe(ev) {
      if (TERMINAL_TYPES.has(ev.type)) {
        inFlight.delete(ev.chatId)
      } else {
        // Any non-terminal event means a turn is running; that's a NEW turn,
        // so clear the previous turn's notified flag.
        inFlight.add(ev.chatId)
        notified.delete(ev.chatId)
      }
    },
    markNotified: (chatId) => { notified.add(chatId) },
    alreadyNotified: (chatId) => notified.has(chatId),
    isInFlight: (chatId) => inFlight.has(chatId),
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `source ~/.nvm/nvm.sh && nvm use 22.17.1 && npx vitest run electron/chat-notifications.test.ts`
Expected: PASS (13 tests).

- [ ] **Step 5: Commit**

```bash
git add electron/chat-notifications.ts electron/chat-notifications.test.ts
git commit -m "feat(codey-mac): pure decision module for native chat notifications

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Main-process glue + preload + types

**Files:**
- Modify: `codey-mac/electron/main.ts` (imports; module state near line 18-20; the `setChatEventListener` callback at ~line 502-504)
- Modify: `codey-mac/electron/preload.ts` (new `notify` section near the `core` section)
- Modify: `codey-mac/src/codey-api.d.ts` (new `notify` entry in Window['codey'])

Note: `Notification` is ALREADY imported from 'electron' in main.ts (used by the voice feature, ~line 1137-1167) — check before adding to the import list.

- [ ] **Step 1: Wire maybeNotify into main.ts**

1. Add to the import block:

```ts
import { decideNotification, createTurnTracker } from './chat-notifications'
```

2. Add module-level state next to `const coreStateStore = ...` (~line 20):

```ts
const turnTracker = createTurnTracker()
```

3. Add this function near `sendToRenderer` (after its definition, ~line 101+):

```ts
// Native macOS notifications for background chats. Decisions are pure
// (chat-notifications.ts); this is the impure shell: focus check, config
// read, Notification construction, click/action routing.
function maybeNotify(ev: any) {
  try {
    if (!ev || typeof ev.chatId !== 'string') return
    const enabled = ((coreConfigManager?.get() as any)?.notifications?.enabled ?? true) as boolean
    const focused = mainWindow?.isFocused() ?? false
    const chatTitle = inProcessGateway?.getChatManager().get(ev.chatId)?.title
    const decision = decideNotification(ev, { focused, enabled, chatTitle })
    const isDuplicate = turnTracker.alreadyNotified(ev.chatId)
    turnTracker.observe(ev)
    if (!decision || isDuplicate) return
    turnTracker.markNotified(decision.chatId)

    const openChat = () => {
      mainWindow?.show()
      sendToRenderer('notify:openChat', { chatId: decision.chatId })
    }
    const notif = new Notification({
      title: decision.title,
      body: decision.body,
      actions: decision.actions?.map(a => ({ type: 'button' as const, text: a.label })),
    })
    notif.on('click', openChat)
    if (decision.actions?.length) {
      notif.on('action', (_e, index) => {
        const label = decision.actions?.[index]?.label
        // Stale button (a new turn already started) or missing gateway:
        // fall back to focusing the chat instead of sending.
        if (!label || !inProcessGateway || turnTracker.isInFlight(decision.chatId)) { openChat(); return }
        const sink = () => { /* no-op: global chatEventListener mirrors to renderer */ }
        void inProcessGateway.sendToChat(decision.chatId, label, sink).catch((err: any) => {
          sendToRenderer('gateway-log', `[notify] answer send failed: ${err?.message ?? err}`)
          openChat()
        })
      })
    }
    notif.show()
  } catch (err: any) {
    try { sendToRenderer('gateway-log', `[notify] notification failed: ${err?.message ?? err}`) } catch { /* renderer gone */ }
  }
}
```

(If `mainWindow` is named differently in main.ts, adapt — read the file first. It is the BrowserWindow variable used by `sendToRenderer`.)

4. In `bootInProcessCore()`, extend the existing chat event listener (~line 502):

```ts
    inProcessGateway.setChatEventListener((ev: any) => {
      sendToRenderer('chats:event', ev)
      maybeNotify(ev)
    })
```

- [ ] **Step 2: Preload bridge**

In `codey-mac/electron/preload.ts`, after the `core:` section, add:

```ts
  notify: {
    onOpenChat: (handler: (msg: { chatId: string }) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, msg: any) => handler(msg)
      ipcRenderer.on('notify:openChat', listener)
      return () => ipcRenderer.removeListener('notify:openChat', listener)
    },
  },
```

- [ ] **Step 3: Types**

In `codey-mac/src/codey-api.d.ts`, after the `core` entry, add:

```ts
      notify: {
        onOpenChat: (handler: (msg: { chatId: string }) => void) => () => void
      }
```

- [ ] **Step 4: Typecheck**

```bash
source ~/.nvm/nvm.sh && nvm use 22.17.1 \
  && npx tsc -p tsconfig.electron.json --noEmit \
  && npx tsc -p tsconfig.json --noEmit
```
Expected: both exit 0. (If `actions` typing complains, the Electron type is `NotificationAction[]` with `{ type: 'button', text: string }` — the map above matches it.)

- [ ] **Step 5: Commit**

```bash
git add electron/main.ts electron/preload.ts src/codey-api.d.ts
git commit -m "feat(codey-mac): show native notifications for done/question/error with click + answer actions

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Renderer — open-chat subscription + background-error unread fix

**Files:**
- Modify: `codey-mac/src/hooks/useChats.tsx` (event-subscription useEffect near line 348; `errorSend` reducer case near line 259)

- [ ] **Step 1: Subscribe to notify:openChat**

In the `ChatsProvider` component, next to the existing `useEffect` that subscribes to `apiService.chats.onEvent` (~line 348), add a sibling effect:

```ts
  useEffect(() => {
    const off = window.codey.notify.onOpenChat(({ chatId }) => {
      dispatch({ type: 'select', chatId })
    })
    return off
  }, [])
```

(The `'select'` action already exists — it sets `selectedChatId` and clears the unread flag; it is exactly what the context's `selectChat` does at line ~443.)

- [ ] **Step 2: Fix errorSend to mark background chats unread**

In the `errorSend` reducer case (~line 259-273), currently the return is:

```ts
      return {
        ...state,
        chats: { ...state.chats, [chat.id]: { ...chat, messages, updatedAt: Date.now() } },
        inFlight,
      }
```

Change to also mark unread when the chat isn't selected (mirroring `completeSend` at lines 223-225):

```ts
      const unreadChats = { ...state.unreadChats }
      if (state.selectedChatId !== action.chatId) unreadChats[action.chatId] = true
      return {
        ...state,
        chats: { ...state.chats, [chat.id]: { ...chat, messages, updatedAt: Date.now() } },
        inFlight,
        unreadChats,
      }
```

- [ ] **Step 3: Typecheck + full tests**

```bash
source ~/.nvm/nvm.sh && nvm use 22.17.1 \
  && npx tsc -p tsconfig.json --noEmit \
  && npx vitest run
```
Expected: clean; all suites pass.

- [ ] **Step 4: Commit**

```bash
git add src/hooks/useChats.tsx
git commit -m "feat(codey-mac): select chat from notification click; mark background errors unread

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Settings toggle (AppearanceTab)

**Files:**
- Modify: `codey-mac/src/components/AppearanceTab.tsx`

- [ ] **Step 1: Add the toggle**

`AppearanceTab.tsx` already loads config in a mount effect (lines 39-46) and has a `Toggle` component + `skipPerms` precedent (lines 36-51, 103-113). Mirror that pattern:

1. Add state next to `skipPerms` (line 36):

```ts
  const [notifyEnabled, setNotifyEnabled] = React.useState<boolean>(true)
```

2. In the mount effect (line 41-45), after the `setSkipPerms(...)` line, add:

```ts
      setNotifyEnabled(cfg?.notifications?.enabled ?? true)
```

3. Add the handler next to `toggleSkipPerms` (line 48-51):

```ts
  const toggleNotify = (v: boolean) => {
    setNotifyEnabled(v)
    window.codey?.config?.set?.({ notifications: { enabled: v } }).catch(() => { /* ignore */ })
  }
```

4. Add the row directly AFTER the existing skip-permissions row (after line 113), inside the same `{loaded && ( ... )}` guard — i.e. restructure that guard to wrap both rows:

```tsx
      {loaded && (
        <>
          <div style={styles.row}>
            <div style={{ ...styles.label, width: 'auto', flex: 1 }}>
              <div>Skip permissions</div>
              <div style={{ fontSize: 11, color: C.fg3, fontWeight: 400, marginTop: 2 }}>
                When enabled, agents run shell commands, edit files, and make network requests without asking for confirmation. Disable to review every action before execution.
              </div>
            </div>
            <Toggle on={skipPerms} onChange={toggleSkipPerms}/>
          </div>

          <div style={styles.row}>
            <div style={{ ...styles.label, width: 'auto', flex: 1 }}>
              <div>Background notifications</div>
              <div style={{ fontSize: 11, color: C.fg3, fontWeight: 400, marginTop: 2 }}>
                Notify when Codey finishes, errors, or needs your input while the app is in the background.
              </div>
            </div>
            <Toggle on={notifyEnabled} onChange={toggleNotify}/>
          </div>
        </>
      )}
```

- [ ] **Step 2: Typecheck**

Run: `source ~/.nvm/nvm.sh && nvm use 22.17.1 && npx tsc -p tsconfig.json --noEmit`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add src/components/AppearanceTab.tsx
git commit -m "feat(codey-mac): settings toggle for background notifications

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Manual verification (dev app)

**Files:** none (temporary edits reverted).

- [ ] **Step 1: Launch and background the app**

```bash
cd /Users/jackou/Documents/projects/codey/codey-mac
source ~/.nvm/nvm.sh && nvm use 22.17.1 && npm run dev
```
Then unfocus the Codey window (click another app / the desktop).

- [ ] **Step 2: Completion notification**

Send a short prompt in a chat, immediately unfocus the app. When the turn finishes:
Expected: macOS notification "Codey finished — \<chat title\>" with response snippet. Clicking it focuses the window AND selects that chat.

- [ ] **Step 3: Question notification**

Send a prompt that triggers AskUserQuestion (e.g. "Ask me a multiple-choice question using AskUserQuestion before answering"). Unfocus.
Expected: "Codey needs your input — \<chat title\>" with the question text. In an unsigned dev build, action buttons may NOT render (accepted per spec) — verify the click path selects the chat and the question UI is visible inline. If buttons DO render, click one and verify the answer lands in the chat as a user message and a new turn starts.

- [ ] **Step 4: Error notification + unread badge**

Easiest deterministic error: temporarily set the chat's agent to a model name that doesn't exist (chat header Model dropdown), send a message, unfocus.
Expected: "Codey hit an error" notification; AND the in-app bell now shows the chat as unread (the errorSend fix) when you refocus without selecting it.

- [ ] **Step 5: Suppression checks**

- With the app focused: trigger a completion → NO native notification (in-app bell only).
- Settings → General → toggle "Background notifications" OFF → trigger a background completion → NO notification. Toggle back ON.

- [ ] **Step 6: Final check**

```bash
source ~/.nvm/nvm.sh && nvm use 22.17.1 && npx vitest run && git status
```
Expected: all tests pass; working tree clean (no leftover temporary edits).
