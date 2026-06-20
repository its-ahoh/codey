# Chat Context Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Codex-style right-side panel to `ChatTab` that shows per-turn run context (tool timeline, files touched, attachments, run target, pending team) for the currently selected assistant message. Auto-follows live during streaming, sticky on click.

**Architecture:** New `ChatContextPanel.tsx` component rendered as a third flex column inside `ChatTab.tsx`. All data is read-only views over existing `Chat` / `ChatMessage` state — no new gateway logic. Two small additions: `Chat.contextPanelOpen?: boolean` (per-chat preference, persisted via existing chat store) and a `shell:showItemInFolder` IPC for the "Reveal in Finder" affordance. Panel width persists in `localStorage`. Selection state (`selectedTurnId`, `followLatest`) is local to `ChatTab`.

**Tech Stack:** React 18 + TypeScript, Electron IPC (existing `window.codey.*` bridge), `shell.showItemInFolder` from Electron's `shell` module. No test runner — verification is via `npm run build` + manual smoke test.

**Spec:** `docs/superpowers/specs/2026-05-09-chat-context-panel-design.md`

---

## File Map

**Modify:**
- `packages/core/src/types/chat.ts` — add `contextPanelOpen?` to `Chat`
- `packages/gateway/src/chats.ts` — add `updateContextPanelOpen` method
- `codey-mac/electron/main.ts` — add `chats:updateContextPanelOpen` and `shell:showItemInFolder` IPC handlers
- `codey-mac/electron/preload.ts` — expose new IPC on `window.codey`
- `codey-mac/src/codey-api.d.ts` — add type declarations for new IPC
- `codey-mac/src/services/api.ts` — add `updateContextPanelOpen` wrapper and `revealInFolder` helper
- `codey-mac/src/hooks/useChats.tsx` — add `setContextPanelOpen` context method
- `codey-mac/src/components/ChatTab.tsx` — wrap layout in 2-column flex, add selection state, panel toggle button, ⌘⇧I shortcut, click-to-select on assistant messages

**Create:**
- `codey-mac/src/components/ChatContextPanel.tsx` — the new panel component

---

## Task 1: Add `contextPanelOpen` field to `Chat` type

**Files:**
- Modify: `packages/core/src/types/chat.ts`

- [ ] **Step 1: Add the field**

In `packages/core/src/types/chat.ts`, in the `Chat` interface, immediately after the `pendingTeam?: PendingTeamState;` line (currently line 56), insert:

```ts
  /** Per-chat preference for the right-side context panel in codey-mac.
   *  undefined = user hasn't decided; auto-open logic applies on first tool call.
   *  true/false = explicit user choice; honored verbatim. */
  contextPanelOpen?: boolean;
```

- [ ] **Step 2: Verify the package builds**

Run: `cd packages/core && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/types/chat.ts
git commit -m "core(chat): add Chat.contextPanelOpen preference field"
```

---

## Task 2: Add `updateContextPanelOpen` method to `ChatManager`

**Files:**
- Modify: `packages/gateway/src/chats.ts`

- [ ] **Step 1: Add the method**

In `packages/gateway/src/chats.ts`, immediately after the `updateAgentModel` method (currently ends around line 124, before `setPendingTeam`), insert:

```ts
  /** Set or clear the per-chat context-panel preference. Pass null to clear
   *  (returns to "undecided" so auto-open logic applies again). */
  updateContextPanelOpen(chatId: string, open: boolean | null): Chat {
    const chat = this.requireChat(chatId);
    if (open === null) delete chat.contextPanelOpen;
    else chat.contextPanelOpen = open;
    chat.updatedAt = Date.now();
    this.persist(chat);
    return chat;
  }
```

- [ ] **Step 2: Verify the package builds**

Run: `cd packages/gateway && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/gateway/src/chats.ts
git commit -m "gateway(chats): add updateContextPanelOpen for per-chat panel preference"
```

---

## Task 3: Wire IPC handler for `chats:updateContextPanelOpen` and `shell:showItemInFolder`

**Files:**
- Modify: `codey-mac/electron/main.ts`

- [ ] **Step 1: Add the chat IPC handler**

In `codey-mac/electron/main.ts`, find the existing `ipcMain.handle('chats:updateAgentModel', ...)` block (around line 690). Immediately after that block (and before whatever follows it), add:

```ts
ipcMain.handle('chats:updateContextPanelOpen', async (_e, id: string, open: boolean | null) =>
  withGateway(async () => {
    if (!inProcessGateway) throw new Error('Gateway not running');
    return inProcessGateway.getChatManager().updateContextPanelOpen(id, open);
  })
);
```

If the existing handlers in this file don't use a `withGateway` helper, mirror whatever wrapping pattern `chats:updateAgentModel` uses verbatim — same shape. Don't invent a new pattern.

- [ ] **Step 2: Add the shell IPC handler**

Immediately after the existing `ipcMain.handle('shell:openPath', ...)` block at line 824:

```ts
ipcMain.handle('shell:showItemInFolder', async (_event, p: string) => {
  if (typeof p !== 'string' || !p) return false;
  shell.showItemInFolder(p);
  return true;
});
```

`shell` is already imported at the top of the file (used by `shell:openPath`); no new import needed.

- [ ] **Step 3: Verify the file type-checks**

