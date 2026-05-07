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
