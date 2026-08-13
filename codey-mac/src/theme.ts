// codey-mac/src/theme.ts
import { useEffect, useState } from 'react'

export type ThemeMode = 'light' | 'dark' | 'system'
export type EffectiveTheme = 'light' | 'dark'

const STORAGE_KEY = 'codey.theme'

export interface Palette {
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
  purple: string
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
  // translucent surface used by the persistent navigation rail
  sidebarBg: string
  sidebarBorder: string
}

// ============================================================================
// Color themes (palettes). Each theme has a light + dark variant. The active
// theme is chosen independently of the light/dark mode, via `data-palette`.
// ============================================================================

// ---- Classic: the original macOS-style look (Apple blue + neutral grays) ----
export const classicDark: Palette = {
  bg:        '#0e1116',
  surface:   '#151920',
  surface2:  '#1b2029',
  surface3:  '#242b36',
  border:    '#252c37',
  border2:   '#343e4d',
  fg:        '#edf1f7',
  fg2:       '#aab4c2',
  fg3:       '#737f90',
  accent:    '#74a7ff',
  accentDim: '#74a7ff20',
  green:     '#48c78e',
  purple:    '#b18cff',
  red:       '#ff7168',
  yellow:    '#e8bd61',
  userBg:    '#74a7ff',
  onAccent:  '#0a1626',
  aiBg:      '#171c24',
  scrollbar: '#374250',
  dangerBg:      '#351b1d',
  dangerBorder:  '#653035',
  dangerFg:      '#ff928b',
  codeBg:        '#0b0e12',
  codeFg:        '#dce4ee',
  inlineCodeBg:  '#202731',
  inlineCodeFg:  '#9dc0ff',
  logBg:         '#090c10',
  logFg:         '#66d6a3',
  warningBg:     '#382d19',
  warningFg:     '#edc573',
  sidebarBg:     'rgba(21, 25, 32, 0.82)',
  sidebarBorder: 'rgba(64, 76, 94, 0.58)',
}

export const classicLight: Palette = {
  bg:        '#f4f6f9',
  surface:   '#ffffff',
  surface2:  '#f8f9fb',
  surface3:  '#e9edf2',
  border:    '#dde2e8',
  border2:   '#cdd4dd',
  fg:        '#18202b',
  fg2:       '#546171',
  fg3:       '#7d8997',
  accent:    '#3377d5',
  accentDim: '#3377d51a',
  green:     '#17865b',
  purple:    '#7557b7',
  red:       '#d84942',
  yellow:    '#a66f08',
  userBg:    '#3377d5',
  onAccent:  '#ffffff',
  aiBg:      '#ffffff',
  scrollbar: '#c5ccd5',
  dangerBg:      '#fbe9e8',
  dangerBorder:  '#efc2bf',
  dangerFg:      '#ad332d',
  codeBg:        '#eef1f5',
  codeFg:        '#202833',
  inlineCodeBg:  '#e8edf4',
  inlineCodeFg:  '#285f9f',
  logBg:         '#f1f4f6',
  logFg:         '#176b4b',
  warningBg:     '#f8eed7',
  warningFg:     '#855b0e',
  sidebarBg:     'rgba(255, 255, 255, 0.82)',
  sidebarBorder: 'rgba(205, 212, 221, 0.78)',
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
  purple:    '#A371F7',
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
  sidebarBg:     'rgba(28, 26, 22, 0.78)',
  sidebarBorder: 'rgba(74, 68, 56, 0.58)',
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
  purple:    '#8250DF',
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
  sidebarBg:     'rgba(251, 248, 241, 0.78)',
  sidebarBorder: 'rgba(216, 207, 188, 0.72)',
}

