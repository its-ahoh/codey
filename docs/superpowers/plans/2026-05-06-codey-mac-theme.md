# codey-mac Light/Dark Theme Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Light / Dark / System theme support to the codey-mac Electron app, with persistent user choice and live OS-appearance tracking when in System mode.

**Architecture:** Refactor `src/theme.ts` so the exported `C` token object's values are `var(--token)` strings instead of literal hex. Two palettes (`darkPalette`, `lightPalette`) drive CSS custom properties scoped by a `data-theme` attribute on `<html>`. A pre-React inline script in `index.html` sets the attribute before first paint to avoid flicker. A new Appearance pane in the existing Settings modal lets the user pick the mode.

**Tech Stack:** React 18, Electron, Vite, TypeScript, inline styles. No CSS framework, no test runner.

**Spec:** `docs/superpowers/specs/2026-05-06-codey-mac-theme-design.md`

**Working directory for all commands:** `codey-mac/`

---

### Task 1: Define palettes and CSS-variable-backed `C` tokens

**Files:**
- Modify: `codey-mac/src/theme.ts` (full rewrite)

- [ ] **Step 1: Replace `src/theme.ts` with palette definitions and var-backed `C`**

```ts
// codey-mac/src/theme.ts
import { useEffect, useState } from 'react'

export type ThemeMode = 'light' | 'dark' | 'system'
export type EffectiveTheme = 'light' | 'dark'

const STORAGE_KEY = 'codey.theme'

interface Palette {
  bg: string
  surface: string
  surface2: string
  surface3: string
  border: string
  border2: string
  fg: string
  fg2: string
  fg3: string
  accent: string
  accentDim: string
  green: string
  red: string
  yellow: string
  userBg: string
  aiBg: string
  scrollbar: string
}

export const darkPalette: Palette = {
  bg:        '#141414',
  surface:   '#1e1e1e',
  surface2:  '#252525',
  surface3:  '#2d2d2d',
  border:    '#2e2e2e',
  border2:   '#383838',
  fg:        '#f0f0f0',
  fg2:       '#a0a0a0',
  fg3:       '#606060',
  accent:    '#0A84FF',
  accentDim: '#0A84FF22',
  green:     '#32D74B',
  red:       '#FF453A',
  yellow:    '#FFD60A',
  userBg:    '#0A84FF',
  aiBg:      '#252525',
  scrollbar: '#3a3a3a',
}

export const lightPalette: Palette = {
  bg:        '#ffffff',
  surface:   '#f5f5f7',
  surface2:  '#ebebef',
  surface3:  '#e1e1e6',
  border:    '#d2d2d7',
  border2:   '#c7c7cc',
  fg:        '#1d1d1f',
  fg2:       '#6e6e73',
  fg3:       '#8e8e93',
  accent:    '#0A84FF',
  accentDim: '#0A84FF22',
  green:     '#34C759',
  red:       '#FF3B30',
  yellow:    '#FFCC00',
  userBg:    '#0A84FF',
  aiBg:      '#f5f5f7',
  scrollbar: '#c7c7cc',
}

// Token names mirror Palette keys; `C.bg` etc. resolve to `var(--bg)` at render time.
export const C = (Object.keys(darkPalette) as (keyof Palette)[]).reduce((acc, key) => {
  acc[key] = `var(--${key})`
  return acc
}, {} as Record<keyof Palette, string>)

export function paletteToCssVars(p: Palette): string {
  return (Object.keys(p) as (keyof Palette)[])
    .map(k => `  --${k}: ${p[k]};`)
    .join('\n')
}

export function getStoredThemeMode(): ThemeMode {
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    if (v === 'light' || v === 'dark' || v === 'system') return v
  } catch {}
  return 'system'
}

export function resolveEffectiveTheme(mode: ThemeMode): EffectiveTheme {
  if (mode === 'system') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  }
  return mode
}

export function applyTheme(mode: ThemeMode): EffectiveTheme {
  const effective = resolveEffectiveTheme(mode)
  document.documentElement.dataset.theme = effective
  try { localStorage.setItem(STORAGE_KEY, mode) } catch {}
  return effective
}

export function useThemeMode(): [ThemeMode, (m: ThemeMode) => void] {
  const [mode, setModeState] = useState<ThemeMode>(getStoredThemeMode)
  const setMode = (m: ThemeMode) => {
    applyTheme(m)
    setModeState(m)
  }
  return [mode, setMode]
}

export function useEffectiveTheme(): EffectiveTheme {
  const [eff, setEff] = useState<EffectiveTheme>(() => resolveEffectiveTheme(getStoredThemeMode()))
  useEffect(() => {
    const mql = window.matchMedia('(prefers-color-scheme: dark)')
    const recompute = () => setEff(resolveEffectiveTheme(getStoredThemeMode()))
    mql.addEventListener('change', recompute)
    const onStorage = (e: StorageEvent) => { if (e.key === STORAGE_KEY) recompute() }
    window.addEventListener('storage', onStorage)
    return () => {
      mql.removeEventListener('change', recompute)
      window.removeEventListener('storage', onStorage)
    }
  }, [])
  return eff
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run from `codey-mac/`:
```
npx tsc --noEmit -p tsconfig.json
```
Expected: no errors. Existing components that import `{ C }` keep working (same key set).

- [ ] **Step 3: Commit**

```
git add codey-mac/src/theme.ts
git commit -m "refactor(codey-mac): tokenize theme via CSS variables"
```

---

### Task 2: Inject CSS-variable definitions and apply mode in App

**Files:**
- Modify: `codey-mac/src/App.tsx`

- [ ] **Step 1: Update imports at the top of `App.tsx`**

Find the existing line:
```ts
import { C } from './theme'
```
Replace with:
```ts
import {
  C,
  applyTheme,
  getStoredThemeMode,
  resolveEffectiveTheme,
  paletteToCssVars,
  darkPalette,
  lightPalette,
} from './theme'
```

- [ ] **Step 2: Add a theme-bootstrap effect inside the `Shell` component**

Locate the `Shell` functional component in `App.tsx`. Immediately after its existing `useEffect` calls (or near the top of the component body, before the returned JSX), add:

```tsx
useEffect(() => {
  applyTheme(getStoredThemeMode())
  const mql = window.matchMedia('(prefers-color-scheme: dark)')
  const onChange = () => {
    if (getStoredThemeMode() === 'system') {
      document.documentElement.dataset.theme = resolveEffectiveTheme('system')
    }
  }
  mql.addEventListener('change', onChange)
  return () => mql.removeEventListener('change', onChange)
}, [])
```

- [ ] **Step 3: Replace hardcoded colors in the global `<style>` block**

In `App.tsx`, find the `<style>{` ... `}</style>` block (around lines 84–98 in the current file). Replace its contents with:

```tsx
<style>{`
  :root {
${paletteToCssVars(darkPalette)}
  }
  :root[data-theme="light"] {
${paletteToCssVars(lightPalette)}
  }
  :root[data-theme="dark"] {
${paletteToCssVars(darkPalette)}
  }
  html, body, #root { height: 100%; margin: 0; background: ${C.bg}; }
  body { font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif; color: ${C.fg}; }
  * { box-sizing: border-box; }
  ::-webkit-scrollbar { width: 5px; height: 5px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: ${C.scrollbar}; border-radius: 3px; }
  textarea, input, select, button { font-family: inherit; }
  input, select, textarea { color: ${C.fg}; }
  @keyframes codey-pulse {
    0%, 100% { opacity: 1; transform: scale(1); }
    50% { opacity: 0.4; transform: scale(0.8); }
  }
`}</style>
```

Note the `:root` (no attribute) default block — covers the brief moment before `data-theme` is set.

- [ ] **Step 4: Type-check**

```
npx tsc --noEmit -p tsconfig.json
```
Expected: no errors. (The `C.scrollbar` access requires Task 1 to be merged — it adds the `scrollbar` token.)

- [ ] **Step 5: Commit**

```
git add codey-mac/src/App.tsx
git commit -m "feat(codey-mac): inject theme CSS variables and apply mode on mount"
```

---

### Task 3: Pre-paint flicker prevention in `index.html`

**Files:**
- Modify: `codey-mac/index.html`

- [ ] **Step 1: Add inline script that sets `data-theme` before React mounts**

Replace the existing `<style>` block in `index.html` (it hardcodes `#1a1a1a` / `#fff` for the body) with a script + minimal style. New `index.html` body:

