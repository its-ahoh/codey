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
  onAccent: string  // readable text/icon color on top of accent / userBg fills
  aiBg: string
  scrollbar: string
  // danger / error surfaces (used by error toasts in many components)
  dangerBg: string
  dangerBorder: string
  dangerFg: string
  // code / log surfaces (chat code blocks, inline code, status logs)
  codeBg: string
  codeFg: string
  inlineCodeBg: string
  inlineCodeFg: string
  logBg: string
  logFg: string
  // warning (orange) surfaces — orphan banners, gateway-stopped notice
  warningBg: string
  warningFg: string
}

// ============================================================================
// Color themes (palettes). Each theme has a light + dark variant. The active
// theme is chosen independently of the light/dark mode, via `data-palette`.
// ============================================================================

// ---- Classic: the original macOS-style look (Apple blue + neutral grays) ----
export const classicDark: Palette = {
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
  onAccent:  '#ffffff',
  aiBg:      '#252525',
  scrollbar: '#3a3a3a',
  dangerBg:      '#3a1a1a',
  dangerBorder:  '#6a2a2a',
  dangerFg:      '#ff8080',
  codeBg:        '#141414',
  codeFg:        '#e6e6e6',
  inlineCodeBg:  '#1a1a1a',
  inlineCodeFg:  '#e6e6e6',
  logBg:         '#0d0d0d',
  logFg:         '#6a9955',
  warningBg:     '#ff950033',
  warningFg:     '#ffb84d',
}

export const classicLight: Palette = {
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
  onAccent:  '#ffffff',
  aiBg:      '#f5f5f7',
  scrollbar: '#c7c7cc',
  dangerBg:      '#FFE5E5',
  dangerBorder:  '#FFB3B3',
  dangerFg:      '#C92A2A',
  codeBg:        '#f5f5f7',
  codeFg:        '#1d1d1f',
  inlineCodeBg:  '#ebebef',
  inlineCodeFg:  '#1d1d1f',
  logBg:         '#fafafa',
  logFg:         '#28792B',
  warningBg:     '#FFE9C4',
  warningFg:     '#A85D00',
}

// ---- Terminal: warm paper + terminal green; matches the Codey landing page ----
export const terminalDark: Palette = {
  bg:        '#141310',
  surface:   '#1C1A16',
  surface2:  '#232019',
  surface3:  '#2B2820',
  border:    '#2C2922',
  border2:   '#3A362D',
  fg:        '#F4EFE5',
  fg2:       '#B6AE9E',
  fg3:       '#837B6C',
  accent:    '#2BE69B',
  accentDim: '#2BE69B22',
  green:     '#2BE69B',
  red:       '#FF6B5E',
  yellow:    '#F5C451',
  userBg:    '#2BE69B',
  onAccent:  '#0A1A12',
  aiBg:      '#1E1C17',
  scrollbar: '#3A362D',
  dangerBg:      '#3A1A16',
  dangerBorder:  '#6A2A22',
  dangerFg:      '#FF8A7A',
  codeBg:        '#100F0C',
  codeFg:        '#E8E2D4',
  inlineCodeBg:  '#232019',
  inlineCodeFg:  '#54F0B0',
  logBg:         '#0C0B09',
  logFg:         '#2BE69B',
  warningBg:     '#3A2E16',
  warningFg:     '#F0B86B',
}

export const terminalLight: Palette = {
  bg:        '#FBF8F1',
  surface:   '#F3EEE3',
  surface2:  '#EBE4D5',
  surface3:  '#E2DAC8',
  border:    '#E7E0D2',
  border2:   '#D8CFBC',
  fg:        '#1A1712',
  fg2:       '#5B554A',
  fg3:       '#8C8475',
  accent:    '#0C9E70',
  accentDim: '#0C9E7022',
  green:     '#0C9E70',
  red:       '#DC4438',
  yellow:    '#B8841C',
  userBg:    '#067A53',
  onAccent:  '#FFFFFF',
  aiBg:      '#FFFFFF',
  scrollbar: '#D8CFBC',
  dangerBg:      '#FBE4E0',
  dangerBorder:  '#F0B9AE',
  dangerFg:      '#B23A26',
  codeBg:        '#211E18',
  codeFg:        '#E8E2D4',
  inlineCodeBg:  '#EDE6D7',
  inlineCodeFg:  '#067A53',
  logBg:         '#211E18',
  logFg:         '#54F0B0',
  warningBg:     '#F7EBCF',
  warningFg:     '#8A5A14',
}

export type PaletteName = 'classic' | 'terminal'

export const PALETTES: Record<PaletteName, { label: string; light: Palette; dark: Palette }> = {
  classic:  { label: 'Classic',  light: classicLight,  dark: classicDark  },
  terminal: { label: 'Terminal', light: terminalLight, dark: terminalDark },
}

export const DEFAULT_PALETTE: PaletteName = 'classic'
const PALETTE_KEY = 'codey.palette'

// Token names mirror Palette keys; `C.bg` etc. resolve to `var(--bg)` at render time.
export const C = (Object.keys(classicDark) as (keyof Palette)[]).reduce((acc, key) => {
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

// ---- Color theme (palette) selection — independent of light/dark mode ----

export function getStoredPalette(): PaletteName {
  try {
    const v = localStorage.getItem(PALETTE_KEY)
    if (v === 'classic' || v === 'terminal') return v
  } catch {}
  return DEFAULT_PALETTE
}

export function applyPalette(name: PaletteName): void {
  document.documentElement.dataset.palette = name
  try { localStorage.setItem(PALETTE_KEY, name) } catch {}
}

export function usePaletteName(): [PaletteName, (n: PaletteName) => void] {
  const [name, setNameState] = useState<PaletteName>(getStoredPalette)
  const setName = (n: PaletteName) => {
    applyPalette(n)
    setNameState(n)
  }
  return [name, setName]
}
