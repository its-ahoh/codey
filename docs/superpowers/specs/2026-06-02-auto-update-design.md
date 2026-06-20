# In-App Auto-Update (codey-mac) — Design

**Date:** 2026-06-02
**Status:** Approved for planning

## Goal

Add a small update button in the bottom of the left sidebar of the Codey macOS
app. When a newer release exists on GitHub, the button surfaces it; the user
clicks to pull the new build directly from GitHub Releases and install it. Full
auto-update — not a "notify and open the download page" stub.

## Constraints / Context

- `codey-mac` is an Electron menu-bar app (Electron 28), built with
  `electron-builder`, signed + notarized with the team's Apple identity
  (`N59NN58KB2`). Current mac target: `dmg` only (arm64 + x64).
- Repo: `https://github.com/its-ahoh/codey` (public, MIT). electron-updater can
  read public Releases anonymously — no token needed in the shipped app.
- The app already exposes `app:version` over IPC (`app.getVersion()`).
- Left sidebar = `src/components/ChatListPanel.tsx`; its `footer` already holds a
  `⚙ Settings` button — the update button lives next to it.
- Tooling: vite + vitest. `electron/main.ts`, `electron/preload.ts`.

## Approach

Use `electron-updater` (the electron-builder companion) with the GitHub
provider, in `autoDownload = false` mode so the flow matches the requested UX:
detect → show button → user clicks → download → user clicks → install on restart.

Rejected alternatives: (a) hand-rolled GitHub API checker that only opens the
download page — not the requested auto-pull; (b) Squirrel.Mac directly —
electron-updater already wraps it.

## Components

### 1. Build config — `codey-mac/package.json` (`build` block)

- Add a `zip` target alongside `dmg` for both arches. **Mandatory**: macOS
  auto-install runs from the zip; `latest-mac.yml` references it. dmg remains for
  first-time manual downloads.
- Add:
  ```json
  "publish": { "provider": "github", "owner": "its-ahoh", "repo": "codey" }
  ```
  This makes electron-builder emit `latest-mac.yml` and upload artifacts on publish.

### 2. Release pipeline — GitHub Actions on tag

- New workflow `.github/workflows/release.yml`, triggered on `push` of tags
  matching `v*`, running on `macos-latest`.
- Steps: checkout → setup-node 20 → `npm ci` → build core + gateway → build the
  voice helper (`prebuild`) → `electron-builder --mac --publish always`.
- Signing/notarization via repo secrets (user provides):
  - `CSC_LINK` (base64 .p12), `CSC_KEY_PASSWORD`
  - `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`
  - `GH_TOKEN` (the built-in `GITHUB_TOKEN` is sufficient for publishing to the
    same repo's Releases).
- Workflow creates/updates the GitHub Release for the tag with dmg + zip +
  `latest-mac.yml`.
- README/CHANGELOG note documenting "tag `vX.Y.Z` → release ships."

### 3. Main process — `electron/main.ts`

- Import `autoUpdater` from `electron-updater`.
- Guard everything behind `app.isPackaged` (electron-updater no-ops/throws in dev
  without `app-update.yml`).
- Config: `autoUpdater.autoDownload = false`, `autoUpdater.autoInstallOnAppQuit
  = false` (install is explicit, on user action).
- Trigger `checkForUpdates()` after the main window is created, then on an
  interval (~4h).
- Forward events to the renderer via `mainWindow.webContents.send('updater:state', payload)`:
  - `checking-for-update`, `update-available` (with version), `update-not-available`,
    `download-progress` (percent), `update-downloaded` (with version), `error`.
- New IPC handlers:
  - `updater:check` → `checkForUpdates()`
  - `updater:download` → `downloadUpdate()`
  - `updater:install` → `quitAndInstall()`

### 4. Preload — `electron/preload.ts`

Expose under `api.updater`:
- `check(): Promise<void>`
- `download(): Promise<void>`
- `install(): Promise<void>`
- `onState(handler): () => void` — subscribes to `updater:state`, returns an
  unsubscribe fn (same pattern as existing `onLog` / voice listeners).

Update `src/codey-api.d.ts` type declarations to match.

### 5. Renderer — the button + `useUpdater` hook

- New hook `src/hooks/useUpdater.ts`: subscribes via `api.updater.onState`, holds
  a reduced UI state, exposes actions. The state reducer is a pure function so it
  can be unit-tested.
- UI states (small pill in `ChatListPanel` footer, next to `⚙ Settings`):
  - `idle` / up-to-date → render nothing (or a subtle version label; default:
    nothing, to honor "small / in a corner").
  - `available` → highlighted button "↑ Update to vX.Y.Z" → calls `download()`.
  - `downloading` → "Downloading… NN%" (non-interactive).
  - `ready` → "Restart to update" → calls `install()`.
  - `error` → silent; reverts to idle. (Manual re-check can come from Settings
    later; out of scope now.)
- Styling matches existing footer button styles in `ChatListPanel`.

## Data Flow

```
main (autoUpdater events) --webContents.send('updater:state')--> preload.onState
  --> useUpdater hook (reducer) --> UpdateButton render
UpdateButton click --> api.updater.{download,install} --> ipcRenderer.invoke
  --> main IPC handler --> autoUpdater.{downloadUpdate,quitAndInstall}
```

## Error Handling

- Dev / unpackaged build: updater disabled (`app.isPackaged` guard); button stays
  idle.
- Network or fetch failure: `error` event logged via existing logger; UI reverts
  to idle, never blocks.
- Unsigned local build: same as dev — no-op.

## Testing

- Unit-test the `useUpdater` state reducer (vitest): event sequences →
  expected UI state (idle → available → downloading → ready), and error → idle.
- Manual verification: build a signed release, tag a bump, confirm an older
  installed build surfaces the button, downloads, and installs on restart.

## Out of Scope

- Auto-update for the non-mac gateway packages.
- A full "check now" / release-notes UI (button is minimal by request).
- Delta updates.
