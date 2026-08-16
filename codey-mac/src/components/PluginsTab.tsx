import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { C } from '../theme'
import { Toggle, unwrap } from './settingsAtoms'
import { UIIcon } from './UIIcons'
import { matchesToolSearch } from './tools-search'
import type { PluginInfo } from '../codey-api'

export const PluginsTab: React.FC<{ searchQuery?: string }> = ({ searchQuery = '' }) => {
  const [plugins, setPlugins] = useState<PluginInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const filteredPlugins = useMemo(
    () => plugins.filter(plugin => matchesToolSearch(searchQuery, plugin.name, plugin.description)),
    [plugins, searchQuery],
  )

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
      {filteredPlugins.map(plugin => (
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
      {plugins.length > 0 && filteredPlugins.length === 0 && (
        <div style={styles.emptySearch}>No plugins match that name or description.</div>
      )}
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
  emptySearch: { color: C.fg3, fontSize: 12, textAlign: 'center', padding: '30px 16px' },
}
