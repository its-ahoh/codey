import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { C } from '../theme'
import { pillButton, Toggle, unwrap } from './settingsAtoms'
import { UIIcon } from './UIIcons'
import { PluginLogo } from './PluginLogos'
import { matchesToolSearch } from './tools-search'
import { BrowserProfiles } from './BrowserProfiles'
import { ChromeCompanionSettings } from './ChromeCompanionSettings'
import type { PluginInfo, PluginInstallResult, PluginUpdateCheck } from '../codey-api'

type Pending = { action: 'install' | 'uninstall'; dir: string }
const SETTINGS_PLUGINS = new Set<string>(['browser', 'chrome-companion'])

export function toggleSettingsId(current: string | null, id: string): string | null {
  return current === id ? null : id
}

export function showsDetails(openId: string | null, id: string, hasPending: boolean): boolean {
  return hasPending || openId === id
}

export const PluginsTab: React.FC<{ searchQuery?: string }> = ({ searchQuery = '' }) => {
  const [plugins, setPlugins] = useState<PluginInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [outcome, setOutcome] = useState<Record<string, PluginInstallResult>>({})
  const [pending, setPending] = useState<Record<string, Pending>>({})
  const [update, setUpdate] = useState<Record<string, PluginUpdateCheck>>({})

  const filteredPlugins = useMemo(
    () => plugins.filter(plugin => matchesToolSearch(searchQuery, plugin.name, `${plugin.tagline} ${plugin.description}`)),
    [plugins, searchQuery],
  )
  const selected = plugins.find(plugin => plugin.id === selectedId) ?? null

  const checkForUpdate = useCallback(async (plugin: PluginInfo) => {
    setUpdate(prev => {
      const next = { ...prev }
      delete next[plugin.id]
      return next
    })
    try {
      const result = unwrap(await window.codey.plugins.check(plugin.id))
      setUpdate(prev => ({ ...prev, [plugin.id]: result }))
    } catch {
      // An offline check is unknown, not evidence that the plugin is current.
    }
  }, [])

  const reload = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const listed = unwrap(await window.codey.plugins.list())
      setPlugins(listed)
      for (const plugin of listed) {
        if (plugin.id === 'browser' && plugin.state !== 'absent') void checkForUpdate(plugin)
      }
    } catch (caught: any) {
      setError(caught?.message ?? String(caught))
    } finally {
      setLoading(false)
    }
  }, [checkForUpdate])

  useEffect(() => { void reload() }, [reload])

  const forget = <T,>(id: string, from: Record<string, T>): Record<string, T> => {
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
          setSelectedId(plugin.id)
          return
        }
        setOutcome(prev => ({ ...prev, [plugin.id]: result }))
      } else {
        const result = unwrap(await window.codey.plugins.uninstall(plugin.id, force))
        if (!result.removed && result.conflict) {
          setPending(prev => ({ ...prev, [plugin.id]: { action, dir: plugin.dir } }))
          setSelectedId(plugin.id)
          return
        }
        setOutcome(prev => forget(plugin.id, prev))
      }
      setPending(prev => forget(plugin.id, prev))
      await reload()
    } catch (caught: any) {
      setError(caught?.message ?? String(caught))
    } finally {
      setBusy(null)
    }
  }

  const setEnabled = async (plugin: PluginInfo, enabled: boolean) => {
    if (plugin.state === 'absent') {
      if (enabled) await act(plugin, 'install')
      return
    }
    setBusy(plugin.id)
    setError(null)
    try {
      unwrap(await window.codey.plugins.setEnabled(plugin.id, enabled))
      await reload()
    } catch (caught: any) {
      setError(caught?.message ?? String(caught))
    } finally {
      setBusy(null)
    }
  }

  if (loading && plugins.length === 0) return <div style={styles.note}>Loading plugins…</div>

  if (selected) {
    return (
      <PluginDetails
        plugin={selected}
        working={busy === selected.id}
        last={outcome[selected.id]}
        ask={pending[selected.id]}
        update={update[selected.id]}
        error={error}
        onBack={() => setSelectedId(null)}
        onEnabled={enabled => { if (busy !== selected.id) void setEnabled(selected, enabled) }}
        onInstall={() => { if (busy !== selected.id) void act(selected, 'install') }}
        onUninstall={() => { if (busy !== selected.id) void act(selected, 'uninstall') }}
        onCancelPending={() => setPending(prev => forget(selected.id, prev))}
        onConfirmPending={() => {
          const ask = pending[selected.id]
          if (ask && busy !== selected.id) void act(selected, ask.action, true)
        }}
      />
    )
  }

  return (
    <div style={styles.root}>
      {error && <div style={styles.errorBanner}>{error}</div>}
      <div style={styles.list}>
        {filteredPlugins.map((plugin, index) => {
          const working = busy === plugin.id
          const enabled = plugin.state === 'installed'
          return (
            <div
              key={plugin.id}
              style={{ ...styles.row, ...(index > 0 ? styles.rowBorder : null) }}
            >
              <button
                type="button"
                aria-label={`Open ${plugin.name} details`}
                onClick={() => setSelectedId(plugin.id)}
                style={styles.rowOpen}
              >
                <span style={styles.rowIcon}><PluginLogo id={plugin.id} size={34} /></span>
                <span style={styles.rowCopy}>
                  <span style={styles.rowTitleLine}>
                    <span style={styles.rowName}>{plugin.name}</span>
                    {update[plugin.id]?.needsUpdate === true && <span style={styles.updateBadge}>Update</span>}
                  </span>
                  <span style={styles.rowTagline}>{plugin.tagline}</span>
                </span>
              </button>
              <div style={working ? styles.toggleBusy : styles.rowToggle}>
                <Toggle
                  on={enabled}
                  onChange={next => { if (!working) void setEnabled(plugin, next) }}
                  label={`Enable ${plugin.name}`}
                />
              </div>
              <button
                type="button"
                aria-label={`Open ${plugin.name} details`}
                onClick={() => setSelectedId(plugin.id)}
                style={styles.rowChevron}
              >
                <UIIcon name="chevron" size={15} />
              </button>
            </div>
          )
        })}
      </div>
      {plugins.length > 0 && filteredPlugins.length === 0 && (
        <div style={styles.emptySearch}>No plugins match that name or description.</div>
      )}
    </div>
  )
}

