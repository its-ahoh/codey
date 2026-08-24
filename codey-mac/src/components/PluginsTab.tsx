import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { C } from '../theme'
import { pillButton, unwrap } from './settingsAtoms'
import { UIIcon } from './UIIcons'
import { matchesToolSearch } from './tools-search'
import { BrowserProfiles } from './BrowserProfiles'
import type { PluginInfo, PluginInstallResult, PluginUpdateCheck } from '../codey-api'

/** Codey refused to touch a skill of this name it did not write. The user
 *  decides; nothing is replaced or deleted until they say so. */
type Pending = { action: 'install' | 'uninstall'; dir: string }

/** Plugins whose card carries a settings page. The browser plugin's settings
 *  are the session profiles: save, import, activate, export and delete. */
const SETTINGS_PLUGINS = new Set<string>(['browser'])

/** Toggle which plugin's settings page is open: clicking the same plugin again
 *  closes it, clicking another opens it. */
export function toggleSettingsId(current: string | null, id: string): string | null {
  return current === id ? null : id
}

export const PluginsTab: React.FC<{ searchQuery?: string }> = ({ searchQuery = '' }) => {
  const [plugins, setPlugins] = useState<PluginInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  // What the last install did, kept per plugin: which copy landed, and where.
  const [outcome, setOutcome] = useState<Record<string, PluginInstallResult>>({})
  const [pending, setPending] = useState<Record<string, Pending>>({})
  // Whether the published skill moved since this copy was installed. `null`
  // means nothing could be checked — the repo was unreachable, so no claim.
  const [update, setUpdate] = useState<Record<string, PluginUpdateCheck>>({})
  // Which plugin's settings page is open (only plugins in SETTINGS_PLUGINS).
  const [settingsFor, setSettingsFor] = useState<string | null>(null)
  const filteredPlugins = useMemo(
    () => plugins.filter(plugin => matchesToolSearch(searchQuery, plugin.name, plugin.description)),
    [plugins, searchQuery],
  )

  const checkForUpdate = useCallback(async (plugin: PluginInfo) => {
    // Hide any stale result while re-checking. If the check cannot complete,
    // we do not know that an update exists and should not offer the action.
    setUpdate(prev => {
      const next = { ...prev }
      delete next[plugin.id]
      return next
    })
    try {
      const result = unwrap(await window.codey.plugins.check(plugin.id))
      setUpdate(prev => ({ ...prev, [plugin.id]: result }))
    } catch {
      // Offline or refused: say nothing rather than claim there is no update.
    }
  }, [])

  const reload = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const listed = unwrap(await window.codey.plugins.list())
      setPlugins(listed)
      for (const plugin of listed) {
        if (plugin.state !== 'absent') void checkForUpdate(plugin)
      }
    } catch (e: any) {
      setError(e?.message ?? String(e))
    } finally {
      setLoading(false)
    }
  }, [checkForUpdate])

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
        const hasSettings = SETTINGS_PLUGINS.has(plugin.id) && installed
        const settingsOpen = settingsFor === plugin.id
        return (
          <div key={plugin.id} style={styles.pluginWrap}>
            <div style={{ ...styles.card, ...(settingsOpen ? styles.cardWithSettings : null) }}>
              <div style={styles.cardIcon}><UIIcon name="tools" size={18} /></div>
              <div style={styles.cardBody}>
                <div style={styles.cardName}>
                  {plugin.name}
                  {installed && (
                    <span style={plugin.state === 'disabled' ? styles.badgeMuted : styles.badge}>
                      {plugin.state === 'disabled' ? 'Off in Skills' : 'Installed'}
                    </span>
                  )}
                </div>
                <div style={styles.cardDesc}>{plugin.description}</div>
                {installed ? (
                  <div style={styles.cardHint}>
                    {plugin.state === 'disabled'
                      ? 'Switched off in Skills, so no agent loads it. Turn it back on there.'
                      : 'Listed in Skills as "codey:browser".'}
                    {update[plugin.id]?.needsUpdate === true && (
                      <div style={styles.updateHint}>
                        {update[plugin.id]?.recorded === 'bundled'
                          ? 'This copy came with the app, installed while the repository was '
                            + 'unreachable — Update to pull the published one.'
                          : 'The published skill has moved since this copy was installed — '
                            + 'Update to get it.'}
                      </div>
                    )}
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
                {hasSettings && (
                  <button
                    onClick={() => setSettingsFor(current => toggleSettingsId(current, plugin.id))}
                    disabled={working}
                    style={pluginActionButton(settingsOpen ? 'active' : 'neutral')}
                    title="Browser settings — session profiles"
                  >
                    <UIIcon name="settings" size={13} /> Settings
                  </button>
                )}
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
                    {installed && update[plugin.id]?.needsUpdate === true && (
                      <button
                        onClick={() => { if (!working) void act(plugin, 'install') }}
                        disabled={working}
                        style={pillButton('primary')}
                        title="A newer published version is available — update now"
                      >
                        Update
                      </button>
                    )}
                    <button
                      onClick={() => { if (!working) void act(plugin, installed ? 'uninstall' : 'install') }}
                      disabled={working}
                      style={installed ? pluginActionButton('danger') : pillButton('primary')}
                    >
                      {installed && <UIIcon name="trash" size={13} />}
                      {working ? (installed ? 'Working…' : 'Installing…') : installed ? 'Uninstall' : 'Install'}
                    </button>
                  </>
                )}
              </div>
            </div>
            {settingsOpen && (
              <div style={styles.settingsPanel}>
                <div style={styles.settingsHeader}>
                  <div style={styles.settingsHeading}>
                    <div style={styles.settingsIcon}><UIIcon name="users" size={15} /></div>
                    <div>
                      <div style={styles.settingsTitle}>Session profiles</div>
                      <div style={styles.settingsCopy}>
                        Save your current browser session, import a Codey or Playwright profile, and switch identities
                        without signing in again.
                      </div>
                    </div>
                  </div>
                  <button type="button" onClick={() => setSettingsFor(null)} style={pillButton('ghost')}>
                    Done
                  </button>
                </div>
                <BrowserProfiles />
              </div>
            )}
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
  pluginWrap: {
    marginBottom: 10, border: `1px solid ${C.border}`, borderRadius: 12,
    background: C.surface2, overflow: 'hidden',
  },
  card: {
    display: 'flex', alignItems: 'center', gap: 12, padding: '15px 16px',
    background: C.surface2,
  },
  cardWithSettings: { paddingBottom: 14 },
  settingsPanel: {
    padding: '16px', borderTop: `1px solid ${C.border}`, background: C.surface,
  },
  settingsHeader: {
    display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, marginBottom: 12,
  },
  settingsHeading: { display: 'flex', alignItems: 'flex-start', gap: 10, minWidth: 0 },
  settingsIcon: {
    width: 30, height: 30, display: 'grid', placeItems: 'center', flexShrink: 0,
    borderRadius: 8, background: C.accentDim, color: C.accent,
  },
  settingsTitle: { color: C.fg, fontSize: 13, fontWeight: 750 },
  settingsCopy: { color: C.fg3, fontSize: 11, lineHeight: 1.45, marginTop: 3, maxWidth: 650 },
  cardIcon: { color: C.accent, flexShrink: 0 },
  cardBody: { flex: 1, minWidth: 0 },
  cardName: { color: C.fg, fontSize: 13, fontWeight: 700, marginBottom: 3 },
  cardDesc: { color: C.fg3, fontSize: 11.5, lineHeight: 1.45 },
  cardHint: { color: C.fg2, fontSize: 11, lineHeight: 1.45, marginTop: 5 },
  updateHint: { color: C.accent, fontSize: 11, lineHeight: 1.45, marginTop: 4 },
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

function pluginActionButton(variant: 'neutral' | 'active' | 'danger'): React.CSSProperties {
  return {
    ...pillButton('ghost'), display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
    minWidth: 94, background: variant === 'active' ? C.accentDim : C.surface,
    border: `1px solid ${variant === 'danger' ? C.dangerBorder : variant === 'active' ? C.accent : C.border2}`,
    color: variant === 'danger' ? C.dangerFg : variant === 'active' ? C.accent : C.fg2,
  }
}
