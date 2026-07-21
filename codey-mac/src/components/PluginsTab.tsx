import React, { useCallback, useEffect, useState } from 'react'
import { C } from '../theme'
import { unwrap } from './settingsAtoms'
import { UIIcon } from './UIIcons'
import type { PluginInfo } from '../codey-api'

// Matches the toggle idiom already used by AppearanceTab / ChannelsSection.
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

export const PluginsTab: React.FC = () => {
  const [plugins, setPlugins] = useState<PluginInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const reload = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setPlugins(unwrap(await window.codey.plugins.list()))
    } catch (e: any) {
      setError(e?.message ?? String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void reload() }, [reload])

  const toggle = async (plugin: PluginInfo) => {
    setBusy(plugin.id)
    setError(null)
    try {
      unwrap(await window.codey.plugins.setEnabled(plugin.id, !plugin.enabled))
      await reload()
    } catch (e: any) {
      setError(e?.message ?? String(e))
    } finally {
      setBusy(null)
    }
  }

  if (loading && plugins.length === 0) return <div style={styles.note}>Loading plugins…</div>

  return (
    <div>
      <div style={styles.intro}>
        Plugins give agents extra capabilities. Everything is off until you enable it;
        changes apply to the next agent run.
      </div>
      {error && <div style={styles.errorBanner}>{error}</div>}
      {plugins.map(plugin => (
        <div key={plugin.id} style={styles.card}>
          <div style={styles.cardIcon}><UIIcon name="tools" size={18} /></div>
          <div style={styles.cardBody}>
            <div style={styles.cardName}>{plugin.name}</div>
            <div style={styles.cardDesc}>{plugin.description}</div>
          </div>
          <div style={busy === plugin.id ? styles.toggleBusy : undefined}>
            <Toggle on={plugin.enabled} onChange={() => { if (busy !== plugin.id) void toggle(plugin) }} />
          </div>
        </div>
      ))}
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  note: { color: C.fg3, fontSize: 12, padding: 8 },
  intro: { color: C.fg2, fontSize: 12, marginBottom: 14 },
  errorBanner: {
    background: C.dangerBg, color: C.dangerFg, border: `1px solid ${C.dangerBorder}`,
    padding: '9px 11px', borderRadius: 9, marginBottom: 14, fontSize: 12,
  },
  card: {
    display: 'flex', alignItems: 'center', gap: 12, padding: '14px 16px',
    border: `1px solid ${C.border}`, borderRadius: 12, background: C.surface2, marginBottom: 10,
  },
  cardIcon: { color: C.accent, flexShrink: 0 },
  cardBody: { flex: 1, minWidth: 0 },
  cardName: { color: C.fg, fontSize: 13, fontWeight: 700, marginBottom: 3 },
  cardDesc: { color: C.fg3, fontSize: 11.5, lineHeight: 1.45 },
  toggleBusy: { opacity: 0.5, cursor: 'wait', pointerEvents: 'none' },
}