type DetailProps = {
  plugin: PluginInfo
  working: boolean
  last?: PluginInstallResult
  ask?: Pending
  update?: PluginUpdateCheck
  error: string | null
  onBack: () => void
  onEnabled: (enabled: boolean) => void
  onInstall: () => void
  onUninstall: () => void
  onCancelPending: () => void
  onConfirmPending: () => void
}

const PluginDetails: React.FC<DetailProps> = ({
  plugin, working, last, ask, update, error, onBack, onEnabled, onInstall,
  onUninstall, onCancelPending, onConfirmPending,
}) => {
  const installed = plugin.state !== 'absent'
  const enabled = plugin.state === 'installed'
  const bundled = plugin.id === 'chrome-companion'
  const hasSettings = SETTINGS_PLUGINS.has(plugin.id) && (bundled || installed)

  return (
    <div style={styles.detailRoot}>
      <button type="button" onClick={onBack} style={styles.backButton}>
        <span style={styles.backGlyph}><UIIcon name="chevron" size={14} /></span>
        Plugins
      </button>

      <div style={styles.hero}>
        <div style={styles.heroIcon}><PluginLogo id={plugin.id} size={46} /></div>
        <div style={styles.heroCopy}>
          <div style={styles.heroName}>{plugin.name}</div>
          <div style={styles.heroTagline}>{plugin.tagline}</div>
        </div>
        <div style={working ? styles.toggleBusy : undefined}>
          <Toggle on={enabled} onChange={onEnabled} label={`Enable ${plugin.name}`} />
        </div>
      </div>

      {error && <div style={styles.errorBanner}>{error}</div>}

      <DetailSection title="About">
        <div style={styles.detailDescription}>{plugin.description}</div>
        <div style={styles.metaRow}>
          <span style={styles.metaLabel}>Type</span>
          <span>{bundled ? 'Built-in plugin' : 'Optional plugin'}</span>
        </div>
        <div style={styles.metaRow}>
          <span style={styles.metaLabel}>Status</span>
          <span style={enabled ? styles.statusOn : styles.statusMuted}>
            {enabled ? 'Enabled' : installed ? 'Disabled' : 'Not installed'}
          </span>
        </div>
      </DetailSection>

      <DetailSection title="Settings" icon="settings">
        {hasSettings ? (
          plugin.id === 'browser' ? <BrowserProfiles /> : <ChromeCompanionSettings />
        ) : (
          <div style={styles.settingsEmpty}>
            Install and enable this plugin to configure browser profiles.
          </div>
        )}
      </DetailSection>

      <DetailSection title="Installation">
        <div style={styles.metaRow}>
          <span style={styles.metaLabel}>Skill</span>
          <span style={styles.path}>codey:{plugin.id}</span>
        </div>
        {!bundled && (
          <div style={styles.metaRow}>
            <span style={styles.metaLabel}>{installed ? 'Location' : 'Source'}</span>
            <span style={styles.path}>{installed ? plugin.dir : plugin.sourceUrl}</span>
          </div>
        )}
        {update?.needsUpdate === true && (
          <div style={styles.updateNotice}>A newer published version is available.</div>
        )}
        {last?.installed && last.source === 'bundled' && (
          <div style={styles.warningBox}>
            Codey could not reach the skills repository, so it installed the bundled copy. {last.reason}
          </div>
        )}
        {ask && (
          <div style={styles.warningBox}>
            A skill named “{plugin.id}” already exists at <span style={styles.path}>{ask.dir}</span>,
            and Codey did not write it. {ask.action === 'install' ? 'Replacing' : 'Deleting'} it cannot be undone.
            <div style={styles.confirmActions}>
              <button type="button" onClick={onCancelPending} disabled={working} style={pillButton('ghost')}>Keep mine</button>
              <button type="button" onClick={onConfirmPending} disabled={working} style={pillButton('danger')}>
                {ask.action === 'install' ? 'Replace it' : 'Delete it'}
              </button>
            </div>
          </div>
        )}
        {!bundled && !ask && (
          <div style={styles.manageActions}>
            {installed && update?.needsUpdate === true && (
              <button type="button" onClick={onInstall} disabled={working} style={pillButton('primary')}>Update</button>
            )}
            <button
              type="button"
              onClick={installed ? onUninstall : onInstall}
              disabled={working}
              style={installed ? detailDangerButton : pillButton('primary')}
            >
              {working ? 'Working…' : installed ? 'Uninstall' : 'Install plugin'}
            </button>
          </div>
        )}
        {bundled && (
          <div style={styles.bundledNote}>This plugin ships with Codey. The switch disables its agent access without removing the Chrome extension or changing Chrome.</div>
        )}
      </DetailSection>
    </div>
  )
}

