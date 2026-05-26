// codey-mac/src/components/AppearanceTab.tsx
import React from 'react'
import { C, ThemeMode, useThemeMode, useEffectiveTheme } from '../theme'

const OPTIONS: { value: ThemeMode; label: string }[] = [
  { value: 'light',  label: 'Light'  },
  { value: 'dark',   label: 'Dark'   },
  { value: 'system', label: 'System' },
]

const Toggle: React.FC<{ on: boolean; onChange: (v: boolean) => void }> = ({ on, onChange }) => (
  <div onClick={() => onChange(!on)} style={{
    width: 36, height: 20, borderRadius: 10, flexShrink: 0,
    background: on ? C.accent : C.surface3,
    border: `1px solid ${on ? C.accent : C.border2}`,
    cursor: 'pointer', position: 'relative', transition: 'all 0.2s',
  }}>
    <div style={{
      position: 'absolute', top: 1, left: on ? 17 : 1,
      width: 16, height: 16, borderRadius: '50%', background: '#fff',
      transition: 'left 0.2s', boxShadow: '0 1px 3px rgba(0,0,0,0.3)',
    }}/>
  </div>
)

export const AppearanceTab: React.FC = () => {
  const [mode, setMode] = useThemeMode()
  const effective = useEffectiveTheme()
  const [version, setVersion] = React.useState<string>('')
  const [skipPerms, setSkipPerms] = React.useState<boolean>(true)
  const [loaded, setLoaded] = React.useState(false)

  React.useEffect(() => {
    window.codey?.app?.version?.().then(setVersion).catch(() => { /* ignore */ })
    window.codey?.config?.get?.().then((res: any) => {
      const cfg = res?.ok ? res.data : res
      setSkipPerms(cfg?.gateway?.skipPermissions ?? true)
      setLoaded(true)
    }).catch(() => { setLoaded(true) })
  }, [])

  const toggleSkipPerms = (v: boolean) => {
    setSkipPerms(v)
    window.codey?.config?.set?.({ gateway: { skipPermissions: v } }).catch(() => { /* ignore */ })
  }

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

      {loaded && (
        <div style={styles.row}>
          <div style={{ ...styles.label, width: 'auto', flex: 1 }}>
            <div>Skip permissions</div>
            <div style={{ fontSize: 11, color: C.fg3, fontWeight: 400, marginTop: 2 }}>
              Auto-approve agent actions (--dangerously-skip-permissions)
            </div>
          </div>
          <Toggle on={skipPerms} onChange={toggleSkipPerms}/>
        </div>
      )}

      <div style={styles.row}>
        <div style={styles.label}>Version</div>
        <div style={styles.value}>{version || '—'}</div>
      </div>
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
  value: { fontSize: 13, color: C.fg2, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' },
}
