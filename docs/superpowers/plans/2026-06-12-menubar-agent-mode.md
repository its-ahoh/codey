# Menubar-Agent Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the codey-mac tray into a live agent surface — a dropdown with a status header, needs-attention / running / recent chat sections (click to jump), plus launch-at-login and dock-less toggles.

**Architecture:** A pure, unit-tested state module (`electron/tray-state.ts`) reduces chat stream events into a per-chat `{ inFlight, needsAttention }` map and summarizes header counts + section lists. Thin main-process glue feeds it from the existing `setChatEventListener`, debounce-rebuilds the tray `Menu`, and applies `ui.launchAtLogin` / `ui.dockless` from config. Two renderer settings toggles + a `notify:openSettings` subscription complete it.

**Tech Stack:** Electron (Tray, Menu, app.setLoginItemSettings, app.dock), React 18, TypeScript, vitest.

**Spec:** `docs/superpowers/specs/2026-06-12-menubar-agent-mode-design.md`

**Environment notes (IMPORTANT):**
- All commands run from `/Users/jackou/Documents/projects/codey/codey-mac`.
- Default Node v16 CANNOT run vitest/tsc: prefix with `source ~/.nvm/nvm.sh && nvm use 22.17.1`.
- Branch: create `feat/menubar-agent` FROM `feat/quick-capture` (stacked; reuses `notify:openChat` and `toggleCaptureWindow`, same main.ts regions).
- `docs/` is gitignored — never force-add.

---

### Task 0: Branch setup

- [ ] **Step 1:**

```bash
cd /Users/jackou/Documents/projects/codey
git checkout feat/quick-capture && git checkout -b feat/menubar-agent
```

---

### Task 1: Persist `notifications` / `capture` / `ui` in ConfigManager

