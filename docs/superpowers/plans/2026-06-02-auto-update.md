# In-App Auto-Update (codey-mac) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a small update button at the bottom of the codey-mac left sidebar that surfaces newer GitHub releases and lets the user download + install them via electron-updater.

**Architecture:** electron-updater (GitHub provider, `autoDownload = false`) runs in the Electron main process, forwarding lifecycle events to the renderer over a buffered `updater:state` IPC channel. A pure reducer turns those events into UI state; a small React button in `ChatListPanel`'s footer renders it. A tag-triggered GitHub Actions workflow builds the signed/notarized dmg+zip and publishes them (with `latest-mac.yml`) to GitHub Releases.

**Tech Stack:** Electron 28, electron-builder, electron-updater, React 18, Vite, Vitest, GitHub Actions.

All paths below are relative to the repo root `/path/to/codey`. The app lives in `codey-mac/`.

---

### Task 1: Add the electron-updater dependency

**Files:**
- Modify: `codey-mac/package.json` (dependencies)

- [ ] **Step 1: Install electron-updater**

Run from repo root:
```bash
npm install electron-updater@^6 -w codey-mac
```
Expected: `electron-updater` appears under `codey-mac/package.json` `dependencies`, `package-lock.json` updated. (electron-updater ships its own TypeScript types — no `@types` needed.)

- [ ] **Step 2: Verify it resolves**

Run:
```bash
node -e "require.resolve('electron-updater', { paths: ['codey-mac/node_modules'] }) && console.log('ok')"
```
Expected: prints `ok`.

- [ ] **Step 3: Commit**

```bash
git add codey-mac/package.json package-lock.json
git commit -m "build(codey-mac): add electron-updater dependency"
```

---

### Task 2: Build config — zip target + GitHub publish

**Files:**
- Modify: `codey-mac/package.json` (`build.mac.target`, add `build.publish`)

- [ ] **Step 1: Add a zip target alongside dmg**

In `codey-mac/package.json`, the `build.mac.target` array currently holds only the `dmg` entry. Replace the `target` array so it contains both:
```json
"target": [
  {
    "target": "dmg",
    "arch": ["arm64", "x64"]
  },
  {
    "target": "zip",
    "arch": ["arm64", "x64"]
  }
]
```
The `zip` target is what electron-updater applies on macOS; `latest-mac.yml` will reference it. The `dmg` stays for first-time manual downloads.

- [ ] **Step 2: Add the publish provider**

Add a top-level `publish` key inside the `build` object (sibling of `mac`, `files`, `extraResources`):
```json
"publish": {
  "provider": "github",
  "owner": "its-ahoh",
  "repo": "codey"
}
```
This makes electron-builder emit `latest-mac.yml` and embed `app-update.yml` in the package so the shipped app knows where to look.

- [ ] **Step 3: Validate JSON**

Run:
```bash
node -e "JSON.parse(require('fs').readFileSync('codey-mac/package.json','utf8')); console.log('valid json')"
```
Expected: prints `valid json`.

- [ ] **Step 4: Commit**

```bash
git add codey-mac/package.json
git commit -m "build(codey-mac): add zip target and GitHub publish config for auto-update"
```

---

### Task 3: Updater module in the Electron main process

**Files:**
- Create: `codey-mac/electron/updater.ts`
- Modify: `codey-mac/electron/main.ts` (import + wire after `createWindow()`)

- [ ] **Step 1: Create the updater module**

