import React, { useEffect, useState } from 'react'
import { C } from '../theme'
import { pillButton, Toggle } from './settingsAtoms'
import { UIIcon } from './UIIcons'
import { PluginLogo } from './PluginLogos'

export const COMPUTER_PLUGIN = {
  id: 'computer',
  name: 'Computer',
  tagline: 'The apps on your Mac — agents see the window and press its controls.',
}

/** Live computer-control state for surfaces that only need the switch. */
export function useComputerControl() {
  const [state, setState] = useState<ComputerControlState>()
  useEffect(() => {
    let alive = true
    void window.codey.computer.status().then(r => { if (alive && r.ok) setState(r.data) })
    const off = window.codey.computer.onChanged(setState)
    return () => { alive = false; off() }
  }, [])
  const ready = isReady(state)
  const setEnabled = async (enabled: boolean) => {
    const result = await window.codey.computer.configure(enabled, state?.apps ?? [])
    if (!result.ok) throw new Error(result.error)
    setState(result.data)
  }
  return { state, ready, setEnabled }
}
import type { ComputerApp, ComputerControlState } from '../../electron/computer-control'

/** Setup is complete: the driver is there and both permissions are granted.
 *  No app list is needed; an empty list means every application. */
const isReady = (state?: ComputerControlState) =>
  !!state?.available && state.accessibility && state.screenRecording

