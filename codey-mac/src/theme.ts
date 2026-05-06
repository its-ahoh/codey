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