Run: `cd codey-mac && npx tsc --noEmit -p tsconfig.electron.json`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add codey-mac/electron/main.ts
git commit -m "electron(ipc): add chats:updateContextPanelOpen and shell:showItemInFolder"
```

---

## Task 4: Expose new IPC in preload + types

**Files:**
- Modify: `codey-mac/electron/preload.ts`
- Modify: `codey-mac/src/codey-api.d.ts`

- [ ] **Step 1: Add preload bridges**

In `codey-mac/electron/preload.ts`, inside the `chats: { ... }` object (find the existing `unlink:` line, currently the last entry in the chats block), add a new line at the end of that object:

```ts
    updateContextPanelOpen: (id: string, open: boolean | null) =>
      ipcRenderer.invoke('chats:updateContextPanelOpen', id, open),
```

Then, immediately after the existing `openPath` line at line 109:

```ts
  revealInFolder: (path: string) => ipcRenderer.invoke('shell:showItemInFolder', path),
```

- [ ] **Step 2: Add type declarations**

In `codey-mac/src/codey-api.d.ts`:

(a) Inside the `chats: { ... }` block (currently ends with `unlink: ...` around line 88), add:

```ts
        updateContextPanelOpen: (id: string, open: boolean | null) => Promise<IpcResult<Chat>>
```

(b) Immediately after the existing `openPath: (path: string) => Promise<string>` line (around line 109):

```ts
      revealInFolder: (path: string) => Promise<boolean>
```

- [ ] **Step 3: Verify both files type-check**

Run: `cd codey-mac && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add codey-mac/electron/preload.ts codey-mac/src/codey-api.d.ts
git commit -m "electron(preload): expose updateContextPanelOpen and revealInFolder"
```

---

## Task 5: Add API service wrappers

**Files:**
- Modify: `codey-mac/src/services/api.ts`

- [ ] **Step 1: Add the chat wrapper**

In `codey-mac/src/services/api.ts`, find the existing `updateAgentModel` wrapper (around line 154). Immediately after it, add:

```ts
    updateContextPanelOpen: async (id: string, open: boolean | null): Promise<Chat> =>
      unwrap(await window.codey.chats.updateContextPanelOpen(id, open)),
```

- [ ] **Step 2: Add the reveal helper**

This one isn't part of `chats`. Add it as a top-level `apiService` method. Find an unrelated top-level method (e.g. `pickDirectory` around line 80) and add nearby:

```ts
  revealInFolder: async (absPath: string): Promise<void> => {
    try { await window.codey.revealInFolder(absPath) } catch { /* silent no-op */ }
  },
```

- [ ] **Step 3: Verify it builds**

Run: `cd codey-mac && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add codey-mac/src/services/api.ts
git commit -m "mac(api): wrap updateContextPanelOpen and revealInFolder"
```

---

## Task 6: Add `setContextPanelOpen` action to `useChats`

**Files:**
- Modify: `codey-mac/src/hooks/useChats.tsx`

- [ ] **Step 1: Extend the context interface**

In `codey-mac/src/hooks/useChats.tsx`, in the `ChatsContextValue` interface (around line 173), add this method after `setAgentModel`:

```ts
  setContextPanelOpen: (chatId: string, open: boolean | null) => Promise<void>
```

- [ ] **Step 2: Implement the action**

In the same file, in the `value` object built inside `ChatsProvider` (around line 304), add this method after `setAgentModel`:

```ts
    async setContextPanelOpen(chatId, open) {
      const chat = await apiService.chats.updateContextPanelOpen(chatId, open)
      dispatch({ type: 'upsert', chat })
    },
```

- [ ] **Step 3: Verify it builds**

Run: `cd codey-mac && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add codey-mac/src/hooks/useChats.tsx
git commit -m "mac(useChats): add setContextPanelOpen action"
```

---

## Task 7: Create `ChatContextPanel.tsx` skeleton with header + run target

**Files:**
- Create: `codey-mac/src/components/ChatContextPanel.tsx`

- [ ] **Step 1: Create the file**

Create `codey-mac/src/components/ChatContextPanel.tsx` with:

```tsx
import React from 'react'
import type { Chat, ChatMessage } from '../types'
import { C } from '../theme'

interface Props {
  chat: Chat
  selectedTurnId: string | null
  followLatest: boolean
  /** 1-based index of the selected assistant turn in the chat (for "Turn N" display). */
  selectedTurnIndex: number | null
  /** Effective agent for this chat (resolved by ChatTab from override/worker/default). */
  effectiveAgent: string
  /** Effective model for this chat. May be undefined when no model is resolvable. */
  effectiveModel?: string
  /** Worker name actively bound to the selected turn, when chat selection is a worker. */
  workerName?: string
  /** Team name actively bound, when chat selection is a team. */
  teamName?: string
  width: number
  onFollowLatest: () => void
  onClose: () => void
  onResize: (next: number) => void
  onRevealFile: (absPath: string) => void
}

const fmtTime = (ts: number) =>
  new Date(ts).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' })

