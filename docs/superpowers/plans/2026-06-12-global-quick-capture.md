# Global Quick-Capture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A global `Option+Space` hotkey summons a small always-on-top capture window from anywhere; typing a task and hitting Enter creates a new chat in the chosen workspace and dispatches it in the background.

**Architecture:** A second frameless `BrowserWindow` shares the existing renderer bundle via a `#/capture` hash route and the same preload. The hotkey reuses the voice-hotkey pattern (`globalShortcut` + config-change re-registration). Dispatch happens entirely in the main process (`getChatManager().create` + `sendToChat` with a no-op sink — the global chat-event listener mirrors to the main window, Aide auto-titles, and the #115 notification pipeline reports completion). Pure logic (accelerator normalization + submit validation) lives in a vitest-tested module.

**Tech Stack:** Electron (BrowserWindow, globalShortcut, screen), React 18, TypeScript, vitest.

**Spec:** `docs/superpowers/specs/2026-06-12-global-quick-capture-design.md`

**Environment notes (IMPORTANT):**
- All commands run from `/Users/jackou/Documents/projects/codey/codey-mac`.
- Default Node is v16 and CANNOT run vitest/tsc: prefix with `source ~/.nvm/nvm.sh && nvm use 22.17.1`.
- Branch: create `feat/quick-capture` FROM `feat/native-notifications` (stacked; reuses #115's `notify:openChat` path and the same main.ts regions).
- `docs/` is gitignored on purpose — never force-add.

---

### Task 0: Branch setup

- [ ] **Step 1:**

```bash
cd /Users/jackou/Documents/projects/codey
git checkout feat/native-notifications && git checkout -b feat/quick-capture
```

---

### Task 1: Pure logic module (`electron/capture.ts`)

**Files:**
- Create: `codey-mac/electron/capture.ts`
- Test: `codey-mac/electron/capture.test.ts`

- [ ] **Step 1: Write the failing test**

Create `codey-mac/electron/capture.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { captureAccelerator, resolveCaptureSubmit, DEFAULT_CAPTURE_HOTKEY } from './capture'

describe('captureAccelerator', () => {
  it('defaults to Alt+Space when unset', () => {
    expect(captureAccelerator(undefined)).toBe(DEFAULT_CAPTURE_HOTKEY)
    expect(DEFAULT_CAPTURE_HOTKEY).toBe('Alt+Space')
  })

  it('blank string disables', () => {
    expect(captureAccelerator('')).toBeNull()
    expect(captureAccelerator('   ')).toBeNull()
  })

  it('normalizes the WhisperTab-stored format to an Electron accelerator', () => {
    expect(captureAccelerator('Meta+Shift+K')).toBe('CommandOrControl+Shift+K')
    expect(captureAccelerator('Alt+ ')).toBe('Alt+Space')
    expect(captureAccelerator('option+space')).toBe('Alt+Space')
    expect(captureAccelerator('ctrl+j')).toBe('Control+J')
  })

  it('rejects Fn (not bindable via globalShortcut)', () => {
    expect(captureAccelerator('Fn')).toBeNull()
    expect(captureAccelerator(' fn ')).toBeNull()
  })
})

describe('resolveCaptureSubmit', () => {
  const ws = ['codey', 'default']

  it('trims text and resolves a known workspace', () => {
    expect(resolveCaptureSubmit('  do the thing  ', 'default', ws))
      .toEqual({ ok: true, text: 'do the thing', workspaceName: 'default' })
  })

  it('rejects empty text', () => {
    expect(resolveCaptureSubmit('   ', 'codey', ws)).toEqual({ ok: false, error: 'Nothing to send' })
  })

  it('rejects when no workspaces exist', () => {
    expect(resolveCaptureSubmit('task', 'codey', [])).toEqual({ ok: false, error: 'No workspaces configured' })
  })

  it('falls back to the first workspace when the name is missing or unknown', () => {
    expect(resolveCaptureSubmit('task', undefined, ws))
      .toEqual({ ok: true, text: 'task', workspaceName: 'codey' })
    expect(resolveCaptureSubmit('task', 'ghost', ws))
      .toEqual({ ok: true, text: 'task', workspaceName: 'codey' })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `source ~/.nvm/nvm.sh && nvm use 22.17.1 && npx vitest run electron/capture.test.ts`
Expected: FAIL — cannot find module './capture'.

- [ ] **Step 3: Write minimal implementation**

Create `codey-mac/electron/capture.ts`:

```ts
// Pure logic for the global quick-capture feature. No Electron imports so it
// is unit-testable; main.ts owns the BrowserWindow/globalShortcut glue.

export const DEFAULT_CAPTURE_HOTKEY = 'Alt+Space'

// Same normalization as main.ts's toElectronAccelerator (WhisperTab format →
// Electron accelerator), kept pure here for testability.
function normalizeAccelerator(hotkey: string): string {
  return hotkey
    .split('+')
    .map(p => p.trim())
    .map(p => {
      const low = p.toLowerCase()
      if (low === 'meta' || low === 'cmd' || low === 'command') return 'CommandOrControl'
      if (low === 'control' || low === 'ctrl') return 'Control'
      if (low === 'alt' || low === 'option') return 'Alt'
      if (low === 'shift') return 'Shift'
      if (low === '' || low === 'space') return 'Space'
      return p.length === 1 ? p.toUpperCase() : p
    })
    .join('+')
}

// undefined → feature default; blank → disabled; Fn → disabled (Electron's
// globalShortcut cannot bind Fn — that path exists only for the voice helper).
export function captureAccelerator(hotkey: string | undefined): string | null {
  if (hotkey === undefined) return DEFAULT_CAPTURE_HOTKEY
  const t = hotkey.trim()
  if (!t) return null
  if (t.toLowerCase() === 'fn') return null
  return normalizeAccelerator(t)
}

export type CaptureSubmitResolution =
  | { ok: true; text: string; workspaceName: string }
  | { ok: false; error: string }

export function resolveCaptureSubmit(
  text: string,
  workspaceName: string | undefined,
  knownWorkspaces: string[],
): CaptureSubmitResolution {
  const trimmed = text.trim()
  if (!trimmed) return { ok: false, error: 'Nothing to send' }
  if (knownWorkspaces.length === 0) return { ok: false, error: 'No workspaces configured' }
  const ws = workspaceName && knownWorkspaces.includes(workspaceName)
    ? workspaceName
    : knownWorkspaces[0]
  return { ok: true, text: trimmed, workspaceName: ws }
}
```

Note the `'Alt+ '` test case: splitting `'Alt+ '` on `+` yields `['Alt', ' ']` and the trimmed `' '` becomes `''` → maps to `Space`.

- [ ] **Step 4: Run test to verify it passes**

Run: `source ~/.nvm/nvm.sh && nvm use 22.17.1 && npx vitest run electron/capture.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add electron/capture.ts electron/capture.test.ts
git commit -m "feat(codey-mac): pure capture-submit and hotkey logic for quick capture

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Extract HotkeyRecorder to a shared component

**Files:**
- Create: `codey-mac/src/components/HotkeyRecorder.tsx`
- Modify: `codey-mac/src/components/WhisperTab.tsx` (delete lines ~104-231: MODIFIER_KEYS, LOCK_KEYS, formatKeyCombo, formatHotkeyString, HotkeyRecorder; add import)

- [ ] **Step 1: Create the shared component**

Create `codey-mac/src/components/HotkeyRecorder.tsx` by MOVING the following from `WhisperTab.tsx` verbatim (read WhisperTab.tsx first; the moved block is between the `// ── Hotkey recorder ──` comment and the `// ── WhisperTab ──` comment): `MODIFIER_KEYS`, `LOCK_KEYS`, `formatKeyCombo`, `formatHotkeyString`, and the `HotkeyRecorder` component. Adjustments in the new file:

1. Header + imports:

```tsx
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { C } from '../theme'
```

2. `HotkeyRecorder` references two WhisperTab-local styles; give the new file its own copies (verbatim from WhisperTab.tsx lines ~70-81):

```tsx
const inputStyle: React.CSSProperties = {
  background: C.surface3, border: `1px solid ${C.border2}`, borderRadius: 7,
  color: C.fg, fontSize: 13, padding: '6px 10px', outline: 'none', width: 180,
}
const pillButton = (variant: 'primary' | 'danger' | 'ghost'): React.CSSProperties => ({
  padding: '6px 12px', borderRadius: 7, fontSize: 12, fontWeight: 600,
  border: 'none', cursor: 'pointer',
  background: variant === 'primary' ? C.accent : variant === 'danger' ? C.red + '22' : C.surface3,
  color: variant === 'primary' ? C.onAccent : variant === 'danger' ? C.red : C.fg2,
})
```

3. Export the component (was a private const): `export const HotkeyRecorder: React.FC<{ value: string; onChange: (hotkey: string) => void }> = ...` — body unchanged.

- [ ] **Step 2: Update WhisperTab.tsx**

Delete the moved block (the four helpers + component, keeping the `// ── Hotkey recorder ──` section removed entirely) and add at the top:

```tsx
import { HotkeyRecorder } from './HotkeyRecorder'
```

The single usage at WhisperTab.tsx:484 (`<HotkeyRecorder value={voice.hotkey} onChange={...}/>`) is unchanged. If `formatHotkeyString` or the other helpers are referenced elsewhere in WhisperTab.tsx (grep before deleting!), export them from HotkeyRecorder.tsx and import them too.

- [ ] **Step 3: Typecheck + tests**

Run: `source ~/.nvm/nvm.sh && nvm use 22.17.1 && npx tsc -p tsconfig.json --noEmit && npx vitest run`
Expected: clean; all pass.

- [ ] **Step 4: Commit**

```bash
git add src/components/HotkeyRecorder.tsx src/components/WhisperTab.tsx
git commit -m "refactor(codey-mac): extract HotkeyRecorder into a shared component

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Main-process capture window, hotkey, and IPC

**Files:**
- Modify: `codey-mac/electron/main.ts`
- Modify: `codey-mac/electron/preload.ts`
- Modify: `codey-mac/src/codey-api.d.ts`

- [ ] **Step 1: main.ts — window + toggle + hotkey**

1. Ensure `screen` is in the electron import list at the top (add if missing): `import { app, BrowserWindow, ..., screen } from 'electron'`.
2. Add import: `import { captureAccelerator, resolveCaptureSubmit } from './capture'`
3. Add module state next to `let mainWindow ...`: `let captureWindow: BrowserWindow | null = null`
4. Add below `createWindow()`:

```ts
// ── Quick capture window ─────────────────────────────────────────────
function createCaptureWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 560,
    height: 120,
    show: false,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    fullscreenable: false,
    backgroundColor: '#141414',
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  if (isDev) {
    win.loadURL('http://localhost:5173/#/capture')
  } else {
    win.loadFile(join(__dirname, '../dist/index.html'), { hash: '/capture' })
  }
  win.on('blur', () => { win.hide() })
  win.on('closed', () => { captureWindow = null })
  return win
}

function toggleCaptureWindow() {
  if (!captureWindow || captureWindow.isDestroyed()) captureWindow = createCaptureWindow()
  if (captureWindow.isVisible()) { captureWindow.hide(); return }
  // Center horizontally, upper third vertically, on the display under the cursor.
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  const { x, y, width, height } = display.workArea
  const [w] = captureWindow.getSize()
  captureWindow.setPosition(Math.round(x + (width - w) / 2), Math.round(y + height * 0.25))
  captureWindow.show()
  captureWindow.focus()
  captureWindow.webContents.send('capture:shown')
}

let currentCaptureAccelerator: string | null = null
function applyCaptureHotkey(rawCfg: any) {
  const desired = captureAccelerator(rawCfg?.capture?.hotkey)
  if (currentCaptureAccelerator && currentCaptureAccelerator !== desired) {
    try { globalShortcut.unregister(currentCaptureAccelerator) } catch { /* not registered */ }
    currentCaptureAccelerator = null
  }
  if (!desired || currentCaptureAccelerator === desired) return
  const ok = globalShortcut.register(desired, toggleCaptureWindow)
  if (ok) {
    currentCaptureAccelerator = desired
  } else {
    sendToRenderer('gateway-log', `[capture] hotkey registration failed (in use by another app?): ${desired}`)
  }
}
```

5. Call `applyCaptureHotkey` at the two `applyVoiceHotkey` call sites in `bootInProcessCore()` (config-change listener ~line 523 and boot ~line 529):

```ts
      applyVoiceHotkey(updated)
      applyCaptureHotkey(updated)
```
```ts
    applyVoiceHotkey(coreConfigManager.get())
    applyCaptureHotkey(coreConfigManager.get())
```

- [ ] **Step 2: main.ts — IPC handlers**

Register next to the `core:state` / `app:relaunch` handlers (the pre-boot-await block inside `app.whenReady().then(...)`):

```ts
  ipcMain.handle('capture:submit', async (_e, payload: { workspaceName?: string; text: string }) =>
    wrap(async () => {
      if (!inProcessGateway || !workspaceManager) throw new Error('Core not ready — open Codey to check its status')
      const known = workspaceManager.listWorkspaces()
      const resolved = resolveCaptureSubmit(payload?.text ?? '', payload?.workspaceName, known)
      if (!resolved.ok) throw new Error(resolved.error)
      const chat = inProcessGateway.getChatManager().create({ workspaceName: resolved.workspaceName })
      // Fire and forget: the global chatEventListener mirrors events to the
      // main window, Aide auto-titles, and the notification pipeline reports
      // completion/errors.
      void inProcessGateway.sendToChat(chat.id, resolved.text, () => { /* no-op sink */ })
      captureWindow?.hide()
      try {
        const notif = new Notification({
          title: `Task sent to ${resolved.workspaceName}`,
          body: resolved.text.slice(0, 120),
          silent: true,
        })
        notif.on('click', () => {
          mainWindow?.show()
          sendToRenderer('notify:openChat', { chatId: chat.id })
        })
        notif.show()
      } catch { /* notification is best-effort */ }
      return { chatId: chat.id }
    })
  )
  ipcMain.handle('capture:hide', async () =>
    wrap(async () => { captureWindow?.hide() })
  )
```

- [ ] **Step 3: preload.ts**

After the `notify:` section, add:

```ts
  capture: {
    submit: (payload: { workspaceName?: string; text: string }) => ipcRenderer.invoke('capture:submit', payload),
    hide: () => ipcRenderer.invoke('capture:hide'),
    onShown: (handler: () => void) => {
      const listener = () => handler()
      ipcRenderer.on('capture:shown', listener)
      return () => ipcRenderer.removeListener('capture:shown', listener)
    },
  },
```

- [ ] **Step 4: codey-api.d.ts**

After the `notify` entry inside `Window['codey']`, add:

```ts
      capture: {
        submit: (payload: { workspaceName?: string; text: string }) => Promise<IpcResult<{ chatId: string }>>
        hide: () => Promise<IpcResult<void>>
        onShown: (handler: () => void) => () => void
      }
```

- [ ] **Step 5: Typecheck**

```bash
source ~/.nvm/nvm.sh && nvm use 22.17.1 \
  && npx tsc -p tsconfig.electron.json --noEmit \
  && npx tsc -p tsconfig.json --noEmit
```
Expected: both exit 0.

- [ ] **Step 6: Commit**

```bash
git add electron/main.ts electron/preload.ts src/codey-api.d.ts
git commit -m "feat(codey-mac): global Alt+Space capture window with main-process dispatch

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Capture renderer (`#/capture` route)

**Files:**
- Create: `codey-mac/src/components/CaptureWindow.tsx`
- Modify: `codey-mac/src/main.tsx`

- [ ] **Step 1: Create CaptureWindow.tsx**

```tsx
import React, { useEffect, useRef, useState } from 'react'
import {
  C, applyTheme, applyPalette, getStoredThemeMode, getStoredPalette,
  paletteToCssVars, classicLight, classicDark, terminalLight, terminalDark,
} from '../theme'

// Spotlight-style capture UI rendered in its own frameless BrowserWindow
// (#/capture route). Enter dispatches via capture:submit; main hides the
// window on success. Escape hides; main also hides on blur.
export const CaptureWindow: React.FC = () => {
  const [text, setText] = useState('')
  const [workspaces, setWorkspaces] = useState<string[]>([])
  const [workspace, setWorkspace] = useState<string>('')
  const [error, setError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const taRef = useRef<HTMLTextAreaElement>(null)

  const loadWorkspaces = async () => {
    try {
      const res = await window.codey.workspaces.list()
      if (res.ok && res.data) {
        const list = res.data
        setWorkspaces(list)
        const last = localStorage.getItem('codey.lastWorkspace')
        setWorkspace(prev =>
          prev && list.includes(prev) ? prev
            : last && list.includes(last) ? last
            : list[0] ?? '')
      }
    } catch { /* core offline — submit will surface the error */ }
  }

  useEffect(() => {
    applyTheme(getStoredThemeMode())
    applyPalette(getStoredPalette())
    void loadWorkspaces()
    taRef.current?.focus()
    const off = window.codey.capture.onShown(() => {
      setError(null)
      void loadWorkspaces()
      setTimeout(() => taRef.current?.focus(), 0)
    })
    return off
  }, [])

  const submit = async () => {
    if (sending) return
    setSending(true)
    setError(null)
    try {
      const res = await window.codey.capture.submit({ workspaceName: workspace || undefined, text })
      if (res.ok) {
        setText('')
        if (workspace) localStorage.setItem('codey.lastWorkspace', workspace)
      } else {
        setError(res.error)
      }
    } catch (e: any) {
      setError(e?.message ?? String(e))
    } finally {
      setSending(false)
    }
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void submit()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      void window.codey.capture.hide()
    }
  }

  return (
    <div style={styles.root}>
      <div style={styles.row}>
        <textarea
          ref={taRef}
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="What should Codey do? (↵ to send, esc to dismiss)"
          rows={2}
          autoFocus
          style={styles.input}
        />
        <select
          aria-label="Workspace"
          value={workspace}
          onChange={e => setWorkspace(e.target.value)}
          style={styles.select}
        >
          {workspaces.map(w => <option key={w} value={w}>{w}</option>)}
        </select>
      </div>
      {error && <div style={styles.error}>{error}</div>}
      <style>{`
  /* Same theme matrix as App.tsx so applyTheme/applyPalette take effect. */
  :root { ${paletteToCssVars(classicDark)} }
  :root[data-theme="light"] { ${paletteToCssVars(classicLight)} }
  :root[data-theme="dark"] { ${paletteToCssVars(classicDark)} }
  :root[data-palette="classic"][data-theme="light"] { ${paletteToCssVars(classicLight)} }
  :root[data-palette="classic"][data-theme="dark"] { ${paletteToCssVars(classicDark)} }
  :root[data-palette="terminal"][data-theme="light"] { ${paletteToCssVars(terminalLight)} }
  :root[data-palette="terminal"][data-theme="dark"] { ${paletteToCssVars(terminalDark)} }
  html, body, #root { height: 100%; margin: 0; background: transparent; }
  body { font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif; }
  * { box-sizing: border-box; }
`}</style>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  root: {
    height: '100vh', display: 'flex', flexDirection: 'column', gap: 6,
    padding: 12, background: C.bg, borderRadius: 10,
    border: `1px solid ${C.border}`, overflow: 'hidden',
  },
  row: { display: 'flex', gap: 8, flex: 1, minHeight: 0 },
  input: {
    flex: 1, resize: 'none', background: C.surface2, color: C.fg,
    border: `1px solid ${C.border2}`, borderRadius: 8, padding: '10px 12px',
    fontSize: 14, outline: 'none', fontFamily: 'inherit',
  },
  select: {
    alignSelf: 'stretch', background: C.surface2, color: C.fg2,
    border: `1px solid ${C.border2}`, borderRadius: 8, padding: '0 8px',
    fontSize: 12, cursor: 'pointer', maxWidth: 140,
  },
  error: { color: C.dangerFg, fontSize: 11, paddingLeft: 2, flexShrink: 0 },
}
```

- [ ] **Step 2: Branch in main.tsx**

Replace the full contents of `codey-mac/src/main.tsx` with:

```tsx
import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { CaptureWindow } from './components/CaptureWindow'

// The quick-capture BrowserWindow loads the same bundle with #/capture.
const isCapture = window.location.hash.startsWith('#/capture')

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {isCapture ? <CaptureWindow /> : <App />}
  </React.StrictMode>
)
```

- [ ] **Step 3: Typecheck + tests**

Run: `source ~/.nvm/nvm.sh && nvm use 22.17.1 && npx tsc -p tsconfig.json --noEmit && npx vitest run`
Expected: clean; all pass.

- [ ] **Step 4: Commit**

```bash
git add src/components/CaptureWindow.tsx src/main.tsx
git commit -m "feat(codey-mac): capture window renderer route with workspace picker

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Settings row (Quick capture hotkey)

**Files:**
- Modify: `codey-mac/src/components/AppearanceTab.tsx`

- [ ] **Step 1: Add the setting**

`AppearanceTab.tsx` already loads config on mount and has `skipPerms` + `notifyEnabled` precedents (added in #114/#115 work — read the current file).

1. Import: `import { HotkeyRecorder } from './HotkeyRecorder'`
2. State next to the others: `const [captureHotkey, setCaptureHotkey] = React.useState<string>('Alt+Space')`
3. In the mount effect, after `setNotifyEnabled(...)`: `setCaptureHotkey(cfg?.capture?.hotkey ?? 'Alt+Space')`
4. Handler next to `toggleNotify`:

```ts
  const changeCaptureHotkey = (v: string) => {
    setCaptureHotkey(v)
    window.codey?.config?.set?.({ capture: { hotkey: v } }).catch(() => { /* ignore */ })
  }
```

5. New row inside the `{loaded && (<>...</>)}` fragment, after the Background-notifications row:

```tsx
          <div style={styles.row}>
            <div style={{ ...styles.label, width: 'auto', flex: 1 }}>
              <div>Quick capture hotkey</div>
              <div style={{ fontSize: 11, color: C.fg3, fontWeight: 400, marginTop: 2 }}>
                Summon a floating composer from anywhere to send Codey a task. Clear to disable.
              </div>
            </div>
            <HotkeyRecorder value={captureHotkey} onChange={changeCaptureHotkey}/>
          </div>
```

- [ ] **Step 2: Typecheck**

Run: `source ~/.nvm/nvm.sh && nvm use 22.17.1 && npx tsc -p tsconfig.json --noEmit`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add src/components/AppearanceTab.tsx
git commit -m "feat(codey-mac): settings row to rebind or disable the quick-capture hotkey

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Manual verification (dev app)

**Files:** none.

- [ ] **Step 1:** `cd /Users/jackou/Documents/projects/codey/codey-mac && source ~/.nvm/nvm.sh && nvm use 22.17.1 && npm run dev`. Kill any pre-existing Codey dev Electron instances first (`pgrep -fl "MacOS/Electron \."`).
- [ ] **Step 2:** Press `Option+Space` from another app → capture window appears centered on the active display, input focused, workspace dropdown defaulting to last-used. Note: dev renderer window snapshots can appear stale in screen captures — verify behavior via logs/disk if needed.
- [ ] **Step 3:** Type a short no-tools prompt, Enter → window dismisses; "Task sent to <workspace>" notification; a NEW chat appears in the main window's sidebar for that workspace and dispatches (verify chat JSON under `workspaces/<ws>/chats/` or in the sidebar); completion notification arrives if the main window is unfocused.
- [ ] **Step 4:** Press `Option+Space` again → window reopens empty; press Escape → hides; click elsewhere (blur) → hides; `Option+Space` twice → shows then hides.
- [ ] **Step 5:** Submit empty text → inline error "Nothing to send", window stays open, text preserved on failure paths.
- [ ] **Step 6:** Settings → General → rebind hotkey (e.g. ⌘⇧K) → old binding dead, new binding works without restart; Reset (clear) → no binding registered.
- [ ] **Step 7:** `npx vitest run && git status` — all pass, tree clean.