// ---- Ocean: deep navy surfaces with a crisp cyan signal color ----
export const oceanDark: Palette = {
  bg: '#071219', surface: '#0c1a23', surface2: '#10232e', surface3: '#18303d',
  border: '#19303c', border2: '#274756', fg: '#e8f4f7', fg2: '#9db9c2', fg3: '#668894',
  accent: '#4bc7e5', accentDim: '#4bc7e520', green: '#54d6a0', purple: '#a99af2', red: '#ff716f', yellow: '#e8c66a',
  userBg: '#4bc7e5', onAccent: '#041b22', aiBg: '#0e202a', scrollbar: '#28505e',
  dangerBg: '#351c20', dangerBorder: '#71333b', dangerFg: '#ff9692',
  codeBg: '#050d12', codeFg: '#d7e8ec', inlineCodeBg: '#142b36', inlineCodeFg: '#74d9ef', logBg: '#040b0f', logFg: '#57d9aa',
  warningBg: '#342c19', warningFg: '#ebcb79', sidebarBg: 'rgba(9, 25, 34, 0.84)', sidebarBorder: 'rgba(39, 71, 86, 0.64)',
}

export const oceanLight: Palette = {
  bg: '#f1f8fa', surface: '#ffffff', surface2: '#f4fafb', surface3: '#e3f0f3',
  border: '#d7e8ec', border2: '#bfd8de', fg: '#10272f', fg2: '#486873', fg3: '#78949d',
  accent: '#087f9f', accentDim: '#087f9f18', green: '#16805a', purple: '#6658b1', red: '#cb4545', yellow: '#9a6b0d',
  userBg: '#087f9f', onAccent: '#ffffff', aiBg: '#ffffff', scrollbar: '#b9d2d8',
  dangerBg: '#fbe8e8', dangerBorder: '#efc0c0', dangerFg: '#a93434',
  codeBg: '#e8f2f4', codeFg: '#17323a', inlineCodeBg: '#deedf1', inlineCodeFg: '#076d88', logBg: '#eaf3f1', logFg: '#126b4d',
  warningBg: '#f7efd9', warningFg: '#7c5912', sidebarBg: 'rgba(247, 252, 253, 0.84)', sidebarBorder: 'rgba(191, 216, 222, 0.78)',
}

// ---- Dusk: muted plum neutrals with a soft violet accent ----
export const duskDark: Palette = {
  bg: '#15121b', surface: '#1c1824', surface2: '#241e2d', surface3: '#30273b',
  border: '#30283a', border2: '#453951', fg: '#f1ebf5', fg2: '#b8a9c0', fg3: '#85748f',
  accent: '#c29af4', accentDim: '#c29af420', green: '#68ce9b', purple: '#c29af4', red: '#f27683', yellow: '#ddb96b',
  userBg: '#c29af4', onAccent: '#21132c', aiBg: '#211b2a', scrollbar: '#493b55',
  dangerBg: '#391d26', dangerBorder: '#6e3344', dangerFg: '#fa98a3',
  codeBg: '#100d14', codeFg: '#e8dfee', inlineCodeBg: '#2b2334', inlineCodeFg: '#d5b5fa', logBg: '#0d0a11', logFg: '#79d8a9',
  warningBg: '#382d1e', warningFg: '#e6c47b', sidebarBg: 'rgba(28, 24, 36, 0.84)', sidebarBorder: 'rgba(69, 57, 81, 0.64)',
}

export const duskLight: Palette = {
  bg: '#f8f4fa', surface: '#ffffff', surface2: '#fbf8fc', surface3: '#eee6f2',
  border: '#e8dfec', border2: '#d7c9dd', fg: '#2b2031', fg2: '#67566f', fg3: '#94839c',
  accent: '#7651aa', accentDim: '#7651aa18', green: '#287d58', purple: '#7651aa', red: '#bf4655', yellow: '#966711',
  userBg: '#7651aa', onAccent: '#ffffff', aiBg: '#ffffff', scrollbar: '#d1c3d7',
  dangerBg: '#fae9ed', dangerBorder: '#edc2cb', dangerFg: '#9f3544',
  codeBg: '#f0eaf3', codeFg: '#33253a', inlineCodeBg: '#ece3f0', inlineCodeFg: '#684396', logBg: '#f1ecf2', logFg: '#236d4e',
  warningBg: '#f8efd9', warningFg: '#7b5613', sidebarBg: 'rgba(255, 252, 255, 0.84)', sidebarBorder: 'rgba(215, 201, 221, 0.8)',
}

