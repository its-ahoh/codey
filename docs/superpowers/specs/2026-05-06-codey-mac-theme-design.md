# codey-mac: Light/Dark Theme Support

**Date:** 2026-05-06
**Surface:** `codey-mac` (Electron + React desktop app)

## Goal

Add light/dark theme support to the codey-mac app. User can pick **Light**, **Dark**, or **System** (follows macOS appearance). The choice persists across launches and, when set to System, follows OS appearance changes live without restart.

## Non-goals

- Theming the gateway, web surfaces, or any non-Electron component.
- Custom user-defined palettes.
- Per-window or per-workspace themes.

## Theme model

- Modes: `'light' | 'dark' | 'system'`. Default: `'system'`.
- Persisted to `localStorage` under key `codey.theme` (matches existing `codey.<key>` convention).
- **Effective theme** is derived: if mode is `system`, read `window.matchMedia('(prefers-color-scheme: dark)').matches`; otherwise use the mode literal. The effective theme is applied; the mode (including `system`) is what gets persisted.

## Mechanism: CSS variables

The app currently uses inline styles with a `C` token object imported from `src/theme.ts`. `C` is referenced ~300+ times across ~12 components, often inside module-scope `styles` objects that compute once at load. Refactoring all those call sites is invasive; instead, route every token through CSS custom properties so component code is unchanged after the one-time `theme.ts` rewrite.

### `src/theme.ts`

- Define `darkPalette` and `lightPalette` constants with the same keys currently on `C`, plus a new `scrollbar` key.
- Rewrite the exported `C` object so each value is a `var(--token)` string. Shape and key names unchanged. All existing `C.bg`, `C.fg`, etc. references keep working.
- Export:
  - `type ThemeMode = 'light' | 'dark' | 'system'`
  - `applyTheme(mode: ThemeMode): void` — resolves effective theme, sets `document.documentElement.dataset.theme = 'light' | 'dark'`, writes mode to `localStorage`.
  - `getStoredThemeMode(): ThemeMode` — reads `codey.theme`, falls back to `'system'`.
  - `useThemeMode(): [ThemeMode, (m: ThemeMode) => void]` — React hook for the Settings UI; setter calls `applyTheme` and updates state.
  - `useEffectiveTheme(): 'light' | 'dark'` — for the System-mode hint line in Settings.

### `src/App.tsx`

- On mount: call `applyTheme(getStoredThemeMode())`.
- Subscribe to `window.matchMedia('(prefers-color-scheme: dark)')` `change` events; on change, if current mode is `system`, re-apply. Remove the listener on unmount.
- Inject the CSS variable definitions in the existing global `<style>` tag, scoped by `[data-theme="light"]` and `[data-theme="dark"]` selectors on `:root`.
- Replace any remaining hardcoded hex values in the global `<style>` (currently `#3a3a3a` scrollbar thumb) with `var(--scrollbar)`.

### Pre-paint flicker prevention

Persisted mode must be applied before first React render. Approach: in `index.html` (or `main.tsx` before React mounts), inline a tiny script that reads `localStorage.codey.theme`, resolves effective theme, and sets `document.documentElement.dataset.theme` synchronously. The same logic runs again inside React via `applyTheme`; redundancy is fine.

## Light palette

Tuned to match the existing macOS-style aesthetic (same `#0A84FF` accent, Apple system semantic colors).

| Token | Dark | Light |
|---|---|---|
| `bg` | `#141414` | `#ffffff` |
| `surface` | `#1e1e1e` | `#f5f5f7` |
| `surface2` | `#252525` | `#ebebef` |
| `surface3` | `#2d2d2d` | `#e1e1e6` |
| `border` | `#2e2e2e` | `#d2d2d7` |
| `border2` | `#383838` | `#c7c7cc` |
| `fg` | `#f0f0f0` | `#1d1d1f` |
| `fg2` | `#a0a0a0` | `#6e6e73` |
| `fg3` | `#606060` | `#8e8e93` |
| `accent` | `#0A84FF` | `#0A84FF` |
| `accentDim` | `#0A84FF22` | `#0A84FF22` |
| `green` | `#32D74B` | `#34C759` |
| `red` | `#FF453A` | `#FF3B30` |
| `yellow` | `#FFD60A` | `#FFCC00` |
| `userBg` | `#0A84FF` | `#0A84FF` |
| `aiBg` | `#252525` | `#f5f5f7` |
| `scrollbar` (new) | `#3a3a3a` | `#c7c7cc` |

## Settings UI

Add an **Appearance** entry to the Settings modal sidebar (the modal redesigned in `8909de7`), placed at the top since it's a UI-level concern.

Pane contents:

```
Theme    [ Light | Dark | System ]
         Currently following system: Dark
```

- Three-option segmented control bound to `useThemeMode()`.
- A hint line below the control:
  - When mode is `system`: `Currently following system: <effective>`
  - Otherwise: hidden (the segmented control already shows the choice).

## Files changed

- `codey-mac/src/theme.ts` — rewrite as described above.
- `codey-mac/src/App.tsx` — apply on mount, subscribe to matchMedia, tokenize remaining hex literals in global `<style>`.
- `codey-mac/index.html` (or `src/main.tsx`) — pre-paint sync script.
- `codey-mac/src/components/SettingsOverlay.tsx` (and any related sidebar config file) — add Appearance entry + pane.

After the refactor, grep `codey-mac/src` for hex color literals outside `theme.ts` and tokenize any survivors.

## Verification (manual; no test runner configured)

- Toggle Light / Dark / System in the Appearance pane → instant switch, no flicker, no re-mount.
- Mode = System, change macOS System Settings → Appearance → app follows live.
- Reload the app → persisted mode restored before first paint (no flash of wrong theme).
- Spot-check each tab (Chat, Workspaces, Workers, Teams, Channels, Status, Settings) in both themes.
- Confirm no remaining hardcoded hex colors outside `theme.ts`.