export const ComputerTab: React.FC<{ onBack?: () => void }> = ({ onBack }) => {
  const [state, setState] = useState<ComputerControlState>()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const refresh = async () => {
    const result = await window.codey.computer.status()
    if (result.ok) setState(result.data); else setError(result.error)
  }
  useEffect(() => {
    void refresh()
    const off = window.codey.computer.onChanged(setState)
    const focus = () => { void refresh() }
    window.addEventListener('focus', focus)
    return () => { off(); window.removeEventListener('focus', focus) }
  }, [])
  const run = async (action: () => Promise<void>) => {
    setBusy(true); setError('')
    try { await action() } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }
  const configure = async (enabled: boolean, apps = state?.apps ?? []) => {
    const result = await window.codey.computer.configure(enabled, apps)
    if (!result.ok) throw new Error(result.error)
    setState(result.data)
  }
  const ready = isReady(state)
  const apps = state?.apps ?? []
  const requestPermissions = () => void run(async () => {
    const r = await window.codey.computer.permissions()
    if (!r.ok) throw new Error(r.error)
    setState(r.data)
  })
  const pickApp = async (): Promise<ComputerApp | null> => {
    const r = await window.codey.computer.pickApp()
    if (!r.ok) throw new Error(r.error)
    return r.data
  }
  const blocker = !state ? 'Loading…'
    : !state.available ? 'This build does not include the driver.'
    : !state.accessibility || !state.screenRecording ? 'Grant both permissions below first.'
    : ''
  const checks = [
    { key: 'driver', label: 'Driver', hint: 'Bundled with Codey.', ok: !!state?.available, fix: false },
    { key: 'ax', label: 'Accessibility', hint: 'Lets agents read controls and press them.', ok: !!state?.accessibility, fix: true },
    { key: 'screen', label: 'Screen Recording', hint: 'Lets agents and you see the window. Restart Codey after granting.', ok: !!state?.screenRecording, fix: true },
  ]
  return <section style={styles.root}>
    {onBack && <button type="button" onClick={onBack} style={styles.backButton}>
      <span style={styles.backGlyph}><UIIcon name="chevron" size={14} /></span>
      Plugins
    </button>}
    {error && <div role="alert" style={styles.errorBanner}>{error}</div>}
    <div style={styles.hero}>
      <div style={styles.heroIcon}><PluginLogo id="computer" size={46} /></div>
      <div style={styles.heroCopy}>
        <div style={styles.heroName}>{COMPUTER_PLUGIN.name}</div>
        <div style={styles.heroTagline}>Agents can see and operate the Mac apps you allow. Codey asks you the first time a task uses them.</div>
      </div>
      <div style={styles.heroSwitch}>
        <span style={state?.enabled ? styles.statusOn : styles.statusMuted}>{state?.enabled ? 'On' : 'Off'}</span>
        <Toggle on={state?.enabled ?? false} label="Enable for new tasks" disabled={busy || (!state?.enabled && !ready)}
          title={!state?.enabled && blocker ? blocker : 'Enable for new tasks'}
          onChange={next => void run(() => configure(next))} />
      </div>
    </div>
    {!state?.enabled && blocker && <div style={styles.hint}>{blocker}</div>}

    <div style={styles.section}>
      <div style={styles.sectionTitle}>
        <span>Setup</span>
        <button style={pillButton('ghost')} disabled={busy} onClick={() => void run(refresh)}>Check again</button>
      </div>
      {checks.map((item, index) => <div key={item.key} style={{ ...styles.row, ...(index > 0 ? styles.rowBorder : null) }}>
        <span style={{ ...styles.dot, ...(item.ok ? styles.dotOk : styles.dotMissing) }}>
          <UIIcon name={item.ok ? 'check' : 'alert'} size={13} />
        </span>
        <span style={styles.rowCopy}>
          <span style={styles.rowName}>{item.label}</span>
          <span style={styles.rowTagline}>{item.hint}</span>
        </span>
        {item.ok ? <span style={styles.statusOn}>{item.fix ? 'Allowed' : 'Ready'}</span>
          : item.fix ? <button style={pillButton('primary')} disabled={busy} onClick={requestPermissions}>Allow…</button>
          : <span style={styles.statusMuted}>Not bundled</span>}
      </div>)}
    </div>

    <div style={styles.section}>
      <div style={styles.sectionTitle}>
        <span>Applications</span>
        <button style={pillButton('ghost')} disabled={busy || apps.length >= 16} onClick={() => void run(async () => {
          const app = await pickApp()
          if (app && !apps.some(a => a.bundleId === app.bundleId)) await configure(!!state?.enabled, [...apps, app])
        })}>{apps.length ? 'Add application' : 'Limit to specific apps…'}</button>
      </div>
      {apps.length === 0
        ? <div style={styles.sectionNote}><b style={styles.strong}>All applications.</b> Agents can use any application on this Mac except Codey. Every task still asks you before it starts. Web pages go through the Codey Browser.</div>
        : <>
          <div style={styles.sectionNote}><b style={styles.strong}>Only these applications.</b> Remove them all to allow every application again. Changing the list stops a computer task that is running.</div>
          {apps.map((item, index) => <div key={item.bundleId} style={{ ...styles.row, ...(index > 0 ? styles.rowBorder : null) }}>
            <span style={styles.rowCopy}>
              <span style={styles.rowName}>{item.name}</span>
              <span style={{ ...styles.rowTagline, ...styles.mono }}>{item.bundleId}</span>
            </span>
            <button style={styles.iconButton} disabled={busy} aria-label={`Remove ${item.name}`} title={`Remove ${item.name}`}
              onClick={() => void run(() => configure(!!state?.enabled, apps.filter(a => a.bundleId !== item.bundleId)))}><UIIcon name="trash" size={15} /></button>
          </div>)}
        </>}
    </div>
  </section>
}