const formatTokens = (n: number): string | null => {
  if (!Number.isFinite(n) || n < 0) return null
  if (n < 1000) return String(n)
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`
  return `${Math.round(n / 1000)}k`
}

export const ChatContextPanel: React.FC<Props> = ({
  chat, selectedTurnId, followLatest, selectedTurnIndex,
  effectiveAgent, effectiveModel, workerName, teamName,
  width, onFollowLatest, onClose, onResize, onRevealFile,
}) => {
  const turn: ChatMessage | undefined = selectedTurnId
    ? chat.messages.find(m => m.id === selectedTurnId && m.role === 'assistant')
    : undefined

  // Resize drag handler
  const onResizerMouseDown = (e: React.MouseEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startW = width
    const move = (mv: MouseEvent) => {
      const next = Math.max(260, Math.min(520, startW + (startX - mv.clientX)))
      onResize(next)
    }
    const up = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  return (
    <div style={{ ...styles.root, width }}>
      <div style={styles.resizer} onMouseDown={onResizerMouseDown} title="Drag to resize" />
      {/* Header */}
      <div style={styles.header}>
        <div style={styles.headerMeta}>
          {turn ? (
            <>
              <span style={styles.headerTitle}>Turn {selectedTurnIndex ?? '?'}</span>
              <span style={styles.headerDot}>·</span>
              <span style={styles.headerSub}>{fmtTime(turn.timestamp)}</span>
              {turn.durationSec != null && Number.isFinite(turn.durationSec) && (
                <><span style={styles.headerDot}>·</span><span style={styles.headerSub}>{turn.durationSec}s</span></>
              )}
              {(() => {
                const t = turn.tokens != null ? formatTokens(turn.tokens) : null
                return t ? <><span style={styles.headerDot}>·</span><span style={styles.headerSub}>{t} tok</span></> : null
              })()}
            </>
          ) : (
            <span style={styles.headerSub}>No turn selected</span>
          )}
        </div>
        {!followLatest && (
          <button style={styles.followPill} onClick={onFollowLatest} title="Follow live updates">Follow latest ↓</button>
        )}
        <button style={styles.closeBtn} onClick={onClose} aria-label="Close panel">×</button>
      </div>

      <div style={styles.body}>
        {/* Run target */}
        <Section title="Run target">
          <div style={styles.runTargetRow}>
            {teamName ? `Team: ${teamName}` : workerName ? `Worker: ${workerName}` : 'Direct chat'}
          </div>
          <div style={styles.runTargetSub}>
            {effectiveAgent}{effectiveModel ? ` · ${effectiveModel}` : ''}
          </div>
        </Section>

        {/* Tool timeline + Files touched + Attachments + Pending team are
            added in later tasks. Placeholder for now: */}
        {!turn && <div style={styles.emptyHint}>Send a message to see run context.</div>}
      </div>
    </div>
  )
}

const Section: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <div style={styles.section}>
    <div style={styles.sectionTitle}>{title}</div>
    <div>{children}</div>
  </div>
)

const styles: Record<string, React.CSSProperties> = {
  root: {
    position: 'relative',
    height: '100%',
    background: C.surface2,
    borderLeft: `1px solid ${C.border}`,
    display: 'flex',
    flexDirection: 'column',
    flexShrink: 0,
  },
  resizer: {
    position: 'absolute',
    left: -3, top: 0, bottom: 0, width: 6,
    cursor: 'col-resize',
    zIndex: 5,
  },
  header: {
    display: 'flex', alignItems: 'center', gap: 8,
    padding: '10px 12px', borderBottom: `1px solid ${C.border}`,
    flexShrink: 0,
  },
  headerMeta: { flex: 1, display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, flexWrap: 'wrap' },
  headerTitle: { color: C.fg, fontSize: 12, fontWeight: 600 },
  headerSub: { color: C.fg3, fontSize: 11, fontVariantNumeric: 'tabular-nums' },
  headerDot: { color: C.fg3, fontSize: 11, opacity: 0.5 },
  followPill: {
    background: C.accent, color: '#fff', border: 'none',
    borderRadius: 10, fontSize: 10, padding: '2px 8px', cursor: 'pointer',
  },
  closeBtn: {
    background: 'transparent', border: 'none', color: C.fg2,
    fontSize: 18, lineHeight: 1, padding: '0 4px', cursor: 'pointer',
  },
  body: { flex: 1, overflowY: 'auto', padding: '8px 12px' },
  section: { marginBottom: 14 },
  sectionTitle: {
    color: C.fg3, fontSize: 10, fontWeight: 600, letterSpacing: 0.6,
    textTransform: 'uppercase', marginBottom: 6,
  },
  runTargetRow: { color: C.fg, fontSize: 12 },
  runTargetSub: { color: C.fg3, fontSize: 11, marginTop: 2 },
  emptyHint: { color: C.fg3, fontSize: 11, fontStyle: 'italic', padding: '12px 0' },
}
```

- [ ] **Step 2: Verify it builds**

Run: `cd codey-mac && npx tsc --noEmit`
Expected: no errors. (Component isn't used yet; just confirms types compile.)

- [ ] **Step 3: Commit**

```bash
git add codey-mac/src/components/ChatContextPanel.tsx
git commit -m "mac(ChatContextPanel): create panel skeleton with header and run target"
```

---

## Task 8: Wire panel into `ChatTab.tsx` (layout + selection state + open/close)

**Files:**
- Modify: `codey-mac/src/components/ChatTab.tsx`

- [ ] **Step 1: Add imports**

At the top of `codey-mac/src/components/ChatTab.tsx` (with the other component imports near line 8):

```tsx
import { ChatContextPanel } from './ChatContextPanel'
```

- [ ] **Step 2: Add panel state hooks**

Inside `ChatTab` after the existing `useState` calls (around line 105, after `pairingModal`), add:

```tsx
const [followLatest, setFollowLatest] = useState(true)
const [selectedTurnIdState, setSelectedTurnIdState] = useState<string | null>(null)
const [panelWidth, setPanelWidth] = useState<number>(() => {
  const v = localStorage.getItem('codey.contextPanelWidth')
  const n = v ? parseInt(v, 10) : NaN
  return Number.isFinite(n) ? Math.max(260, Math.min(520, n)) : 340
})
```

Also pull `setContextPanelOpen` out of `useChats`. Modify the existing destructure on line 87 from:

```tsx
const { state, sendMessage, stopChat, setSelection, setAgentModel, renameChat } = useChats()
```

to:

```tsx
const { state, sendMessage, stopChat, setSelection, setAgentModel, renameChat, setContextPanelOpen } = useChats()
```

- [ ] **Step 3: Compute the live "latest assistant turn" id and effective `selectedTurnId`**

Add after the existing `lastMsg` line (around line 147):

```tsx
const latestAssistantId: string | null = (() => {
  if (!chat) return null
  for (let i = chat.messages.length - 1; i >= 0; i--) {
    if (chat.messages[i].role === 'assistant') return chat.messages[i].id
  }
  return null
})()
const selectedTurnId: string | null = followLatest ? latestAssistantId : selectedTurnIdState
const selectedTurnIndex: number | null = (() => {
  if (!chat || !selectedTurnId) return null
  let n = 0
  for (const m of chat.messages) {
    if (m.role === 'assistant') {
      n++
      if (m.id === selectedTurnId) return n
    }
  }
  return null
})()
```

- [ ] **Step 4: Persist panel width to localStorage when it changes**

Add this `useEffect` near the other effects (around line 155):

```tsx
useEffect(() => { localStorage.setItem('codey.contextPanelWidth', String(panelWidth)) }, [panelWidth])
```

- [ ] **Step 5: Reset selection state when switching chats**

Add this effect:

```tsx
useEffect(() => {
  // Switching chats snaps back to follow-latest mode and clears any sticky pick.
  setFollowLatest(true)
  setSelectedTurnIdState(null)
}, [chatId])
```

- [ ] **Step 6: Snap to follow-latest on send**

In the existing `send` function (around line 271), add `setFollowLatest(true)` before `await sendMessage(...)`:

```tsx
setFollowLatest(true)
await sendMessage(chat.id, text, atts)
```

- [ ] **Step 7: Compute panel open state**

After computing `selectedTurnId`, add:

```tsx
const panelOpen: boolean = chat?.contextPanelOpen ?? false
```

(Auto-open on first tool call is implemented in Task 9. For now, the panel obeys the explicit preference only.)

- [ ] **Step 8: Add a panel toggle button in the header**

In the header JSX (around line 396, just before `<RouteIcons routes={chat.routes} />`), add:

```tsx
<button
  onClick={() => setContextPanelOpen(chat.id, !panelOpen)}
  style={styles.linkBtn}
  title={panelOpen ? 'Hide context panel (⌘⇧I)' : 'Show context panel (⌘⇧I)'}
>
  {panelOpen ? '◧' : '◨'}
</button>
```

- [ ] **Step 9: Add ⌘⇧I keyboard shortcut**

Add this effect alongside the existing Esc handler (around line 149):

```tsx
useEffect(() => {
  const h = (e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'i' || e.key === 'I')) {
      e.preventDefault()
      if (chat) setContextPanelOpen(chat.id, !(chat.contextPanelOpen ?? false))
    }
  }
  window.addEventListener('keydown', h)
  return () => window.removeEventListener('keydown', h)
}, [chat?.id, chat?.contextPanelOpen])
```

- [ ] **Step 10: Resolve worker / team display strings**

Just before the `return (` statement, add:

```tsx
const panelWorkerName = chat.selection.type === 'worker' ? chat.selection.name : undefined
const panelTeamName = chat.selection.type === 'team' ? chat.selection.name : undefined
```

- [ ] **Step 11: Restructure the JSX into a 2-column layout**

The current `return (...)` renders a single `<div style={styles.container}>` with header / messages / input as direct children. Wrap it into a 2-column flex:

Replace the outermost return JSX so it looks like this (preserving the entire existing inner structure as `mainColumn`):

```tsx
return (
  <div style={styles.outer}>
    <div style={styles.mainColumn}>
      {/* existing content: header div, messages div, orphanBanner, inputContainer, PairingModal */}
      ...
    </div>
    {panelOpen && (
      <ChatContextPanel
        chat={chat}
        selectedTurnId={selectedTurnId}
        followLatest={followLatest}
        selectedTurnIndex={selectedTurnIndex}
        effectiveAgent={effectiveAgent}
        effectiveModel={effectiveModel}
        workerName={panelWorkerName}
        teamName={panelTeamName}
        width={panelWidth}
        onFollowLatest={() => setFollowLatest(true)}
        onClose={() => setContextPanelOpen(chat.id, false)}
        onResize={setPanelWidth}
        onRevealFile={(p) => apiService.revealInFolder(p)}
      />
    )}
  </div>
)
```

- [ ] **Step 12: Add new styles**

In the `styles` object at the bottom of the file, add `outer` and `mainColumn` (the existing `container` style stays as-is and is still used by mainColumn):

```ts
outer: { display: 'flex', flexDirection: 'row', height: '100%', minHeight: 0 },
mainColumn: { display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, height: '100%' },
```

Then replace the existing top-level wrapper inside `mainColumn` from `<div style={styles.container}>` to `<div style={styles.mainColumn}>` so the inner column fills correctly. Or simpler: keep the inner `<div style={styles.container}>` as-is and have `mainColumn` simply be `{ flex: 1, minWidth: 0, display: 'flex', minHeight: 0 }` so `container` (which is already `display: flex, flexDirection: column, height: 100%`) lays out within it. Use whichever is cleaner; the goal is: row container holds the existing column + the panel.

- [ ] **Step 13: Make assistant messages clickable to select-as-sticky**

In the message map (around line 415), each message renders a wrapper `<div key={msg.id} style={{...}}>`. For assistant messages, make the wrapper clickable and add a left-border highlight when selected.

Modify the `<div key={msg.id} style={{...}}>` so it accepts an extra `onClick` and conditional border:

```tsx
const isSelected = !isUser && msg.id === selectedTurnId && panelOpen
return (
  <div
    key={msg.id}
    onClick={isUser ? undefined : () => {
      setSelectedTurnIdState(msg.id)
      setFollowLatest(false)
    }}
    style={{
      display: 'flex', flexDirection: 'column',
      alignItems: isUser ? 'flex-end' : 'flex-start',
      marginBottom: 12,
      cursor: isUser ? 'default' : 'pointer',
      paddingLeft: !isUser ? 6 : 0,
      borderLeft: isSelected ? `2px solid ${C.accent}` : '2px solid transparent',
    }}
  >
    {/* unchanged inner content */}
  </div>
)
```

- [ ] **Step 14: Verify build**

Run: `cd codey-mac && npm run build`
Expected: build succeeds.

- [ ] **Step 15: Manual smoke test**

Run: `cd codey-mac && npm run dev` (or whatever the existing dev command is)
- Open a chat. Press ⌘⇧I — panel toggles.
- Click the toggle button in the header — panel toggles. Reload the app — preference persists per chat.
- Send a message that triggers tool calls. Panel header updates with turn meta. Run target shows agent/model.
- Click an older assistant message — panel header swaps to that turn, "Follow latest ↓" pill appears, left border highlights the selected message.
- Click "Follow latest ↓" — pill disappears, panel snaps to newest.
- Send a new message — panel snaps to newest automatically.
- Drag the resize handle on the panel's left edge — width adjusts and persists across reload.

- [ ] **Step 16: Commit**

```bash
git add codey-mac/src/components/ChatTab.tsx
git commit -m "mac(ChatTab): wire ChatContextPanel into 2-column layout with sticky selection"
```

---

## Task 9: Auto-open panel on first tool call when `contextPanelOpen` is undefined

**Files:**
- Modify: `codey-mac/src/components/ChatTab.tsx`

- [ ] **Step 1: Add the auto-open effect**

In `ChatTab.tsx`, near the other effects, add:

```tsx
useEffect(() => {
  if (!chat) return
  if (chat.contextPanelOpen !== undefined) return // already decided
  // Find any assistant message in this chat that has at least one tool call.
  const hasToolActivity = chat.messages.some(
    m => m.role === 'assistant' && (m.toolCalls?.length ?? 0) > 0
  )
  if (hasToolActivity) {
    setContextPanelOpen(chat.id, true)
  }
}, [chat?.id, chat?.messages.length, chat?.contextPanelOpen])
```

The dependency on `chat?.messages.length` covers the streaming case — the effect re-runs as new messages arrive and as tool calls append (which mutates `chat.messages` length only on new entries, but the live `toolCall` reducer also bumps `updatedAt`, so the chat reference changes per dispatch). To be safe, also depend on the latest assistant message's tool-call count:

```tsx
useEffect(() => {
  if (!chat) return
  if (chat.contextPanelOpen !== undefined) return
  const hasToolActivity = chat.messages.some(
    m => m.role === 'assistant' && (m.toolCalls?.length ?? 0) > 0
  )
  if (hasToolActivity) setContextPanelOpen(chat.id, true)
}, [chat?.id, chat?.contextPanelOpen, lastMsg?.toolCalls?.length])
```

(`lastMsg` is already defined upstream.)

- [ ] **Step 2: Verify build**

Run: `cd codey-mac && npm run build`
Expected: build succeeds.

- [ ] **Step 3: Manual test**

- Create a brand-new chat. Confirm panel is closed.
- Send a prompt that triggers tool calls. Panel auto-opens on first tool call.
- Close the panel. Send another prompt — panel stays closed (preference now `false`).
- Create another new chat — auto-open behavior repeats (independent per chat).

- [ ] **Step 4: Commit**

```bash
git add codey-mac/src/components/ChatTab.tsx
git commit -m "mac(ChatTab): auto-open context panel on first tool-call activity per chat"
```

---

## Task 10: Add Tool Calls Timeline section to `ChatContextPanel`

**Files:**
- Modify: `codey-mac/src/components/ChatContextPanel.tsx`

- [ ] **Step 1: Add timeline rendering**

In `codey-mac/src/components/ChatContextPanel.tsx`, replace the current placeholder body region (the `{!turn && <div ...>}` block) with a fuller body that renders the timeline below the run-target section. Add this above the closing `</div>` of `<div style={styles.body}>`:

```tsx
{turn && <ToolTimeline toolCalls={turn.toolCalls ?? []} />}
{turn && (turn.toolCalls?.length ?? 0) === 0 && (
  <Section title="Tool calls">
    <div style={styles.emptyHint}>No tool activity for this turn.</div>
  </Section>
)}
```

Remove the `{!turn && ...}` placeholder line — replaced below.

- [ ] **Step 2: Add the `ToolTimeline` component above the `Section` helper**

```tsx
const ToolTimeline: React.FC<{ toolCalls: import('../types').ToolCallEntry[] }> = ({ toolCalls }) => {
  const [expanded, setExpanded] = React.useState<Set<string>>(new Set())

  // Pair tool_start with tool_end by id; collapse into one row per pair.
  type Row =
    | { kind: 'call'; id: string; tool?: string; input?: Record<string, unknown>; output?: string; done: boolean; message: string }
    | { kind: 'info'; id: string; message: string }
  const rows: Row[] = []
  const startIdxById = new Map<string, number>()
  for (const tc of toolCalls) {
    if (tc.type === 'info') {
      rows.push({ kind: 'info', id: tc.id, message: tc.message })
      continue
    }
    if (tc.type === 'tool_start') {
      const idx = rows.push({
        kind: 'call', id: tc.id, tool: tc.tool, input: tc.input,
        done: false, message: tc.message,
      }) - 1
      startIdxById.set(tc.id, idx)
    } else { // tool_end
      const idx = startIdxById.get(tc.id)
      if (idx != null) {
        const row = rows[idx] as Extract<Row, { kind: 'call' }>
        row.done = true
        if (tc.output) row.output = tc.output
        if (tc.message) row.message = tc.message
        startIdxById.delete(tc.id)
      } else {
        rows.push({
          kind: 'call', id: tc.id, tool: tc.tool, output: tc.output,
          done: true, message: tc.message,
        })
      }
    }
  }

  if (rows.length === 0) return null
  return (
    <Section title="Tool calls">
      <div style={timelineStyles.list}>
        {rows.map(r => {
          if (r.kind === 'info') {
            return (
              <div key={r.id} style={timelineStyles.infoRow}>
                <span style={timelineStyles.iconInfo}>ⓘ</span>
                <span>{r.message}</span>
              </div>
            )
          }
          const isOpen = expanded.has(r.id)
          const hasDetail = !!r.input || !!r.output
          const toggle = () => setExpanded(prev => {
            const next = new Set(prev)
            next.has(r.id) ? next.delete(r.id) : next.add(r.id)
            return next
          })
          const icon = !r.done ? '▶' : '✓'
          return (
            <div key={r.id}>
              <div
                style={{ ...timelineStyles.callRow, cursor: hasDetail ? 'pointer' : 'default' }}
                onClick={hasDetail ? toggle : undefined}
              >
                <span style={r.done ? timelineStyles.iconDone : timelineStyles.iconRunning}>{icon}</span>
                <span style={timelineStyles.tool}>{r.tool ?? '(tool)'}</span>
                <span style={timelineStyles.callMsg}>{r.message}</span>
              </div>
              {hasDetail && isOpen && (
                <div style={timelineStyles.detail}>
                  {r.input && (
                    <>
                      <div style={timelineStyles.detailLabel}>input</div>
                      <pre style={timelineStyles.code}>{JSON.stringify(r.input, null, 2)}</pre>
                    </>
                  )}
                  {r.output && (
                    <>
                      <div style={timelineStyles.detailLabel}>output</div>
                      <pre style={timelineStyles.code}>{truncate(r.output, 2048)}</pre>
                    </>
                  )}
                  {!r.done && !r.output && (
                    <div style={timelineStyles.detailLabel}>(no result yet)</div>
                  )}
                  {r.done && !r.output && !r.input && (
                    <div style={timelineStyles.detailLabel}>(no result)</div>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </Section>
  )
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return s.slice(0, max) + `\n… (${s.length - max} more chars)`
}

const timelineStyles: Record<string, React.CSSProperties> = {
  list: { display: 'flex', flexDirection: 'column', gap: 4 },
  infoRow: {
    display: 'flex', alignItems: 'flex-start', gap: 6,
    color: C.fg3, fontSize: 11, fontStyle: 'italic',
  },
  callRow: {
    display: 'flex', alignItems: 'flex-start', gap: 6,
    fontSize: 12, fontFamily: 'Menlo, Monaco, "Courier New", monospace',
    padding: '2px 0',
  },
  tool: { color: '#9bbcd9', flexShrink: 0 },
  callMsg: { color: C.fg2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  iconRunning: { color: '#6ab0f3', width: 12, flexShrink: 0 },
  iconDone: { color: '#7ec97e', width: 12, flexShrink: 0 },
  iconInfo: { color: C.fg3, width: 12, flexShrink: 0 },
  detail: {
    marginLeft: 18, marginTop: 4, marginBottom: 6,
    padding: 8, background: 'rgba(0,0,0,0.3)',
    border: `1px solid ${C.border}`, borderRadius: 6,
    maxHeight: 280, overflowY: 'auto',
  },
  detailLabel: { color: C.fg3, fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 4 },
  code: {
    color: C.fg, fontSize: 11, fontFamily: 'Menlo, Monaco, "Courier New", monospace',
    margin: '4px 0 0 0', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
  },
}
```

- [ ] **Step 2: Verify build**

Run: `cd codey-mac && npm run build`
Expected: build succeeds.

- [ ] **Step 3: Manual test**

- Send a prompt that triggers `Read` / `Edit` / `Bash` tool calls. Confirm rows appear, paired correctly (one row per tool, ✓ when done).
- Click a row with input/output. Detail expands, showing input JSON and truncated output.
- Confirm a turn with no tool calls shows "No tool activity for this turn."

- [ ] **Step 4: Commit**

```bash
git add codey-mac/src/components/ChatContextPanel.tsx
git commit -m "mac(ChatContextPanel): add tool-calls timeline section with expandable detail"
```

---

## Task 11: Add Files Touched section

**Files:**
- Modify: `codey-mac/src/components/ChatContextPanel.tsx`

- [ ] **Step 1: Add the FilesTouched component**

Add this component above the existing `ToolTimeline` definition:

```tsx
const FILE_TOOLS = new Set(['Read', 'Edit', 'Write', 'NotebookEdit'])

const FilesTouched: React.FC<{
  toolCalls: import('../types').ToolCallEntry[]
  workingDir?: string
  onReveal: (absPath: string) => void
}> = ({ toolCalls, workingDir, onReveal }) => {
  const paths: string[] = []
  const seen = new Set<string>()
  for (const tc of toolCalls) {
    if (tc.type !== 'tool_start') continue
    if (!tc.tool || !FILE_TOOLS.has(tc.tool)) continue
    const p = (tc.input as any)?.file_path
    if (typeof p !== 'string' || !p) continue
    if (!seen.has(p)) { seen.add(p); paths.push(p) }
  }
  if (paths.length === 0) return null

  const display = (abs: string): string => {
    if (workingDir && abs.startsWith(workingDir)) {
      const rel = abs.slice(workingDir.length).replace(/^\/+/, '')
      return rel || abs
    }
    return abs
  }

  return (
    <Section title="Files touched">
      <div style={filesStyles.list}>
        {paths.sort().map(p => (
          <div key={p} style={filesStyles.row} title={p}>
            <span style={filesStyles.path}>{display(p)}</span>
            <button
              style={filesStyles.iconBtn}
              onClick={() => onReveal(p)}
              title="Reveal in Finder"
            >⤴</button>
            <button
              style={filesStyles.iconBtn}
              onClick={() => navigator.clipboard.writeText(p)}
              title="Copy path"
            >⧉</button>
          </div>
        ))}
      </div>
    </Section>
  )
}

const filesStyles: Record<string, React.CSSProperties> = {
  list: { display: 'flex', flexDirection: 'column', gap: 2 },
  row: {
    display: 'flex', alignItems: 'center', gap: 4,
    padding: '2px 0', fontSize: 11,
  },
  path: {
    flex: 1, color: C.fg2, fontFamily: 'Menlo, Monaco, "Courier New", monospace',
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0,
  },
  iconBtn: {
    background: 'transparent', border: 'none', color: C.fg3,
    cursor: 'pointer', fontSize: 12, padding: '0 4px', flexShrink: 0,
  },
}
```

- [ ] **Step 2: Pass `workingDir` from `ChatTab` into the panel**

In `codey-mac/src/components/ChatTab.tsx`, fetch the workspace's `workingDir` once per chat. Add a state hook near the other state:

```tsx
const [workingDir, setWorkingDir] = useState<string | undefined>(undefined)
useEffect(() => {
  if (!chat?.workspaceName) return
  apiService.getWorkspaceInfo(chat.workspaceName)
    .then(info => setWorkingDir(info.workingDir))
    .catch(() => setWorkingDir(undefined))
}, [chat?.workspaceName])
```

Then add a `workingDir` prop to the `ChatContextPanel` invocation in `ChatTab`:

```tsx
workingDir={workingDir}
```

- [ ] **Step 3: Add the prop in `ChatContextPanel.tsx`**

Add `workingDir?: string` to the `Props` interface, destructure it in the component, and render `<FilesTouched ... />` immediately after `<ToolTimeline ... />` in the body:

```tsx
{turn && <FilesTouched toolCalls={turn.toolCalls ?? []} workingDir={workingDir} onReveal={onRevealFile} />}
```

- [ ] **Step 4: Verify build**

Run: `cd codey-mac && npm run build`
Expected: build succeeds.

- [ ] **Step 5: Manual test**

- Send a prompt that runs `Read`/`Edit`/`Write` on files. Confirm "Files touched" lists those file paths, deduped, relative to workspace `workingDir`.
- Click "⤴" — Finder reveals the file (or silently no-ops if missing).
- Click "⧉" — absolute path is copied to clipboard.

- [ ] **Step 6: Commit**

```bash
git add codey-mac/src/components/ChatContextPanel.tsx codey-mac/src/components/ChatTab.tsx
git commit -m "mac(ChatContextPanel): add files-touched section with reveal-in-finder and copy-path"
```

---

## Task 12: Add Attachments + Pending Team sections

**Files:**
- Modify: `codey-mac/src/components/ChatContextPanel.tsx`

- [ ] **Step 1: Add the AttachmentsSection component**

Add this above the `Section` helper:

```tsx
const AttachmentsSection: React.FC<{ attachments: import('../types').FileAttachment[] }> = ({ attachments }) => {
  if (!attachments.length) return null
  return (
    <Section title="Attachments">
      <div style={attStyles.row}>
        {attachments.map(a => {
          const isImage = a.mimeType.startsWith('image/')
          if (isImage) {
            return (
              <img
                key={a.id}
                src={`codey-asset://file/${encodeURIComponent(a.path)}`}
                alt={a.name}
                title={a.name}
                style={attStyles.img}
                onClick={() => window.codey?.openPath?.(a.path)}
              />
            )
          }
          return (
            <div key={a.id} style={attStyles.chip} title={a.name} onClick={() => window.codey?.openPath?.(a.path)}>
              {a.name}
            </div>
          )
        })}
      </div>
    </Section>
  )
}