Create `codey-mac/electron/updater.ts`:
```ts
import { autoUpdater } from 'electron-updater'
import type { IpcMain } from 'electron'

type Notify = (payload: Record<string, unknown>) => void
type Log = (message: string) => void

let started = false
const FOUR_HOURS = 4 * 60 * 60 * 1000

/**
 * Wire electron-updater events to the renderer. No-ops in dev / unpackaged
 * builds, where there is no app-update.yml and autoUpdater would throw.
 */
export function initAutoUpdater(notify: Notify, isPackaged: boolean, log: Log): void {
  if (!isPackaged || started) return
  started = true

  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false

  autoUpdater.on('checking-for-update', () => notify({ type: 'checking' }))
  autoUpdater.on('update-available', (info) => notify({ type: 'available', version: info.version }))
  autoUpdater.on('update-not-available', () => notify({ type: 'not-available' }))
  autoUpdater.on('download-progress', (p) => notify({ type: 'progress', percent: Math.round(p.percent) }))
  autoUpdater.on('update-downloaded', (info) => notify({ type: 'downloaded', version: info.version }))
  autoUpdater.on('error', (err) => {
    log(`[updater] error: ${err?.message ?? err}`)
    notify({ type: 'error' })
  })

  const check = () => {
    autoUpdater.checkForUpdates().catch((e) => log(`[updater] check failed: ${e?.message ?? e}`))
  }
  check()
  setInterval(check, FOUR_HOURS)
}

/** IPC handlers driven by the renderer button. */
export function registerUpdaterIpc(ipcMain: IpcMain, log: Log): void {
  ipcMain.handle('updater:check', () =>
    autoUpdater.checkForUpdates().catch((e) => log(`[updater] check failed: ${e?.message ?? e}`)),
  )
  ipcMain.handle('updater:download', () =>
    autoUpdater.downloadUpdate().catch((e) => log(`[updater] download failed: ${e?.message ?? e}`)),
  )
  ipcMain.handle('updater:install', () => autoUpdater.quitAndInstall())
}
```

- [ ] **Step 2: Import the module in main.ts**

In `codey-mac/electron/main.ts`, add after the existing local imports near the top (e.g. after the `import { findAvailablePort } from './portUtils'` line):
```ts
import { initAutoUpdater, registerUpdaterIpc } from './updater'
```

- [ ] **Step 3: Wire it into app startup**

In `codey-mac/electron/main.ts`, locate the startup sequence in the `app.whenReady` body where `createWindow()` and `createTray()` are called (around line 813). Immediately after `createTray()` add:
```ts
  registerUpdaterIpc(ipcMain, (m) => sendToRenderer('gateway-log', m))
  initAutoUpdater(
    (payload) => sendToRenderer('updater:state', payload),
    app.isPackaged,
    (m) => sendToRenderer('gateway-log', m),
  )
```
This reuses the existing `sendToRenderer` buffering so `updater:state` messages survive a not-yet-ready renderer, and routes updater logs into the existing gateway-log ring buffer.

- [ ] **Step 4: Type-check**

Run:
```bash
cd codey-mac && npx tsc --noEmit
```
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add codey-mac/electron/updater.ts codey-mac/electron/main.ts
git commit -m "feat(codey-mac): wire electron-updater in main process"
```

---

### Task 4: Expose the updater API in preload + types

**Files:**
- Modify: `codey-mac/electron/preload.ts` (add `updater` to the exposed object)
- Modify: `codey-mac/src/codey-api.d.ts` (add `updater` to the `Window['codey']` type)

- [ ] **Step 1: Add the updater bridge in preload**

In `codey-mac/electron/preload.ts`, inside the `contextBridge.exposeInMainWorld('codey', { ... })` object, add a sibling to the existing `app:` block:
```ts
  updater: {
    check: () => ipcRenderer.invoke('updater:check'),
    download: () => ipcRenderer.invoke('updater:download'),
    install: () => ipcRenderer.invoke('updater:install'),
    onState: (handler: (state: any) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, state: any) => handler(state)
      ipcRenderer.on('updater:state', listener)
      return () => ipcRenderer.removeListener('updater:state', listener)
    },
  },
```

- [ ] **Step 2: Add the type declaration**

In `codey-mac/src/codey-api.d.ts`, inside the `codey: { ... }` interface, next to the existing `app: { version: ... }` block, add:
```ts
      updater: {
        check: () => Promise<void>
        download: () => Promise<void>
        install: () => Promise<void>
        onState: (handler: (state: import('./hooks/updaterState').UpdaterEvent) => void) => () => void
      }
