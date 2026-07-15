// codey-mac/src/components/AppearanceTab.tsx
import React from 'react'
import { C, ThemeMode, PaletteName, PALETTES, useThemeMode, useEffectiveTheme, usePaletteName } from '../theme'
import { HotkeyRecorder } from './HotkeyRecorder'

const OPTIONS: { value: ThemeMode; label: string }[] = [
  { value: 'light',  label: 'Light'  },
  { value: 'dark',   label: 'Dark'   },
  { value: 'system', label: 'System' },
]

const PALETTE_OPTIONS: { value: PaletteName; label: string }[] = [
  { value: 'classic',  label: PALETTES.classic.label  },
  { value: 'terminal', label: PALETTES.terminal.label },
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
  const [palette, setPalette] = usePaletteName()
  const effective = useEffectiveTheme()
  const [version, setVersion] = React.useState<string>('')
  const [skipPerms, setSkipPerms] = React.useState<boolean>(true)
  const [notifyEnabled, setNotifyEnabled] = React.useState<boolean>(true)
  const [captureHotkey, setCaptureHotkey] = React.useState<string>('Alt+Space')
  const [screenshotHotkey, setScreenshotHotkey] = React.useState<string>('Control+Alt+Space')
  const [launchAtLogin, setLaunchAtLogin] = React.useState<boolean>(false)
  const [dockless, setDockless] = React.useState<boolean>(false)
  const [loaded, setLoaded] = React.useState(false)

  React.useEffect(() => {
    window.codey?.app?.version?.().then(setVersion).catch(() => { /* ignore */ })
    window.codey?.config?.get?.().then((res: any) => {
      const cfg = res?.ok ? res.data : res
      setSkipPerms(cfg?.gateway?.skipPermissions ?? true)
      setNotifyEnabled(cfg?.notifications?.enabled ?? true)
      setCaptureHotkey(cfg?.capture?.hotkey ?? 'Alt+Space')
      setScreenshotHotkey(cfg?.capture?.screenshotHotkey ?? 'Control+Alt+Space')
      setLaunchAtLogin(cfg?.ui?.launchAtLogin ?? false)
      setDockless(cfg?.ui?.dockless ?? false)
      setLoaded(true)
    }).catch(() => { setLoaded(true) })
  }, [])

  const toggleSkipPerms = (v: boolean) => {
    if (v && !skipPerms && !window.confirm(
      'Enable Skip permissions?\n\nAgents will be able to run shell commands, edit files, and make network requests without asking for confirmation.',
    )) return
    setSkipPerms(v)
    window.codey?.config?.set?.({ gateway: { skipPermissions: v } }).catch(() => { /* ignore */ })
  }

  const toggleNotify = (v: boolean) => {
    setNotifyEnabled(v)
    window.codey?.config?.set?.({ notifications: { enabled: v } }).catch(() => { /* ignore */ })
  }

  const toggleLaunchAtLogin = (v: boolean) => {
    setLaunchAtLogin(v)
    window.codey?.config?.set?.({ ui: { launchAtLogin: v, dockless } }).catch(() => { /* ignore */ })
  }

  const toggleDockless = (v: boolean) => {
    setDockless(v)
    window.codey?.config?.set?.({ ui: { dockless: v, launchAtLogin } }).catch(() => { /* ignore */ })
  }

  const changeCaptureHotkey = (v: string) => {
    setCaptureHotkey(v)
    window.codey?.config?.set?.({ capture: { hotkey: v } }).catch(() => { /* ignore */ })
  }

  const changeScreenshotHotkey = (v: string) => {
    setScreenshotHotkey(v)
    // capture.* merges field-wise in ConfigManager.update, so this preserves hotkey.
    window.codey?.config?.set?.({ capture: { screenshotHotkey: v } }).catch(() => { /* ignore */ })
  }

  return (
    <div style={styles.wrap}>
      <div style={styles.row}>
        <div style={styles.label}>Appearance</div>
        <div role="radiogroup" aria-label="Appearance" style={styles.segmented}>
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
                  color: active ? C.onAccent : C.fg2,
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

      <div style={styles.row}>
        <div style={styles.label}>Theme</div>
        <select
          aria-label="Color theme"
          value={palette}
          onChange={(e) => setPalette(e.target.value as PaletteName)}
          style={styles.select}
        >
          {PALETTE_OPTIONS.map(opt => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      </div>
      <div style={styles.hint}>
        {palette === 'terminal'
          ? 'Terminal — warm paper & terminal green, matching the Codey site.'
          : 'Classic — the original macOS-style colors.'}
      </div>

      {loaded && (
        <div style={styles.settingsGroup}>
          <div style={{ ...styles.settingRow, borderTop: 'none' }}>
            <div style={{ ...styles.label, width: 'auto', flex: 1 }}>
              <div>Skip permissions</div>
              <div style={styles.settingDesc}>
                When enabled, agents run shell commands, edit files, and make network requests without asking for confirmation. Disable to review every action before execution.
              </div>
            </div>
            <Toggle on={skipPerms} onChange={toggleSkipPerms}/>
          </div>

          <div style={styles.settingRow}>
            <div style={{ ...styles.label, width: 'auto', flex: 1 }}>
              <div>Background notifications</div>
              <div style={styles.settingDesc}>
                Notify when Codey finishes, errors, or needs your input while the app is in the background.
              </div>
            </div>
            <Toggle on={notifyEnabled} onChange={toggleNotify}/>
          </div>

          <div style={styles.settingRow}>
            <div style={{ ...styles.label, width: 'auto', flex: 1 }}>
              <div>Quick capture hotkey</div>
              <div style={styles.settingDesc}>
                Summon a floating composer from anywhere to send Codey a task. Clear to disable.
              </div>
            </div>
            <HotkeyRecorder value={captureHotkey} onChange={changeCaptureHotkey}/>
          </div>

          <div style={styles.settingRow}>
            <div style={{ ...styles.label, width: 'auto', flex: 1 }}>
              <div>Screenshot to Quick Capture</div>
              <div style={styles.settingDesc}>
                Grab a full-screen screenshot and open Quick Capture with it attached. Clear to disable.
              </div>
            </div>
            <HotkeyRecorder value={screenshotHotkey} onChange={changeScreenshotHotkey}/>
          </div>

          <div style={styles.settingRow}>
            <div style={{ ...styles.label, width: 'auto', flex: 1 }}>
              <div>Launch Codey at login</div>
              <div style={styles.settingDesc}>
                Start Codey automatically when you log in, so the gateway and menu bar are always available.
              </div>
            </div>
            <Toggle on={launchAtLogin} onChange={toggleLaunchAtLogin}/>
          </div>

          <div style={styles.settingRow}>
            <div style={{ ...styles.label, width: 'auto', flex: 1 }}>
              <div>Hide Dock icon (menu bar only)</div>
              <div style={styles.settingDesc}>
                Run as a menu-bar app with no Dock icon. Codey stays reachable from the menu bar.
              </div>
            </div>
            <Toggle on={dockless} onChange={toggleDockless}/>
          </div>
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
  wrap:  { padding: '24px', display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 720 },
  row:   { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, padding: '13px 14px', borderRadius: 11, background: C.surface, border: `1px solid ${C.border}` },
  label: { fontSize: 13, color: C.fg, width: 80 },
  // Toggle/hotkey settings stacked with dividers so each row's label and
  // control read as a distinct line instead of a packed block.
  settingsGroup: {
    display: 'flex', flexDirection: 'column',
    border: `1px solid ${C.border}`, borderRadius: 12,
    background: C.surface, overflow: 'hidden', boxShadow: '0 5px 14px rgba(0,0,0,0.05)',
  },
  settingRow: {
    display: 'flex', alignItems: 'center', gap: 16,
    padding: '16px 16px', borderTop: `1px solid ${C.border}`,
  },
  settingDesc: { fontSize: 11, color: C.fg3, fontWeight: 400, marginTop: 3, lineHeight: 1.4 },
  segmented: {
    display: 'inline-flex',
    background: C.surface2,
    border: `1px solid ${C.border}`,
    borderRadius: 8,
    padding: 2,
    gap: 2,
  },
  segBtn: {
    border: 'none',
    borderRadius: 6,
    padding: '6px 14px',
    fontSize: 12,
    fontWeight: 500,
    cursor: 'pointer',
  },
  select: {
    background: C.surface2,
    color: C.fg,
    border: `1px solid ${C.border}`,
    borderRadius: 8,
    padding: '8px 10px',
    fontSize: 12,
    fontWeight: 500,
    cursor: 'pointer',
    minWidth: 140,
  },
  hint: { fontSize: 11, color: C.fg3, margin: '-8px 0 0 14px' },
  value: { fontSize: 13, color: C.fg2, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' },
}