```html
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Codey</title>
    <script>
      (function () {
        try {
          var m = localStorage.getItem('codey.theme');
          if (m !== 'light' && m !== 'dark' && m !== 'system') m = 'system';
          var eff = m === 'system'
            ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
            : m;
          document.documentElement.dataset.theme = eff;
          // Match Task 2 default vars so initial paint isn't white-on-white or vice versa.
          var bg = eff === 'light' ? '#ffffff' : '#141414';
          var fg = eff === 'light' ? '#1d1d1f' : '#f0f0f0';
          document.documentElement.style.background = bg;
          document.documentElement.style.color = fg;
        } catch (e) {}
      })();
    </script>
    <style>
      body { margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
    </style>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 2: Commit**

```
git add codey-mac/index.html
git commit -m "feat(codey-mac): apply persisted theme before first paint"
```

---

### Task 4: Add Appearance pane to Settings modal

**Files:**
- Create: `codey-mac/src/components/AppearanceTab.tsx`
- Modify: `codey-mac/src/components/SettingsOverlay.tsx`

- [ ] **Step 1: Create `AppearanceTab.tsx`**

```tsx
// codey-mac/src/components/AppearanceTab.tsx
import React from 'react'
import { C, ThemeMode, useThemeMode, useEffectiveTheme } from '../theme'