```
(The `UpdaterEvent` type is created in Task 5; the import path resolves once that file exists.)

- [ ] **Step 3: Commit**

```bash
git add codey-mac/electron/preload.ts codey-mac/src/codey-api.d.ts
git commit -m "feat(codey-mac): expose updater API over preload bridge"
```

---

### Task 5: Updater state reducer (TDD)

**Files:**
- Create: `codey-mac/src/hooks/updaterState.ts`
- Test: `codey-mac/src/hooks/updaterState.test.ts`

- [ ] **Step 1: Write the failing test**

Create `codey-mac/src/hooks/updaterState.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { updaterReducer, initialUpdaterState, type UpdaterState } from './updaterState'

describe('updaterReducer', () => {
  it('stays idle on checking and not-available', () => {
    expect(updaterReducer(initialUpdaterState, { type: 'checking' })).toEqual({ phase: 'idle' })
    expect(updaterReducer(initialUpdaterState, { type: 'not-available' })).toEqual({ phase: 'idle' })
  })

  it('moves to available with version', () => {
    expect(updaterReducer(initialUpdaterState, { type: 'available', version: '0.6.4' }))
      .toEqual({ phase: 'available', version: '0.6.4' })
  })

  it('tracks download progress then ready', () => {
    const downloading = updaterReducer(
      { phase: 'available', version: '0.6.4' },
      { type: 'progress', percent: 42 },
    )
    expect(downloading).toEqual({ phase: 'downloading', percent: 42 })
    expect(updaterReducer(downloading, { type: 'downloaded', version: '0.6.4' }))
      .toEqual({ phase: 'ready', version: '0.6.4' })
  })

  it('reverts to idle on error', () => {
    const state: UpdaterState = { phase: 'downloading', percent: 10 }
    expect(updaterReducer(state, { type: 'error' })).toEqual({ phase: 'idle' })
  })

  it('leaves an in-progress download untouched on a stray checking event', () => {
    const state: UpdaterState = { phase: 'downloading', percent: 50 }
    expect(updaterReducer(state, { type: 'checking' })).toEqual(state)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run:
```bash
cd codey-mac && npx vitest run src/hooks/updaterState.test.ts
```
Expected: FAIL — `Failed to resolve import "./updaterState"` / module not found.

- [ ] **Step 3: Implement the reducer**

Create `codey-mac/src/hooks/updaterState.ts`:
```ts
export type UpdaterEvent =
  | { type: 'checking' }
  | { type: 'available'; version: string }
  | { type: 'not-available' }
  | { type: 'progress'; percent: number }
  | { type: 'downloaded'; version: string }
  | { type: 'error' }

export type UpdaterState =
  | { phase: 'idle' }
  | { phase: 'available'; version: string }
  | { phase: 'downloading'; percent: number }
  | { phase: 'ready'; version: string }

export const initialUpdaterState: UpdaterState = { phase: 'idle' }

export function updaterReducer(state: UpdaterState, event: UpdaterEvent): UpdaterState {
  switch (event.type) {
    case 'checking':
      // Don't disturb an in-progress download/ready state on a periodic re-check.
      return state.phase === 'downloading' || state.phase === 'ready' ? state : { phase: 'idle' }
    case 'available':
      return { phase: 'available', version: event.version }
    case 'not-available':
      return { phase: 'idle' }
    case 'progress':
      return { phase: 'downloading', percent: event.percent }
    case 'downloaded':
      return { phase: 'ready', version: event.version }
    case 'error':
      return { phase: 'idle' }
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run:
```bash
cd codey-mac && npx vitest run src/hooks/updaterState.test.ts
```
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add codey-mac/src/hooks/updaterState.ts codey-mac/src/hooks/updaterState.test.ts
git commit -m "feat(codey-mac): add updater state reducer with tests"
```

---

### Task 6: useUpdater hook

**Files:**
- Create: `codey-mac/src/hooks/useUpdater.ts`

- [ ] **Step 1: Implement the hook**

Create `codey-mac/src/hooks/useUpdater.ts`:
```ts
import { useEffect, useReducer } from 'react'
import { updaterReducer, initialUpdaterState, type UpdaterEvent } from './updaterState'

export function useUpdater() {
  const [state, dispatch] = useReducer(updaterReducer, initialUpdaterState)

  useEffect(() => {
    const unsubscribe = window.codey.updater.onState((event: UpdaterEvent) => dispatch(event))
    return unsubscribe
  }, [])

  return {
    state,
    download: () => window.codey.updater.download(),
    install: () => window.codey.updater.install(),
  }
}
```

- [ ] **Step 2: Type-check**

Run:
```bash
cd codey-mac && npx tsc --noEmit
```
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add codey-mac/src/hooks/useUpdater.ts
git commit -m "feat(codey-mac): add useUpdater hook"
```

---

### Task 7: Update button in the sidebar footer

**Files:**
- Create: `codey-mac/src/components/UpdateButton.tsx`
- Modify: `codey-mac/src/components/ChatListPanel.tsx` (import + render in footer)

- [ ] **Step 1: Create the button component**

Create `codey-mac/src/components/UpdateButton.tsx`:
```tsx
import React from 'react'
import { C } from '../theme'
import { useUpdater } from '../hooks/useUpdater'

export const UpdateButton: React.FC = () => {
  const { state, download, install } = useUpdater()

  if (state.phase === 'idle') return null

  if (state.phase === 'available') {
    return (
      <button style={styles.action} onClick={() => download()} title={`Download version ${state.version}`}>
        ↑ Update to v{state.version}
      </button>
    )
  }

  if (state.phase === 'downloading') {
    return <div style={styles.progress}>Downloading… {state.percent}%</div>
  }

  // phase === 'ready'
  return (
    <button style={styles.action} onClick={() => install()} title="Restart and install the update">
      Restart to update
    </button>
  )
}

const styles: Record<string, React.CSSProperties> = {
  action: {
    width: '100%', padding: '8px 10px', border: 'none', marginBottom: 4,
    background: C.accentDim, color: C.fg, cursor: 'pointer',
    textAlign: 'left', borderRadius: 6, fontSize: 13, fontWeight: 600,
  },
  progress: {
    width: '100%', padding: '8px 10px', marginBottom: 4,
    color: C.fg2, fontSize: 13, textAlign: 'left',
  },
}
```

- [ ] **Step 2: Import the component in ChatListPanel**

In `codey-mac/src/components/ChatListPanel.tsx`, add to the imports near the top (after the `RouteIcons` import):
```ts
import { UpdateButton } from './UpdateButton'
```

- [ ] **Step 3: Render it at the top of the footer**

In `codey-mac/src/components/ChatListPanel.tsx`, find the footer block:
```tsx
      <div style={styles.footer}>
        <button
          style={styles.settingsBtn}
          onClick={handleAddWorkspace}
```
Insert `<UpdateButton />` as the first child of the footer `div`:
```tsx
      <div style={styles.footer}>
        <UpdateButton />
        <button
          style={styles.settingsBtn}
          onClick={handleAddWorkspace}
```

- [ ] **Step 4: Type-check + run all codey-mac tests**

Run:
```bash
cd codey-mac && npx tsc --noEmit && npx vitest run
```
Expected: no type errors; all tests pass (including the reducer tests from Task 5).

- [ ] **Step 5: Commit**

```bash
git add codey-mac/src/components/UpdateButton.tsx codey-mac/src/components/ChatListPanel.tsx
git commit -m "feat(codey-mac): show update button in sidebar footer"
```

---

### Task 8: GitHub Actions release workflow

**Files:**
- Create: `.github/workflows/release.yml`

- [ ] **Step 1: Create the workflow**

Create `.github/workflows/release.yml`:
```yaml
name: Release codey-mac

on:
  push:
    tags:
      - 'v*'

permissions:
  contents: write

jobs:
  release:
    name: build & publish (macos)
    runs-on: macos-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'

      - run: npm ci

      - name: Build core
        run: npm run build -w @codey/core

      - name: Build gateway
        run: npm run build -w @codey/gateway

      - name: Build & publish codey-mac
        working-directory: codey-mac
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          CSC_LINK: ${{ secrets.CSC_LINK }}
          CSC_KEY_PASSWORD: ${{ secrets.CSC_KEY_PASSWORD }}
          APPLE_ID: ${{ secrets.APPLE_ID }}
          APPLE_APP_SPECIFIC_PASSWORD: ${{ secrets.APPLE_APP_SPECIFIC_PASSWORD }}
          APPLE_TEAM_ID: ${{ secrets.APPLE_TEAM_ID }}
        run: npx vite build && npx electron-builder --mac --publish always
```
Notes:
- `prebuild` (`build:helper`, which runs `cd ../voice && make helper`) runs automatically before `electron-builder` only via the `build` npm script; here we invoke `vite build` + `electron-builder` directly, so the voice helper is NOT rebuilt. The committed `../voice/CodeyVoice` resource is used as-is. If a fresh helper build is required per release, prepend `npm run build:helper` — left out by default to keep the runner lean.
- `--publish always` uploads dmg, zip, and `latest-mac.yml` to the GitHub Release for the pushed tag (created automatically).

- [ ] **Step 2: Validate YAML**

Run:
```bash
node -e "const yaml=require('codey-mac/node_modules/js-yaml'); yaml.load(require('fs').readFileSync('.github/workflows/release.yml','utf8')); console.log('valid yaml')" 2>/dev/null || python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/release.yml')); print('valid yaml')"
```
Expected: prints `valid yaml`.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/release.yml
git commit -m "ci: publish signed codey-mac releases on v* tags"
```

---

### Task 9: Document the release process + required secrets

**Files:**
- Modify: `README.md` (add a "Releasing" section)

- [ ] **Step 1: Add a Releasing section**

Append to `README.md` a section documenting the flow:
```markdown
## Releasing (maintainers)

codey-mac auto-updates via electron-updater from GitHub Releases.

**Required repo secrets** (Settings → Secrets and variables → Actions):
- `CSC_LINK` — base64 of the Apple Developer ID `.p12` certificate
- `CSC_KEY_PASSWORD` — password for that `.p12`
- `APPLE_ID` — Apple ID email used for notarization
- `APPLE_APP_SPECIFIC_PASSWORD` — app-specific password for that Apple ID
- `APPLE_TEAM_ID` — Apple developer team ID (`N59NN58KB2`)

(`GITHUB_TOKEN` is provided automatically.)

**To ship a release:**
1. Bump the version in `package.json` and `codey-mac/package.json`.
2. Commit, then tag: `git tag vX.Y.Z && git push origin vX.Y.Z`.
3. The `Release codey-mac` workflow builds, signs, notarizes, and publishes the
   dmg + zip + `latest-mac.yml` to the GitHub Release.
4. Installed apps detect the new version on next launch (or within ~4h) and show
   the update button in the sidebar footer.
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: document codey-mac release + auto-update process"
```

---

## Manual Verification (post-implementation)

These require a signed build and cannot be automated here:
1. Build and install an older version locally.
2. Tag + push a newer version; confirm the release workflow publishes dmg/zip/`latest-mac.yml`.
3. Launch the older installed app → the sidebar footer shows "↑ Update to vX.Y.Z".
4. Click → progress shows → "Restart to update" appears → click → app relaunches on the new version.
5. Confirm in dev (`npm run dev -w codey-mac`) the button stays hidden (updater disabled when unpackaged).

---

## Notes for the implementer

- **DRY:** reuse the existing `sendToRenderer` buffering and `gateway-log` ring buffer — do not add a parallel logging path.
- **YAGNI:** no "check for updates now" menu item, no release-notes panel, no delta updates — out of scope.
- **Dev safety:** the `app.isPackaged` guard in `initAutoUpdater` is the single source of truth for disabling the updater in dev; do not add a second guard in the renderer.
- The renderer `onState` handler and main-process `notify` payloads share the `UpdaterEvent` shape — keep them in sync if you add event types.