const attStyles: Record<string, React.CSSProperties> = {
  row: { display: 'flex', flexWrap: 'wrap', gap: 6 },
  img: {
    width: 64, height: 64, objectFit: 'cover',
    borderRadius: 6, border: `1px solid ${C.border2}`, cursor: 'pointer',
  },
  chip: {
    padding: '4px 8px', background: C.surface3, border: `1px solid ${C.border2}`,
    borderRadius: 6, fontSize: 11, color: C.fg2, cursor: 'pointer',
    maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
}
```

- [ ] **Step 2: Add the PendingTeamSection component**

Add this above the `Section` helper:

```tsx
const PendingTeamSection: React.FC<{ pending: NonNullable<Chat['pendingTeam']> }> = ({ pending }) => {
  // PendingTeamState is a discriminated union by `mode`; both variants have
  // `askingWorker` and `question` (see packages/core/src/types/pending-team.ts).
  const workerName = pending.askingWorker
  const question = pending.question
  return (
    <Section title="Pending team">
      <div style={pendStyles.callout}>
        <div style={pendStyles.title}>Waiting on input for {workerName}</div>
        {question && <div style={pendStyles.body}>{question}</div>}
        <div style={pendStyles.hint}>Type a reply in the chat to resume the team.</div>
      </div>
    </Section>
  )
}

const pendStyles: Record<string, React.CSSProperties> = {
  callout: {
    background: 'rgba(255, 196, 0, 0.10)', border: '1px solid rgba(255, 196, 0, 0.35)',
    borderRadius: 6, padding: '8px 10px',
  },
  title: { color: C.fg, fontSize: 12, fontWeight: 600, marginBottom: 4 },
  body: { color: C.fg2, fontSize: 11, marginBottom: 6, whiteSpace: 'pre-wrap' },
  hint: { color: C.fg3, fontSize: 10, fontStyle: 'italic' },
}
```

- [ ] **Step 3: Compute the triggering user message and render both sections**

In the `ChatContextPanel` component body, just after the `turn` lookup, also derive the user message that immediately preceded the selected turn:

```tsx
const triggeringUserMsg: ChatMessage | undefined = (() => {
  if (!turn) return undefined
  const idx = chat.messages.findIndex(m => m.id === turn.id)
  if (idx <= 0) return undefined
  for (let i = idx - 1; i >= 0; i--) {
    if (chat.messages[i].role === 'user') return chat.messages[i]
  }
  return undefined
})()
```

Then in the body region, after `<FilesTouched ... />`, add:

```tsx
{triggeringUserMsg?.attachments && triggeringUserMsg.attachments.length > 0 && (
  <AttachmentsSection attachments={triggeringUserMsg.attachments} />
)}
{chat.pendingTeam && turn && turn.id === (() => {
  // latest assistant message id
  for (let i = chat.messages.length - 1; i >= 0; i--) {
    if (chat.messages[i].role === 'assistant') return chat.messages[i].id
  }
  return null
})() && <PendingTeamSection pending={chat.pendingTeam} />}
```

- [ ] **Step 4: Verify build**

Run: `cd codey-mac && npm run build`
Expected: build succeeds.

- [ ] **Step 5: Manual test**

- Send a message with attached image / file. Select that turn. Confirm Attachments section renders with thumbnail / chip; click opens file.
- Run a `/team` command that pauses with `[ASK_USER]` (a recent commit added pause-on-ASK_USER, see commit `65561e1`). Confirm the yellow Pending team callout appears on the latest turn and disappears once the team resumes.
- Confirm Attachments section is hidden when the user message has none, and Pending team callout is hidden when not paused.

- [ ] **Step 6: Commit**

```bash
git add codey-mac/src/components/ChatContextPanel.tsx
git commit -m "mac(ChatContextPanel): add attachments and pending-team sections"
```

---

## Task 13: Responsive auto-collapse below 900px window width

**Files:**
- Modify: `codey-mac/src/components/ChatTab.tsx`

- [ ] **Step 1: Add a responsive override**

In `ChatTab.tsx`, add window-width tracking via an effect:

```tsx
const [winNarrow, setWinNarrow] = useState<boolean>(() => window.innerWidth < 900)
useEffect(() => {
  const onResize = () => setWinNarrow(window.innerWidth < 900)
  window.addEventListener('resize', onResize)
  return () => window.removeEventListener('resize', onResize)
}, [])
```

Then change the `panelOpen` derivation so it's force-closed when `winNarrow` is true, without overwriting the persisted preference:

```tsx
const panelOpen: boolean = !winNarrow && (chat?.contextPanelOpen ?? false)
```

- [ ] **Step 2: Verify build**

Run: `cd codey-mac && npm run build`
Expected: build succeeds.

- [ ] **Step 3: Manual test**

- Open the panel. Resize window narrower than 900px — panel hides without persisting `false`. Resize back wider — panel reappears. Confirm the persisted preference (in chat JSON) hasn't flipped.

- [ ] **Step 4: Commit**

```bash
git add codey-mac/src/components/ChatTab.tsx
git commit -m "mac(ChatTab): auto-collapse context panel below 900px window width"
```

---

## Task 14: Final verification

- [ ] **Step 1: Top-level build**

Run: `npm run build`
Expected: builds across all packages cleanly.

- [ ] **Step 2: Full smoke test**

In the dev app:
- Brand-new chat → send tool-using prompt → panel auto-opens.
- Toggle via header button and ⌘⇧I; preference persists per chat across reload.
- Click old assistant turn → sticky selection with left-border highlight, "Follow latest ↓" pill appears.
- Click pill → snaps to newest. Send new message → also snaps.
- Tool timeline pairs start/end, expand to see input/output.
- Files touched lists relative paths; reveal-in-finder works; copy-path works.
- User message with image attachment → Attachments section renders thumbnail in the next turn's panel view.
- `/team` command that pauses → Pending team callout appears on latest turn.
- Resize panel via drag handle; width persists across reload, clamped to 260–520px.
- Window narrower than 900px → panel hides, preference unchanged.

- [ ] **Step 3: No commit needed** unless verification turned up a fix.