const OPTIONS: { value: ThemeMode; label: string }[] = [
  { value: 'light',  label: 'Light'  },
  { value: 'dark',   label: 'Dark'   },
  { value: 'system', label: 'System' },
]

export const AppearanceTab: React.FC = () => {
  const [mode, setMode] = useThemeMode()
  const effective = useEffectiveTheme()

  return (
    <div style={styles.wrap}>
      <div style={styles.row}>
        <div style={styles.label}>Theme</div>
        <div role="radiogroup" aria-label="Theme" style={styles.segmented}>
          {OPTIONS.map(opt => {
            const active = mode === opt.value
            return (
              <button
                key={opt.value}
                role="radio"
                aria-checked={active}
                onClick={() => setMode(opt.value)}
                style={{
                  ...styles.segBtn,
                  background: active ? C.accent : 'transparent',
                  color: active ? '#ffffff' : C.fg2,
                }}
              >
                {opt.label}
              </button>
            )
          })}
        </div>
      </div>
      {mode === 'system' && (
        <div style={styles.hint}>
          Currently following system: {effective === 'dark' ? 'Dark' : 'Light'}
        </div>
      )}
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  wrap:  { padding: '20px', display: 'flex', flexDirection: 'column', gap: 10 },
  row:   { display: 'flex', alignItems: 'center', gap: 16 },
  label: { fontSize: 13, color: C.fg, width: 80 },
  segmented: {
    display: 'inline-flex',
    background: C.surface2,
    border: `1px solid ${C.border}`,
    borderRadius: 6,
    padding: 2,
    gap: 2,
  },
  segBtn: {
    border: 'none',
    borderRadius: 4,
    padding: '5px 14px',
    fontSize: 12,
    fontWeight: 500,
    cursor: 'pointer',
  },
  hint: { fontSize: 11, color: C.fg3, marginLeft: 96 },
}
```

- [ ] **Step 2: Wire `AppearanceTab` into `SettingsOverlay.tsx`**

In `codey-mac/src/components/SettingsOverlay.tsx`:

(a) Add import at the top, after the existing component imports:
```ts
import { AppearanceTab } from './AppearanceTab'
```

(b) Update the `Tab` type (line 9):
```ts
type Tab = 'appearance' | 'workers' | 'workspaces' | 'status' | 'settings'
```

(c) Update the `TABS` constant (lines 10–15) — add Appearance as the first entry:
```ts
const TABS: { key: Tab; label: string; icon: string; description: string }[] = [
  { key: 'appearance', label: 'Appearance', icon: '◐', description: 'Theme & visual options' },
  { key: 'settings',   label: 'AI Models',  icon: '✦', description: 'Default agent & model' },
  { key: 'workspaces', label: 'Workspaces', icon: '◫', description: 'Project directories' },
  { key: 'workers',    label: 'Workers',    icon: '☰', description: 'Personalities & teams' },
  { key: 'status',     label: 'Gateway',    icon: '◉', description: 'Server status & logs' },
]
```

(d) Render the new tab — in the `mainContent` div (around line 67), add the line:
```tsx
{tab === 'appearance' && <AppearanceTab />}
```
…immediately above the existing `{tab === 'status' ...}` line.

- [ ] **Step 3: Type-check**

```
npx tsc --noEmit -p tsconfig.json
```
Expected: no errors.

- [ ] **Step 4: Commit**

```
git add codey-mac/src/components/AppearanceTab.tsx codey-mac/src/components/SettingsOverlay.tsx
git commit -m "feat(codey-mac): add Appearance pane with Light/Dark/System control"
```

---

### Task 5: Sweep for stray hardcoded hex colors

**Files:**
- Modify: any file in `codey-mac/src/` outside `theme.ts` containing literal hex colors that should be theme-aware.

- [ ] **Step 1: Grep for hex literals outside `theme.ts`**

Run from repo root:
```
grep -rn -E "#[0-9a-fA-F]{3,8}\\b" codey-mac/src --include="*.tsx" --include="*.ts" \
  | grep -v "src/theme.ts"
```

- [ ] **Step 2: Categorize each result**

For each match decide:
- **Keep as-is:** intentionally fixed colors (e.g. macOS traffic-light buttons `#FF5F57` / `#E0443E` in `SettingsOverlay.tsx`, the `#0A84FF` in `userBg` if already routed through `C`, opaque overlays like `rgba(0,0,0,0.55)`).
- **Replace with token:** colors that should adapt to theme. Use the closest existing `C.*` token. If no existing token fits (e.g. a one-off semantic like a destructive-button background), use the nearest of `C.surface2`, `C.border`, `C.fg2`, etc.

If two or more files use the *same* untokenized color for the same purpose, add a new token to both palettes in `theme.ts` rather than duplicating the literal.

- [ ] **Step 3: Make the replacements**

Edit the affected files. For each replacement, verify the dark-mode output still matches the previous appearance (the dark palette values are unchanged from before this work).

- [ ] **Step 4: Type-check**

```
cd codey-mac && npx tsc --noEmit -p tsconfig.json
```

- [ ] **Step 5: Commit**

```
git add codey-mac/src
git commit -m "refactor(codey-mac): tokenize remaining hardcoded colors"
```

---

### Task 6: Manual verification

**No automated tests** (no test runner is configured for this repo).

- [ ] **Step 1: Build and launch the dev app**

From `codey-mac/`:
```
npm run dev
```
(or whatever the existing dev command is — check `codey-mac/package.json` `scripts`.)

- [ ] **Step 2: Run the verification matrix**

Walk through each item; record any failure and fix before completing the plan.

1. Open Settings → Appearance. Toggle Light → Dark → System. Confirm:
   - The entire UI updates instantly with no re-mount, no flicker, no layout shift.
   - The active button in the segmented control highlights correctly.
2. Set mode to **System**. Confirm the hint reads "Currently following system: <Dark|Light>" and matches the OS.
3. With mode = System, change macOS appearance via System Settings → Appearance (or the Control Center toggle). Confirm the app follows live within ~1 second.
4. With mode = Light (or Dark), change macOS appearance — confirm the app does **not** change (mode pin overrides).
5. Quit the app and relaunch. Confirm the previously chosen mode is restored, with no white-flash on a dark mode launch and no dark-flash on a light mode launch.
6. Spot-check each Settings sidebar tab and the main app tabs (Chat, Workspaces, Workers, Teams, Channels, Status) in **both** themes. Look for:
   - Unreadable text (low contrast).
   - Borders that disappear in light mode.
   - Any element still showing a dark-mode color in light mode.
7. Re-run the grep from Task 5 Step 1 and confirm no unexpected hex literals remain.

- [ ] **Step 3: Final commit if any fixes were made**

```
git add codey-mac/src
git commit -m "fix(codey-mac): theme polish from manual QA"
```

(Skip this step if no fixes were needed.)

---

## Self-review

- **Spec coverage:**
  - Theme model (light/dark/system, default system, persistence) → Task 1.
  - CSS-variable mechanism + `theme.ts` rewrite → Task 1.
  - `App.tsx` mount/listener + `<style>` injection → Task 2.
  - Pre-paint flicker prevention → Task 3.
  - Light palette values → Task 1 (`lightPalette`).
  - Settings UI Appearance pane with segmented control + system hint → Task 4.
  - Stray hex sweep → Task 5.
  - Manual verification matrix → Task 6.
- **Placeholder scan:** no TBD/TODO; every code step shows the exact code; commands are concrete.
- **Type consistency:** `ThemeMode`, `EffectiveTheme`, `applyTheme`, `getStoredThemeMode`, `resolveEffectiveTheme`, `useThemeMode`, `useEffectiveTheme`, `paletteToCssVars`, `darkPalette`, `lightPalette` are defined in Task 1 and referenced unchanged in Tasks 2 and 4.