// ---- Ember: charcoal and clay with a restrained copper accent ----
export const emberDark: Palette = {
  bg: '#171311', surface: '#201a17', surface2: '#29211d', surface3: '#342923',
  border: '#352a24', border2: '#4a3a31', fg: '#f4ece6', fg2: '#c0ada1', fg3: '#8b766a',
  accent: '#f08a5d', accentDim: '#f08a5d20', green: '#79c88d', purple: '#b99ae8', red: '#f06f68', yellow: '#e6b85d',
  userBg: '#f08a5d', onAccent: '#2a1007', aiBg: '#251e1a', scrollbar: '#4d3c33',
  dangerBg: '#3b1d1c', dangerBorder: '#743530', dangerFg: '#fa958d',
  codeBg: '#100d0b', codeFg: '#eadfd8', inlineCodeBg: '#30251f', inlineCodeFg: '#f4a47e', logBg: '#0d0a09', logFg: '#82d296',
  warningBg: '#3a2b18', warningFg: '#e9bd6c', sidebarBg: 'rgba(32, 26, 23, 0.84)', sidebarBorder: 'rgba(74, 58, 49, 0.66)',
}

export const emberLight: Palette = {
  bg: '#faf5f1', surface: '#ffffff', surface2: '#fcf8f5', surface3: '#f0e5de',
  border: '#eadfd8', border2: '#dac9bf', fg: '#30221c', fg2: '#6e594e', fg3: '#9a8478',
  accent: '#b94f29', accentDim: '#b94f2918', green: '#2c7d4d', purple: '#7559a5', red: '#bd443e', yellow: '#936510',
  userBg: '#b94f29', onAccent: '#ffffff', aiBg: '#ffffff', scrollbar: '#d5c3b9',
  dangerBg: '#fbe8e6', dangerBorder: '#efc1bc', dangerFg: '#a13731',
  codeBg: '#f1e9e4', codeFg: '#362720', inlineCodeBg: '#eee2db', inlineCodeFg: '#9b3f20', logBg: '#f1ece8', logFg: '#276b43',
  warningBg: '#f8edd8', warningFg: '#7d5711', sidebarBg: 'rgba(255, 252, 249, 0.84)', sidebarBorder: 'rgba(218, 201, 191, 0.8)',
}

export type PaletteName = 'classic' | 'terminal' | 'ocean' | 'dusk' | 'ember'

export interface PaletteDefinition {
  label: string
  description: string
  light: Palette
  dark: Palette
}

export const PALETTES: Record<PaletteName, PaletteDefinition> = {
  classic:  { label: 'Classic',  description: 'Clean graphite with a calm blue accent.', light: classicLight, dark: classicDark },
  terminal: { label: 'Terminal', description: 'Warm paper and focused terminal green.', light: terminalLight, dark: terminalDark },
  ocean:    { label: 'Ocean',    description: 'Deep navy and crisp cyan.', light: oceanLight, dark: oceanDark },
  dusk:     { label: 'Dusk',     description: 'Muted plum with soft violet.', light: duskLight, dark: duskDark },
  ember:    { label: 'Ember',    description: 'Charcoal and clay with copper warmth.', light: emberLight, dark: emberDark },
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

/** Complete theme matrix shared by the main and Quick Capture windows. */
export function paletteThemeCss(): string {
  const defaults = `:root {\n${paletteToCssVars(classicDark)}\n}\n` +
    `:root[data-theme="light"] {\n${paletteToCssVars(classicLight)}\n}\n` +
    `:root[data-theme="dark"] {\n${paletteToCssVars(classicDark)}\n}`
  const themes = (Object.entries(PALETTES) as [PaletteName, PaletteDefinition][])
    .flatMap(([name, definition]) => (['light', 'dark'] as const).map(mode =>
      `:root[data-palette="${name}"][data-theme="${mode}"] {\n${paletteToCssVars(definition[mode])}\n}`,
    ))
    .join('\n')
  return `${defaults}\n${themes}`
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
    if (v && Object.prototype.hasOwnProperty.call(PALETTES, v)) return v as PaletteName
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