const styles: Record<string, React.CSSProperties> = {
  root: { maxWidth: 820, margin: '0 auto', paddingBottom: 12, color: C.fg },
  errorBanner: {
    background: C.dangerBg, color: C.dangerFg, border: `1px solid ${C.dangerBorder}`,
    padding: '9px 11px', borderRadius: 8, marginBottom: 14, fontSize: 12,
  },
  backButton: {
    display: 'inline-flex', alignItems: 'center', gap: 4, border: 'none', background: 'transparent',
    color: C.fg2, cursor: 'pointer', padding: '4px 2px', marginBottom: 14, fontSize: 12,
  },
  backGlyph: { display: 'inline-flex', transform: 'rotate(180deg)' },
  hero: { display: 'flex', alignItems: 'center', gap: 13, padding: '2px 2px 14px' },
  heroIcon: {
    width: 56, height: 56, display: 'grid', placeItems: 'center', flexShrink: 0,
    borderRadius: 12, background: C.surface2, border: `1px solid ${C.border}`,
  },
  heroCopy: { flex: 1, minWidth: 0 },
  heroName: { fontSize: 18, lineHeight: 1.3, fontWeight: 600 },
  heroTagline: { color: C.fg3, fontSize: 12, lineHeight: 1.45, marginTop: 3 },
  heroSwitch: { display: 'flex', alignItems: 'center', gap: 9, flexShrink: 0, fontSize: 12 },
  hint: { color: C.warningFg, background: C.warningBg, borderRadius: 8, padding: '8px 11px', fontSize: 12, marginBottom: 14 },
  section: { borderTop: `1px solid ${C.border}`, padding: '16px 2px 6px' },
  sectionTitle: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10,
    fontSize: 13, fontWeight: 600, marginBottom: 8,
  },
  sectionNote: { color: C.fg3, fontSize: 12, lineHeight: 1.5, marginBottom: 6, maxWidth: 690 },
  row: { display: 'flex', alignItems: 'center', gap: 12, minHeight: 54, padding: '6px 0' },
  rowBorder: { borderTop: `1px solid ${C.border}` },
  rowCopy: { display: 'block', flex: 1, minWidth: 0 },
  rowName: { display: 'block', fontSize: 13, lineHeight: 1.35, fontWeight: 600 },
  rowTagline: { display: 'block', color: C.fg3, fontSize: 12, lineHeight: 1.45, marginTop: 2 },
  mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 11 },
  dot: { width: 24, height: 24, borderRadius: '50%', display: 'grid', placeItems: 'center', flexShrink: 0 },
  dotOk: { background: `color-mix(in srgb, ${C.green} 16%, transparent)`, color: C.green },
  dotMissing: { background: C.warningBg, color: C.warningFg },
  statusOn: { color: C.green, fontSize: 12, fontWeight: 600 },
  statusMuted: { color: C.fg3, fontSize: 12, fontWeight: 600 },
  iconButton: {
    width: 30, height: 30, display: 'grid', placeItems: 'center', flexShrink: 0, padding: 0,
    border: 'none', borderRadius: 8, background: 'transparent', color: C.fg3, cursor: 'pointer',
  },
  strong: { color: C.fg2, fontWeight: 600 },
  indicator: {
    position: 'fixed', bottom: 16, right: 16, zIndex: 10000, display: 'flex', alignItems: 'center', gap: 10,
    padding: '8px 8px 8px 12px', borderRadius: 10, border: `1px solid ${C.border2}`,
    background: C.surface2, color: C.fg, fontSize: 12, boxShadow: '0 6px 20px rgba(0,0,0,0.25)',
  },
  indicatorDot: { width: 8, height: 8, borderRadius: '50%', background: C.red, flexShrink: 0 },
}

/** Kept outside the Tools overlay so control can always be stopped. */
export const ComputerControlIndicator: React.FC = () => {
  const [state, setState] = useState<ComputerControlState>()
  const [error, setError] = useState('')
  useEffect(() => {
    void window.codey.computer.status().then(r => { if (r.ok) setState(r.data) })
    return window.codey.computer.onChanged(setState)
  }, [])
  if (!state?.active && !state?.queued) return null
  const label = state.active?.phase === 'waiting' ? 'Waiting for your approval'
    : state.active?.phase === 'starting' ? 'Starting computer control' : 'Controlling your Mac'
  return <div role="status" style={styles.indicator}>
    <span style={styles.indicatorDot} />
    <span>{state.active ? `${state.active.agent} · ${label}` : 'Computer control queued'}{state.queued ? ` · ${state.queued} queued` : ''}</span>
    <button style={pillButton('danger')} onClick={() => { void window.codey.computer.stop().then(r => { if (!r.ok) setError(r.error) }) }}>Stop</button>
    {error && <span role="alert" style={{ color: C.dangerFg }}>{error}</span>}
  </div>
}