**Why:** `ConfigManager` persists config through a three-site allowlist —
a field in `GatewayConfigJson`, a branch in `normalize()` (loader), and a
branch in `update()` (writer) — exactly as `voice` has at
`packages/gateway/src/config.ts:66`, `:182`, `:565`. `notifications`,
`capture`, and `ui` have NONE of these, so `config.set({ notifications: ... })`
(#115), `config.set({ capture: ... })` (#116), and this feature's
`config.set({ ui: ... })` are all silently dropped on save, and any
hand-written values are stripped on load. This task fixes all three.

**Files:**
- Modify: `packages/gateway/src/config.ts`

- [ ] **Step 1: Add the type fields**

In `GatewayConfigJson` (interface starts `packages/gateway/src/config.ts:8`),
after the existing `voice?: {...}` block (~line 66-onwards), add:

```ts
  notifications?: { enabled?: boolean };
  capture?: { hotkey?: string };
  ui?: { launchAtLogin?: boolean; dockless?: boolean };
```

- [ ] **Step 2: Add update() branches**

In `update()` (the `if (partial.voice !== undefined) ...` line is `:182`), the
`ui` block must DEEP-merge so `launchAtLogin` and `dockless` don't clobber each
other; `notifications` and `capture` are single-key so a shallow merge is fine
but use the same defensive spread. After the `voice` line add:

```ts
    if (partial.notifications !== undefined) {
      this.config.notifications = { ...this.config.notifications, ...partial.notifications };
    }
    if (partial.capture !== undefined) {
      this.config.capture = { ...this.config.capture, ...partial.capture };
    }
    if (partial.ui !== undefined) {
      this.config.ui = { ...this.config.ui, ...partial.ui };
    }
```

(The `{ ...existing, ...partial }` merge means a renderer write of
`{ ui: { launchAtLogin: true } }` preserves a previously-saved `dockless`.)

- [ ] **Step 3: Add normalize() branches**

In `normalize()` (the `if (raw.voice && typeof raw.voice === 'object') { out.voice = raw.voice }`
block is `:565-566`), after it add:

```ts
  if (raw.notifications && typeof raw.notifications === 'object') {
    out.notifications = { enabled: raw.notifications.enabled };
  }
  if (raw.capture && typeof raw.capture === 'object') {
    out.capture = { hotkey: raw.capture.hotkey };
  }
  if (raw.ui && typeof raw.ui === 'object') {
    out.ui = { launchAtLogin: raw.ui.launchAtLogin, dockless: raw.ui.dockless };
  }
```

(`normalize`'s `raw` param is typed `Partial<GatewayConfigJson> & {...}`; since
Step 1 added these to the interface, `raw.notifications` etc. typecheck.)

- [ ] **Step 4: Build the gateway package + verify**

The codey-mac app imports the COMPILED gateway (`@codey/gateway` →
`packages/gateway/dist`). Rebuild it so main.ts sees the change:

```bash
cd /Users/jackou/Documents/projects/codey/packages/gateway && source ~/.nvm/nvm.sh && nvm use 22.17.1 && npx tsc -p tsconfig.json
cd /Users/jackou/Documents/projects/codey/codey-mac && npx tsc -p tsconfig.electron.json --noEmit
```
Expected: gateway compiles; codey-mac electron typecheck exits 0. (If the
gateway has its own build script, prefer `npm run build` in that package — check
`packages/gateway/package.json` scripts first.)

- [ ] **Step 5: Commit**

```bash
cd /Users/jackou/Documents/projects/codey
git add packages/gateway/src/config.ts packages/gateway/dist
git commit -m "fix(config): persist notifications, capture, and ui settings blocks

ConfigManager's normalize()/update() allowlists dropped these keys, so the
#115 notifications toggle and #116 capture-hotkey rebind never survived a save.
Adds the type fields plus loader/writer branches (ui deep-merges).

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

(If `packages/gateway/dist` is gitignored, commit only `src/config.ts` and
ensure the build step is part of the run process; check `git status` after
building.)

---

### Task 2: Pure tray-state module (`electron/tray-state.ts`)

**Files:**
- Create: `codey-mac/electron/tray-state.ts`
- Test: `codey-mac/electron/tray-state.test.ts`

- [ ] **Step 1: Write the failing test**

Create `codey-mac/electron/tray-state.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { applyEvent, clearAttention, summarize } from './tray-state'

const ev = (type: string, chatId: string, extra: Record<string, unknown> = {}) => ({ type, chatId, ...extra })

describe('applyEvent', () => {
  it('non-terminal event marks the chat in-flight', () => {
    const s = applyEvent({}, ev('stream', 'c1'))
    expect(s.c1).toEqual({ inFlight: true, needsAttention: false })
  })

  it('plain done clears in-flight without attention', () => {
    let s = applyEvent({}, ev('tool_start', 'c1'))
    s = applyEvent(s, ev('done', 'c1', { response: 'ok' }))
    expect(s.c1).toEqual({ inFlight: false, needsAttention: false })
  })

  it('done with userQuestion raises needsAttention', () => {
    let s = applyEvent({}, ev('thinking', 'c1'))
    s = applyEvent(s, ev('done', 'c1', { userQuestion: { question: 'q', options: [] } }))
    expect(s.c1).toEqual({ inFlight: false, needsAttention: true })
  })

  it('error raises needsAttention', () => {
    const s = applyEvent({}, ev('error', 'c1', { message: 'boom' }))
    expect(s.c1).toEqual({ inFlight: false, needsAttention: true })
  })

  it('stopped clears in-flight without attention', () => {
    let s = applyEvent({}, ev('stream', 'c1'))
    s = applyEvent(s, ev('stopped', 'c1'))
    expect(s.c1).toEqual({ inFlight: false, needsAttention: false })
  })

  it('a new turn clears prior needsAttention', () => {
    let s = applyEvent({}, ev('error', 'c1'))
    expect(s.c1.needsAttention).toBe(true)
    s = applyEvent(s, ev('queued', 'c1', { position: 1 }))
    expect(s.c1).toEqual({ inFlight: true, needsAttention: false })
  })

  it('is immutable — does not mutate the input map', () => {
    const before = {}
    applyEvent(before, ev('stream', 'c1'))
    expect(before).toEqual({})
  })

  it('ignores events without a string chatId', () => {
    expect(applyEvent({}, { type: 'stream' } as any)).toEqual({})
  })
})

describe('clearAttention', () => {
  it('clears the flag for one chat, leaves others', () => {
    let s = applyEvent({}, ev('error', 'c1'))
    s = applyEvent(s, ev('error', 'c2'))
    s = clearAttention(s, 'c1')
    expect(s.c1.needsAttention).toBe(false)
    expect(s.c2.needsAttention).toBe(true)
  })

  it('no-ops on unknown chat', () => {
    expect(clearAttention({}, 'ghost')).toEqual({})
  })
})

describe('summarize', () => {
  it('Idle when nothing is happening', () => {
    expect(summarize({}).header).toBe('Idle')
    expect(summarize({ c1: { inFlight: false, needsAttention: false } }).header).toBe('Idle')
  })

  it('counts running only', () => {
    const s = { a: { inFlight: true, needsAttention: false }, b: { inFlight: true, needsAttention: false } }
    expect(summarize(s)).toEqual({ header: '2 running', needsAttention: [], running: ['a', 'b'] })
  })

  it('counts attention only', () => {
    const s = { a: { inFlight: false, needsAttention: true } }
    expect(summarize(s)).toEqual({ header: '1 needs attention', needsAttention: ['a'], running: [] })
  })

  it('combines, attention first, no chat double-listed', () => {
    const s = {
      a: { inFlight: false, needsAttention: true },
      b: { inFlight: true, needsAttention: false },
    }
    expect(summarize(s)).toEqual({
      header: '1 needs attention · 1 running',
      needsAttention: ['a'],
      running: ['b'],
    })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `source ~/.nvm/nvm.sh && nvm use 22.17.1 && npx vitest run electron/tray-state.test.ts`
Expected: FAIL — cannot find module './tray-state'.

- [ ] **Step 3: Write minimal implementation**

Create `codey-mac/electron/tray-state.ts`:

```ts
// Pure reducer + summary for the menu-bar tray state. No Electron imports so
// it is unit-testable; main.ts feeds it chat events and renders the summary
// into a Tray menu.

export interface ChatTrayState { inFlight: boolean; needsAttention: boolean }
export type TrayStateMap = Record<string, ChatTrayState>

export interface TrayEvent { type: string; chatId: string; userQuestion?: unknown }

const TERMINAL = new Set(['done', 'error', 'stopped'])

export function applyEvent(state: TrayStateMap, ev: TrayEvent): TrayStateMap {
  if (!ev || typeof ev.chatId !== 'string') return state
  const id = ev.chatId
  if (!TERMINAL.has(ev.type)) {
    // Any non-terminal event = a (new) turn is running; clear stale attention.
    return { ...state, [id]: { inFlight: true, needsAttention: false } }
  }
  if (ev.type === 'error') {
    return { ...state, [id]: { inFlight: false, needsAttention: true } }
  }
  if (ev.type === 'done' && ev.userQuestion) {
    return { ...state, [id]: { inFlight: false, needsAttention: true } }
  }
  // plain done / stopped — a completed turn has no outstanding ask.
  return { ...state, [id]: { inFlight: false, needsAttention: false } }
}

export function clearAttention(state: TrayStateMap, chatId: string): TrayStateMap {
  const prev = state[chatId]
  if (!prev || !prev.needsAttention) return state
  return { ...state, [chatId]: { ...prev, needsAttention: false } }
}

export interface TraySummary { header: string; needsAttention: string[]; running: string[] }

export function summarize(state: TrayStateMap): TraySummary {
  const needsAttention: string[] = []
  const running: string[] = []
  for (const [id, s] of Object.entries(state)) {
    if (s.needsAttention) needsAttention.push(id)
    else if (s.inFlight) running.push(id)
  }
  const parts: string[] = []
  if (needsAttention.length) parts.push(`${needsAttention.length} needs attention`)
  if (running.length) parts.push(`${running.length} running`)
  return { header: parts.length ? parts.join(' · ') : 'Idle', needsAttention, running }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `source ~/.nvm/nvm.sh && nvm use 22.17.1 && npx vitest run electron/tray-state.test.ts`
Expected: PASS (all describe blocks).

Note: the plain-done/stopped branch resets `needsAttention` to `false` (a
completed turn has no outstanding ask) — written directly in the code above,
no post-hoc edit needed.

- [ ] **Step 5: Commit**

```bash
git add electron/tray-state.ts electron/tray-state.test.ts
git commit -m "feat(codey-mac): pure tray-state reducer and summary for menu-bar mode

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Live tray menu (status + chats + actions)

**Files:**
- Modify: `codey-mac/electron/main.ts` (imports; `createTray` at ~244-276; the `setChatEventListener` callback at ~626; add helpers)

- [ ] **Step 1: Imports + module state**

1. Add import: `import { applyEvent, clearAttention, summarize } from './tray-state'`
2. Add module state near `let tray ...`:

```ts
let trayState: import('./tray-state').TrayStateMap = {}
let trayRebuildTimer: NodeJS.Timeout | null = null
```

- [ ] **Step 2: Feed events + debounce rebuild**

In `bootInProcessCore()`'s `setChatEventListener` callback (~626), extend:

```ts
    inProcessGateway.setChatEventListener((ev: any) => {
      sendToRenderer('chats:event', ev)
      maybeNotify(ev)
      trayState = applyEvent(trayState, ev)
      scheduleTrayRebuild()
    })
```

- [ ] **Step 3: Rebuild helpers + openChatFromTray**

Add near `createTray()`:

```ts
function scheduleTrayRebuild() {
  if (trayRebuildTimer) return
  trayRebuildTimer = setTimeout(() => {
    trayRebuildTimer = null
    rebuildTrayMenu()
  }, 250)
}

function openChatFromTray(chatId: string) {
  mainWindow?.show()
  mainWindow?.focus()
  trayState = clearAttention(trayState, chatId)
  sendToRenderer('notify:openChat', { chatId })
  scheduleTrayRebuild()
}

function chatLabel(chatId: string): string | null {
  try {
    const c = inProcessGateway?.getChatManager().get(chatId)
    if (!c) return null
    return `${c.title || 'Untitled'} — ${c.workspaceName}`
  } catch { return null }
}

function rebuildTrayMenu() {
  if (!tray) return
  try {
    const summary = summarize(trayState)
    const items: Electron.MenuItemConstructorOptions[] = [
      { label: summary.header, enabled: false },
    ]
    const shown = new Set<string>()
    const addChat = (id: string, prefix = '') => {
      const label = chatLabel(id)
      if (!label) return
      shown.add(id)
      items.push({ label: prefix + label, click: () => openChatFromTray(id) })
    }
    if (summary.needsAttention.length) {
      items.push({ type: 'separator' }, { label: 'Needs attention', enabled: false })
      summary.needsAttention.forEach(id => addChat(id, '● '))
    }
    if (summary.running.length) {
      items.push({ type: 'separator' }, { label: 'Running', enabled: false })
      summary.running.forEach(id => addChat(id))
    }
    // Up to 5 most-recent chats not already shown above.
    try {
      const recent = (inProcessGateway?.getChatManager().list() ?? [])
        .filter((c: any) => !shown.has(c.id))
        .slice(0, 5)
      if (recent.length) {
        items.push({ type: 'separator' }, { label: 'Recent', enabled: false })
        recent.forEach((c: any) => items.push({
          label: `${c.title || 'Untitled'} — ${c.workspaceName}`,
          click: () => openChatFromTray(c.id),
        }))
      }
    } catch { /* list unavailable — skip recent section */ }
    items.push(
      { type: 'separator' },
      { label: 'Open Codey', click: () => { mainWindow?.show(); mainWindow?.focus() } },
      { label: 'Quick Capture', click: () => toggleCaptureWindow() },
      { label: 'Settings', click: () => { mainWindow?.show(); mainWindow?.focus(); sendToRenderer('notify:openSettings') } },
      { type: 'separator' },
      { label: 'Quit', click: () => { isQuitting = true; app.quit() } },
    )
    tray.setContextMenu(Menu.buildFromTemplate(items))
    tray.setToolTip(`Codey — ${summary.header}`)
  } catch (err: any) {
    sendToRenderer('gateway-log', `[tray] menu rebuild failed: ${err?.message ?? err}`)
  }
}
```

- [ ] **Step 4: Use the dynamic menu in createTray**

In `createTray()` (~252-271), REMOVE the static `contextMenu` block and its
`tray.setContextMenu(contextMenu)` + `tray.setToolTip('Codey - Gateway Control')`
lines, and instead call `rebuildTrayMenu()` once after `tray = new Tray(icon)`:

```ts
  tray = new Tray(icon)
  rebuildTrayMenu()
  tray.on('click', () => {
    mainWindow?.show()
    mainWindow?.focus()
  })
```

(Keep the icon-loading lines above unchanged.)

- [ ] **Step 5: Typecheck**

Run: `source ~/.nvm/nvm.sh && nvm use 22.17.1 && npx tsc -p tsconfig.electron.json --noEmit`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add electron/main.ts
git commit -m "feat(codey-mac): live tray menu with status header, active chats, and actions

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Launch-at-login + dock-less (main process)

**Files:**
- Modify: `codey-mac/electron/main.ts`

- [ ] **Step 1: applyUiPreferences**

Add a helper near `applyCaptureHotkey`:

```ts
function applyUiPreferences(rawCfg: any) {
  try {
    app.setLoginItemSettings({ openAtLogin: !!rawCfg?.ui?.launchAtLogin })
  } catch (err: any) {
    sendToRenderer('gateway-log', `[ui] setLoginItemSettings failed: ${err?.message ?? err}`)
  }
  if (rawCfg?.ui?.dockless) app.dock?.hide()
  else app.dock?.show()
}
```

- [ ] **Step 2: Call it at boot + on config change**

In `bootInProcessCore()`, at the two sites where `applyCaptureHotkey` is
called (config-change listener and boot), add `applyUiPreferences(...)` with
the same argument:

```ts
      applyVoiceHotkey(updated)
      applyCaptureHotkey(updated)
      applyUiPreferences(updated)
```
```ts
    applyVoiceHotkey(coreConfigManager.get())
    applyCaptureHotkey(coreConfigManager.get())
    applyUiPreferences(coreConfigManager.get())
```

- [ ] **Step 3: Typecheck**

Run: `source ~/.nvm/nvm.sh && nvm use 22.17.1 && npx tsc -p tsconfig.electron.json --noEmit`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add electron/main.ts
git commit -m "feat(codey-mac): apply launch-at-login and dock-less prefs from config

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Settings toggles + open-settings subscription

**Files:**
- Modify: `codey-mac/src/components/AppearanceTab.tsx`
- Modify: `codey-mac/electron/preload.ts`
- Modify: `codey-mac/src/codey-api.d.ts`
- Modify: `codey-mac/src/App.tsx`

- [ ] **Step 1: preload — onOpenSettings**

In `codey-mac/electron/preload.ts`, in the existing `notify:` section (added in
the notifications feature), add a sibling subscription:

```ts
    onOpenSettings: (handler: () => void) => {
      const listener = () => handler()
      ipcRenderer.on('notify:openSettings', listener)
      return () => ipcRenderer.removeListener('notify:openSettings', listener)
    },
```

(Place it inside the `notify: { ... }` object next to `onOpenChat`.)

- [ ] **Step 2: types**

In `codey-mac/src/codey-api.d.ts`, in the `notify` entry, add:

```ts
        onOpenSettings: (handler: () => void) => () => void
```

- [ ] **Step 3: App subscribes**

In `codey-mac/src/App.tsx`, the Shell component already has
`setSettingsOpen` / `setSettingsTab` (lines ~27-29) and renders
`SettingsOverlay` with `initialTab`. Add an effect inside `Shell`:

```tsx
  useEffect(() => {
    const off = window.codey.notify.onOpenSettings(() => {
      setSettingsTab('general')
      setSettingsOpen(true)
    })
    return off
  }, [])
```

- [ ] **Step 4: AppearanceTab toggles**

In `codey-mac/src/components/AppearanceTab.tsx` (which already has the
skipPerms / notifyEnabled / captureHotkey rows inside `{loaded && (<>...</>)}`):

1. State next to the others:

```ts
  const [launchAtLogin, setLaunchAtLogin] = React.useState<boolean>(false)
  const [dockless, setDockless] = React.useState<boolean>(false)
```

2. In the mount effect after the existing `set...` lines:

```ts
      setLaunchAtLogin(cfg?.ui?.launchAtLogin ?? false)
      setDockless(cfg?.ui?.dockless ?? false)
```

3. Handlers next to the others:

```ts
  const toggleLaunchAtLogin = (v: boolean) => {
    setLaunchAtLogin(v)
    window.codey?.config?.set?.({ ui: { launchAtLogin: v } }).catch(() => { /* ignore */ })
  }
  const toggleDockless = (v: boolean) => {
    setDockless(v)
    window.codey?.config?.set?.({ ui: { dockless: v } }).catch(() => { /* ignore */ })
  }
```

4. Two new rows inside the `{loaded && (<>...</>)}` fragment, after the
   Quick-capture-hotkey row:

```tsx
          <div style={styles.row}>
            <div style={{ ...styles.label, width: 'auto', flex: 1 }}>
              <div>Launch Codey at login</div>
              <div style={{ fontSize: 11, color: C.fg3, fontWeight: 400, marginTop: 2 }}>
                Start Codey automatically when you log in, so the gateway and menu bar are always available.
              </div>
            </div>
            <Toggle on={launchAtLogin} onChange={toggleLaunchAtLogin}/>
          </div>

          <div style={styles.row}>
            <div style={{ ...styles.label, width: 'auto', flex: 1 }}>
              <div>Hide Dock icon (menu bar only)</div>
              <div style={{ fontSize: 11, color: C.fg3, fontWeight: 400, marginTop: 2 }}>
                Run as a menu-bar app with no Dock icon. Codey stays reachable from the menu bar.
              </div>
            </div>
            <Toggle on={dockless} onChange={toggleDockless}/>
          </div>
```

Important: `config:set` must DEEP-MERGE the `ui` object so launchAtLogin and
dockless don't clobber each other. Verify the existing ConfigManager merge
behavior — if `config.set({ ui: { launchAtLogin: v } })` shallow-replaces the
whole `ui` block, change both handlers to spread the known current values, e.g.
`window.codey.config.set({ ui: { launchAtLogin: v, dockless } })` and
`{ ui: { dockless: v, launchAtLogin } }`. Check `ConfigManager.update`/merge in
`packages/core` before deciding; default to the spread-both form if unsure.

- [ ] **Step 5: Typecheck + tests**

Run: `source ~/.nvm/nvm.sh && nvm use 22.17.1 && npx tsc -p tsconfig.json --noEmit && npx vitest run`
Expected: clean; all pass.

- [ ] **Step 6: Commit**

```bash
git add src/components/AppearanceTab.tsx electron/preload.ts src/codey-api.d.ts src/App.tsx
git commit -m "feat(codey-mac): settings toggles for launch-at-login and dock-less mode

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Manual verification (dev app)

**Files:** none.

- [ ] **Step 1:** Kill stale instances (`pkill -f "MacOS/Electron \."`), then
  `cd codey-mac && source ~/.nvm/nvm.sh && nvm use 22.17.1 && npm run dev`.
- [ ] **Step 2:** Open the menu-bar dropdown with no activity → header "Idle",
  tooltip "Codey — Idle", action items present (Open Codey / Quick Capture /
  Settings / Quit) plus a Recent section.
- [ ] **Step 3:** Send a short no-tools prompt → within ~250ms the dropdown
  header shows "1 running" and the chat appears under Running; on completion it
  drops back to Idle / Recent.
- [ ] **Step 4:** Trigger an AskUserQuestion turn → chat appears under "Needs
  attention" with a ● prefix and header "1 needs attention". Click it → main
  window focuses, that chat is selected, and it leaves the needs-attention
  section on next rebuild.
- [ ] **Step 5:** Tray menu → Quick Capture opens the capture window; Settings
  opens the settings overlay on General.
- [ ] **Step 6:** Settings → General → toggle "Launch Codey at login" on →
  verify in a separate terminal:
  `osascript -e 'tell application "System Events" to get the name of every login item'`
  shows Electron/Codey, or check via the app's own
  `app.getLoginItemSettings().openAtLogin` logged on next config change. Toggle
  off → removed.
- [ ] **Step 7:** Toggle "Hide Dock icon" on → Dock icon disappears (window
  still reachable from the tray); toggle off → Dock icon returns. Confirm both
  toggles persist and don't clobber each other (set both on, reopen Settings).
- [ ] **Step 8:** `source ~/.nvm/nvm.sh && nvm use 22.17.1 && npx vitest run && git status`
  — all pass, tree clean.
