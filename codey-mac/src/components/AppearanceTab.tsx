// codey-mac/src/components/AppearanceTab.tsx
import React from 'react'
import { C, ThemeMode, PaletteName, PaletteDefinition, PALETTES, useThemeMode, useEffectiveTheme, usePaletteName } from '../theme'
import { HotkeyRecorder } from './HotkeyRecorder'
import { Section, pageStyle, Toggle } from './settingsAtoms'
import { getStatusPanelEnabled, setStatusPanelEnabled } from './statusPanelPref'

const OPTIONS: { value: ThemeMode; label: string }[] = [
  { value: 'light',  label: 'Light'  },
  { value: 'dark',   label: 'Dark'   },
  { value: 'system', label: 'System' },
]

const PALETTE_OPTIONS = Object.entries(PALETTES) as [PaletteName, PaletteDefinition][]

export const AppearanceTab: React.FC = () => {
  const [mode, setMode] = useThemeMode()
  const [palette, setPalette] = usePaletteName()
  const effective = useEffectiveTheme()
  const previewMode = mode === 'system' ? effective : mode
  const [version, setVersion] = React.useState<string>('')
  const [skipPerms, setSkipPerms] = React.useState<boolean>(true)
  const [notifyEnabled, setNotifyEnabled] = React.useState<boolean>(true)
  const [captureHotkey, setCaptureHotkey] = React.useState<string>('Alt+Space')
  const [screenshotHotkey, setScreenshotHotkey] = React.useState<string>('Control+Alt+Space')
  const [launchAtLogin, setLaunchAtLogin] = React.useState<boolean>(false)
  const [dockless, setDockless] = React.useState<boolean>(false)
  const [statusPanel, setStatusPanel] = React.useState<boolean>(getStatusPanelEnabled)
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
    <div style={{ ...pageStyle, ...styles.wrap }}>
      <Section first title="Appearance" description="Choose how Codey looks on this Mac." />
      <div style={styles.settingsGroup}>
      <div style={{ ...styles.settingRow, borderTop: 'none' }}>
        <div style={{ ...styles.label, width: 'auto', flex: 1 }}>
          <div>Mode</div>
          {mode === 'system' && (
            <div style={styles.settingDesc}>Following macOS: {effective === 'dark' ? 'Dark' : 'Light'}</div>
          )}
        </div>
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

      <div style={{ ...styles.settingRow, ...styles.themeRow }}>
        <div style={{ ...styles.label, width: 'auto' }}>
          <div>Color theme</div>
          <div style={styles.settingDesc}>Choose a palette. Each one adapts to Light and Dark mode.</div>
        </div>
        <div role="radiogroup" aria-label="Color theme" style={styles.paletteGrid}>
          {PALETTE_OPTIONS.map(([name, definition]) => {
            const active = palette === name
            const preview = definition[previewMode]
            return (
              <button
                key={name}
                role="radio"
                aria-checked={active}
                onClick={() => setPalette(name)}
                style={{
                  ...styles.paletteCard,
                  background: active ? C.accentDim : C.surface2,
                  borderColor: active ? C.accent : C.border,
                  boxShadow: active ? `0 0 0 1px ${C.accentDim}` : 'none',
                }}
              >
                <span style={{ ...styles.palettePreview, background: preview.bg, borderColor: preview.border2 }}>
                  <span style={{ ...styles.previewSidebar, background: preview.surface }} />
                  <span style={{ ...styles.previewLine, background: preview.fg3 }} />
                  <span style={{ ...styles.previewAccent, background: preview.accent }} />
                </span>
                <span style={styles.paletteCopy}>
                  <span style={{ ...styles.paletteName, color: active ? C.accent : C.fg }}>{definition.label}</span>
                  <span style={styles.paletteDescription}>{definition.description}</span>
                </span>
                <span aria-hidden="true" style={{ ...styles.check, opacity: active ? 1 : 0 }}>✓</span>
              </button>
            )
          })}
        </div>
      </div>

      <div style={styles.settingRow}>
        <div style={{ ...styles.label, width: 'auto', flex: 1 }}>
          <div>Status panel</div>
          <div style={styles.settingDesc}>
            Show the Status tab and the floating status card in the chat's right panel. Off also stops Codey from generating the status brief.
          </div>
        </div>
        <Toggle
          on={statusPanel}
          onChange={(v) => { setStatusPanel(v); setStatusPanelEnabled(v) }}
        />
      </div>
      </div>

      {loaded && (
        <>
          <Section title="Behavior" description="App-wide permissions, notifications, shortcuts, and launch behavior." />
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
        </>
      )}

      <Section title="About" />
      <div style={styles.row}>
        <div style={styles.label}>Version</div>
        <div style={styles.value}>{version || '—'}</div>
      </div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  // This page scrolls as one natural document. Making it a height-constrained
  // flex column caused the large setting groups to shrink; because those
  // groups hide overflow for their rounded corners, their final rows were
  // clipped underneath the following section.
  wrap:  { display: 'block' },
  row:   { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, padding: '13px 14px', borderRadius: 11, background: C.surface, border: `1px solid ${C.border}` },
  label: { fontSize: 13, color: C.fg, width: 80 },
  // Toggle/hotkey settings stacked with dividers so each row's label and
  // control read as a distinct line instead of a packed block.
  settingsGroup: {
    display: 'flex', flexDirection: 'column',
    flexShrink: 0,
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
  themeRow: { flexDirection: 'column', alignItems: 'stretch', gap: 12 },
  paletteGrid: { display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 8 },
  paletteCard: {
    minWidth: 0, display: 'flex', alignItems: 'center', gap: 10, position: 'relative',
    padding: 10, border: '1px solid', borderRadius: 10, cursor: 'pointer', textAlign: 'left',
  },
  palettePreview: {
    width: 48, height: 36, flexShrink: 0, position: 'relative', overflow: 'hidden',
    border: '1px solid', borderRadius: 7,
  },
  previewSidebar: { position: 'absolute', inset: '0 auto 0 0', width: 14 },
  previewLine: { position: 'absolute', left: 20, top: 10, width: 18, height: 3, borderRadius: 2, opacity: 0.72 },
  previewAccent: { position: 'absolute', left: 20, top: 19, width: 21, height: 8, borderRadius: 4 },
  paletteCopy: { minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 },
  paletteName: { fontSize: 12, fontWeight: 650 },
  paletteDescription: { color: C.fg3, fontSize: 10, lineHeight: 1.35 },
  check: { marginLeft: 'auto', color: C.accent, fontSize: 12, fontWeight: 800 },
  value: { fontSize: 13, color: C.fg2, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' },
}