const DetailSection: React.FC<{ title: string; icon?: 'settings'; children: React.ReactNode }> = ({ title, icon, children }) => (
  <section style={styles.section}>
    <div style={styles.sectionTitle}>
      {icon && <UIIcon name={icon} size={14} />}
      {title}
    </div>
    <div style={styles.sectionBody}>{children}</div>
  </section>
)

const detailDangerButton: React.CSSProperties = {
  ...pillButton('danger'), display: 'inline-flex', alignItems: 'center', gap: 6,
  border: `1px solid ${C.dangerBorder}`,
}

const styles: Record<string, React.CSSProperties> = {
  root: { maxWidth: 820, margin: '0 auto' },
  note: { color: C.fg3, fontSize: 12, padding: 8 },
  errorBanner: {
    background: C.dangerBg, color: C.dangerFg, border: `1px solid ${C.dangerBorder}`,
    padding: '9px 11px', borderRadius: 9, marginBottom: 14, fontSize: 12,
  },
  list: { borderTop: '1px solid transparent' },
  row: {
    display: 'flex', alignItems: 'center', gap: 10, minHeight: 66, padding: '8px 8px 8px 12px',
    background: 'transparent',
  },
  rowBorder: { borderTop: `1px solid ${C.border}` },
  rowOpen: {
    display: 'flex', alignItems: 'center', gap: 12, flex: 1, minWidth: 0, padding: 0,
    border: 'none', background: 'transparent', textAlign: 'left', cursor: 'pointer', fontFamily: 'inherit',
  },
  rowIcon: {
    width: 42, height: 42, flexShrink: 0, display: 'grid', placeItems: 'center',
    borderRadius: 10, background: C.surface2, border: `1px solid ${C.border}`,
  },
  rowCopy: { display: 'block', flex: 1, minWidth: 0 },
  rowTitleLine: { display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 },
  rowName: { color: C.fg, fontSize: 13.5, lineHeight: 1.35, fontWeight: 700 },
  rowTagline: {
    display: 'block',
    color: C.fg3, fontSize: 11.5, lineHeight: 1.45, marginTop: 2,
    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
  },
  rowToggle: { flexShrink: 0 },
  rowChevron: {
    width: 26, height: 30, display: 'inline-grid', placeItems: 'center', flexShrink: 0,
    color: C.fg3, opacity: 0.7, border: 'none', background: 'transparent', cursor: 'pointer', padding: 0,
  },
  toggleBusy: { opacity: 0.45, pointerEvents: 'none', flexShrink: 0 },
  updateBadge: {
    padding: '1px 6px', borderRadius: 999, fontSize: 9.5, fontWeight: 700,
    background: C.accentDim, color: C.accent,
  },
  emptySearch: { color: C.fg3, fontSize: 12, textAlign: 'center', padding: '30px 16px' },

  detailRoot: { maxWidth: 820, margin: '0 auto', paddingBottom: 12 },
  backButton: {
    display: 'inline-flex', alignItems: 'center', gap: 4, border: 'none', background: 'transparent',
    color: C.fg2, cursor: 'pointer', padding: '4px 2px', marginBottom: 14, fontSize: 12,
  },
  backGlyph: { display: 'inline-flex', transform: 'rotate(180deg)' },
  hero: { display: 'flex', alignItems: 'center', gap: 13, padding: '2px 2px 18px' },
  heroIcon: {
    width: 56, height: 56, display: 'grid', placeItems: 'center', flexShrink: 0,
    borderRadius: 13, background: C.surface2, border: `1px solid ${C.border}`,
  },
  heroCopy: { flex: 1, minWidth: 0 },
  heroName: { color: C.fg, fontSize: 19, lineHeight: 1.3, fontWeight: 750 },
  heroTagline: { color: C.fg3, fontSize: 12, lineHeight: 1.45, marginTop: 3 },
  section: { borderTop: `1px solid ${C.border}`, padding: '18px 2px 4px' },
  sectionTitle: {
    display: 'flex', alignItems: 'center', gap: 7, color: C.fg, fontSize: 13,
    fontWeight: 720, marginBottom: 11,
  },
  sectionBody: { color: C.fg2, fontSize: 11.5 },
  detailDescription: { color: C.fg2, fontSize: 12, lineHeight: 1.55, marginBottom: 12, maxWidth: 690 },
  metaRow: {
    display: 'flex', alignItems: 'baseline', gap: 14, padding: '6px 0',
    borderTop: `1px solid ${C.border}`, lineHeight: 1.4,
  },
  metaLabel: { width: 72, flexShrink: 0, color: C.fg3 },
  statusOn: { color: C.green, fontWeight: 650 },
  statusMuted: { color: C.fg3, fontWeight: 650 },
  path: {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 10.5,
    color: C.fg3, overflowWrap: 'anywhere',
  },
  settingsEmpty: {
    padding: '14px', borderRadius: 9, border: `1px dashed ${C.border2}`,
    color: C.fg3, background: C.surface,
  },
  updateNotice: { marginTop: 10, color: C.accent, fontWeight: 650 },
  warningBox: {
    marginTop: 10, padding: '10px 11px', borderRadius: 9, color: C.fg2,
    background: C.warningBg, border: `1px solid ${C.warningFg}55`, lineHeight: 1.5,
  },
  confirmActions: { display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 10 },
  manageActions: { display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12 },
  bundledNote: { color: C.fg3, lineHeight: 1.5, marginTop: 8 },
}
