import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { C } from '../theme'
import { pillButton, unwrap } from './settingsAtoms'
import { UIIcon } from './UIIcons'
import { matchesToolSearch } from './tools-search'
import type { PluginInfo, PluginInstallResult } from '../codey-api'

/** Codey refused to touch a skill of this name it did not write. The user
 *  decides; nothing is replaced or deleted until they say so. */
type Pending = { action: 'install' | 'uninstall'; dir: string }

export const PluginsTab: React.FC<{ searchQuery?: string }> = ({ searchQuery = '' }) => {
  const [plugins, setPlugins] = useState<PluginInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  // What the last install did, kept per plugin: which copy landed, and where.
  const [outcome, setOutcome] = useState<Record<string, PluginInstallResult>>({})
  const [pending, setPending] = useState<Record<string, Pending>>({})
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

  const forget = (id: string, from: Record<string, any>) => {
    const next = { ...from }
    delete next[id]
    return next
  }

  const act = async (plugin: PluginInfo, action: 'install' | 'uninstall', force = false) => {
    setBusy(plugin.id)
    setError(null)
    try {
      if (action === 'install') {
        const result = unwrap(await window.codey.plugins.install(plugin.id, force))
        if (!result.installed) {
          setPending(prev => ({ ...prev, [plugin.id]: { action, dir: result.dir } }))
          return
        }
        setOutcome(prev => ({ ...prev, [plugin.id]: result }))
      } else {
        const result = unwrap(await window.codey.plugins.uninstall(plugin.id, force))
        if (!result.removed && result.conflict) {
          setPending(prev => ({ ...prev, [plugin.id]: { action, dir: plugin.dir } }))
          return
        }
        setOutcome(prev => forget(plugin.id, prev))
      }
      setPending(prev => forget(plugin.id, prev))
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
        Plugins give agents extra capabilities. Installing one downloads a skill into
        your own skill folder, where the Skills tab can turn it off or remove it;
        changes apply to the next agent run.
      </div>
      {error && <div style={styles.errorBanner}>{error}</div>}
      {filteredPlugins.map(plugin => {
        const installed = plugin.state !== 'absent'
        const working = busy === plugin.id
        const last = outcome[plugin.id]
        const ask = pending[plugin.id]
        return (
          <div key={plugin.id} style={styles.card}>
            <div style={styles.cardIcon}><UIIcon name="tools" size={18} /></div>
            <div style={styles.cardBody}>
              <div style={styles.cardName}>
                {plugin.name}
                {installed && (
                  <span style={plugin.state === 'disabled' ? styles.badgeMuted : styles.badge}>
                    {plugin.state === 'disabled' ? 'Off in Skills' : 'Installed'}
                    {plugin.version ? ` ${plugin.version}` : ''}
                  </span>
                )}
              </div>
              <div style={styles.cardDesc}>{plugin.description}</div>
              {installed ? (
                <div style={styles.cardHint}>
                  {plugin.state === 'disabled'
                    ? 'Switched off in Skills, so no agent loads it. Turn it back on there.'
                    : 'Listed in Skills as "browser".'}
                  {' '}<span style={styles.path}>{plugin.dir}</span>
                </div>
              ) : (
                <div style={styles.cardHint}>
                  Downloads from <span style={styles.path}>{plugin.sourceUrl}</span>
                </div>
              )}
              {last?.installed && last.source === 'bundled' && (
                <div style={styles.cardWarn}>
                  Could not reach the skills repository, so Codey installed the copy it
                  ships with. {last.reason}
                </div>
              )}
              {ask && (
                <div style={styles.cardWarn}>
                  A skill named "browser" is already at <span style={styles.path}>{ask.dir}</span>,
                  and Codey did not write it.{' '}
                  {ask.action === 'install'
                    ? 'Installing replaces it.'
                    : 'Uninstalling deletes it.'} There is no undo.
                </div>
              )}
            </div>
            <div style={styles.cardActions}>
              {ask ? (
                <>
                  <button
                    onClick={() => setPending(prev => forget(plugin.id, prev))}
                    disabled={working}
                    style={pillButton('ghost')}
                  >
                    Keep mine
                  </button>
                  <button
                    onClick={() => { if (!working) void act(plugin, ask.action, true) }}
                    disabled={working}
                    style={pillButton('danger')}
                  >
                    {ask.action === 'install' ? 'Replace it' : 'Delete it'}
                  </button>
                </>
              ) : (
                <>
                  {installed && (
                    <button
                      onClick={() => { if (!working) void act(plugin, 'install') }}
                      disabled={working}
                      style={pillButton('ghost')}
                      title="Download the published skill again, replacing your copy"
                    >
                      Update
                    </button>
                  )}
                  <button
                    onClick={() => { if (!working) void act(plugin, installed ? 'uninstall' : 'install') }}
                    disabled={working}
                    style={pillButton(installed ? 'danger' : 'primary')}
                  >
                    {working ? (installed ? 'Working…' : 'Installing…') : installed ? 'Uninstall' : 'Install'}
                  </button>
                </>
              )}
            </div>
          </div>
        )
      })}
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
  cardHint: { color: C.fg2, fontSize: 11, lineHeight: 1.45, marginTop: 5 },
  cardWarn: { color: C.fg2, fontSize: 11, lineHeight: 1.45, marginTop: 5, opacity: 0.9 },
  path: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 10.5, color: C.fg3 },
  badge: {
    marginLeft: 8, padding: '1px 7px', borderRadius: 20, fontSize: 10, fontWeight: 650,
    background: C.accent + '22', color: C.accent, verticalAlign: 'middle',
  },
  badgeMuted: {
    marginLeft: 8, padding: '1px 7px', borderRadius: 20, fontSize: 10, fontWeight: 650,
    background: C.surface3, color: C.fg3, verticalAlign: 'middle',
  },
  cardActions: { display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0 },
  emptySearch: { color: C.fg3, fontSize: 12, textAlign: 'center', padding: '30px 16px' },
}
