import React, { useCallback, useEffect, useState } from 'react'
import { C } from '../theme'
import { UIIcon } from './UIIcons'
import type { BrowserProfileSiteSummary, BrowserProfileSummary, ChromeClientInfo } from '../codey-api'
import { BROWSER_PROFILE_AVATARS, browserProfileAvatar } from './browserProfileAvatars'
import { Toggle } from './settingsAtoms'

type BrowserProfileContents = {
  name: string
  updatedAt: number
  sourceUrl: string | null
  sites: BrowserProfileSiteSummary[]
}

type IpcLike = { ok: boolean; error?: string }

function formatWhen(timestamp: number): string {
  if (!timestamp) return ''
  const minutes = Math.max(1, Math.round((Date.now() - timestamp) / 60000))
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  return `${days}d ago`
}

/** The browser-profiles manager, shared by the browser toolbar (compact) and
 *  the Settings tab (full width). List, save the current session, import a
 *  session file, pick which profile is active, and delete profiles through the
 *  main process's `window.codey.browser.profiles` bridge. */
export const BrowserProfiles: React.FC<{ compact?: boolean }> = ({ compact = false }) => {
  // Derived from the list itself, so it cannot disagree with the rows shown.
  const [profiles, setProfiles] = useState<BrowserProfileSummary[]>([])
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [contents, setContents] = useState<Record<string, BrowserProfileContents>>({})
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  // True once the user tried to save with an empty name. Greying the button
  // out hid what was missing, so say it and mark the field instead.
  const [nameMissing, setNameMissing] = useState(false)
  const [avatarPicker, setAvatarPicker] = useState<string | null>(null)
  const [chromeClients, setChromeClients] = useState<ChromeClientInfo[]>([])
  const [bindingPicker, setBindingPicker] = useState<string | null>(null)

  const refreshChromeClients = useCallback(async () => {
    if (!window.codey?.chromeCompanion?.clients) return
    const result = await window.codey.chromeCompanion.clients()
    if (result.ok) setChromeClients(result.data)
  }, [])

  const refresh = useCallback(async () => {
    // A stale preload (app not restarted since the profiles bridge was added)
    // would otherwise fail silently — surface it instead.
    if (!window.codey?.browser?.profiles) {
      setError('Browser profiles are unavailable — quit and relaunch Codey to load the latest build')
      return
    }
    try {
      const result = await window.codey.browser.profiles.list()
      if (result.ok) {
        setProfiles(result.data.profiles)
        setError(null)
      } else {
        setError(result.error)
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])
  useEffect(() => { void refreshChromeClients() }, [refreshChromeClients])

  const run = async (action: () => Promise<IpcLike>) => {
    setBusy(true)
    setError(null)
    try {
      const result = await action()
      if (!result.ok) setError(result.error ?? 'Something went wrong')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
      setContents({})
      if (expanded) void toggleContentsAgain(expanded)
      void refresh()
      void refreshChromeClients()
    }
  }

  // Read on demand rather than with the list: a profile's contents are only
  // interesting when someone asks, and the list is refreshed constantly.
  const toggleContents = async (name: string) => {
    if (expanded === name) {
      setExpanded(null)
      return
    }
    setExpanded(name)
    const result = await window.codey.browser.profiles.contents(name)
    if (result.ok) setContents(current => ({ ...current, [name]: result.data }))
    else setError(result.error)
  }

  // Re-read after a change, without the toggle's open/close behaviour.
  const toggleContentsAgain = async (name: string) => {
    const result = await window.codey.browser.profiles.contents(name)
    if (result.ok) setContents(current => ({ ...current, [name]: result.data }))
  }

  const saveCurrent = () => {
    const trimmed = name.trim()
    if (!trimmed) {
      setNameMissing(true)
      setError('Give the profile a name first — type one in the field on the left.')
      return
    }
    setNameMissing(false)
    setName('')
    void run(() => window.codey.browser.profiles.save(trimmed))
  }

  const importFile = () => {
    void run(() => window.codey.browser.profiles.import())
  }

  const meta = (profile: BrowserProfileSummary): string => {
    const bits: string[] = []
    if (profile.cookieCount > 0) bits.push(`${profile.cookieCount} cookie${profile.cookieCount === 1 ? '' : 's'}`)
    if (profile.originCount > 0) bits.push(`${profile.originCount} site${profile.originCount === 1 ? '' : 's'}`)
    const when = formatWhen(profile.updatedAt)
    if (when) bits.push(`updated ${when}`)
    if (profile.autoSync) bits.push('syncs with Chrome')
    if (profile.active) bits.push('active')
    return bits.join(' · ')
  }

  const title = (profile: BrowserProfileSummary): string => {
    const parts = [`Profile ${profile.name}`]
    if (profile.sourceUrl) parts.push(`saved from ${profile.sourceUrl}`)
    const detail = meta(profile)
    if (detail) parts.push(detail)
    return parts.join(' — ')
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: compact ? 6 : 10 }}>
      {error && (
        <div style={{
          background: C.red + '22', color: C.red, padding: '8px 10px', borderRadius: 8, fontSize: compact ? 11 : 12,
        }}>{error}</div>
      )}

      <div style={compact ? styles.compactComposer : styles.composer}>
        <input
          value={name}
          onChange={event => { setName(event.target.value); if (nameMissing) { setNameMissing(false); setError(null) } }}
          onKeyDown={event => { if (event.key === 'Enter') saveCurrent() }}
          placeholder="Profile name"
          aria-label="New profile name"
          spellCheck={false}
          style={{
            flex: '1 1 260px', minWidth: 0, background: C.surface2,
            border: `1px solid ${nameMissing ? C.red : C.border2}`, color: C.fg,
            borderRadius: 8, padding: '7px 10px', fontSize: compact ? 12 : 13, outline: 'none',
          }}
        />
        <button
          type="button"
          disabled={busy}
          onClick={saveCurrent}
          style={buttonStyle(compact)}
          title="Snapshot the current session into a profile"
        >
          <UIIcon name="add" size={13} /> {compact ? 'Save' : 'Save current session'}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={importFile}
          style={buttonStyle(compact)}
          title="Import a profile or Playwright storageState JSON and activate it"
        >
          <UIIcon name="folder-open" size={13} /> {compact ? 'Import' : 'Import…'}
        </button>
      </div>

      {profiles.length === 0 && !busy && (
        <div style={compact ? styles.compactEmpty : styles.empty}>
          {!compact && <div style={styles.emptyIcon}><UIIcon name="users" size={16} /></div>}
          <span>No profiles yet — save this session or import a session file to get started.</span>
        </div>
      )}

      {profiles.length > 0 && (
        <button
          type="button"
          role="radio"
          aria-checked={!profiles.some(profile => profile.active)}
          disabled={busy}
          onClick={() => void run(() => window.codey.browser.profiles.setDefault(null))}
          style={{
            ...styles.defaultChoice,
            ...(!profiles.some(profile => profile.active) ? styles.defaultChoiceActive : null),
          }}
          title="Browse without a saved profile"
        >
          <span aria-hidden="true">{profiles.some(profile => profile.active) ? '○' : '●'}</span>
          No profile
        </button>
      )}

      {profiles.map(profile => (
        <div key={profile.name} style={{
          display: 'flex', flexDirection: 'column', gap: 8,
          background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, padding: compact ? '10px' : '9px 11px',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', flexWrap: compact ? 'wrap' : 'nowrap', gap: 8 }}>
            <div style={styles.avatarControl}>
              <button
                type="button"
                disabled={busy}
                onClick={() => setAvatarPicker(current => current === profile.name ? null : profile.name)}
                style={{ ...styles.avatarButton, ...(profile.active ? styles.avatarButtonActive : null) }}
                title={`Choose an avatar for ${profile.name}`}
                aria-label={`Choose an avatar for ${profile.name}`}
                aria-expanded={avatarPicker === profile.name}
              >{browserProfileAvatar(profile)}</button>
              {avatarPicker === profile.name && (
                <div style={styles.avatarPicker} role="menu" aria-label={`Avatars for ${profile.name}`}>
                  {BROWSER_PROFILE_AVATARS.map(avatar => (
                    <button
                      key={avatar}
                      type="button"
                      role="menuitemradio"
                      aria-checked={profile.avatar === avatar}
                      style={{ ...styles.avatarOption, ...(browserProfileAvatar(profile) === avatar ? styles.avatarOptionActive : null) }}
                      onClick={() => {
                        setAvatarPicker(null)
                        void run(() => window.codey.browser.profiles.setAvatar(profile.name, avatar))
                      }}
                    >{avatar}</button>
                  ))}
                </div>
              )}
            </div>
            <div style={{ flex: 1, minWidth: compact ? 180 : 0 }}>
              {/* No "IN USE" pill next to the name: the radio on this same row
                  already says "Active", so the pill was the same word twice
                  with nothing extra to tell. */}
              <div style={{ color: C.fg, fontSize: compact ? 12 : 13, fontWeight: 600 }}>{profile.name}</div>
              <button
                type="button"
                onClick={() => void toggleContents(profile.name)}
                aria-expanded={expanded === profile.name}
                style={{
                  display: 'flex', alignItems: 'center', gap: 4, padding: 0, border: 'none', background: 'none',
                  color: C.fg3, fontSize: compact ? 10 : 11, cursor: 'pointer', textAlign: 'left',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}
                title={`${title(profile)} — click to see which sites it holds`}
              >
                <span style={{ transform: expanded === profile.name ? 'rotate(90deg)' : 'none', display: 'inline-flex' }}>
                  <UIIcon name="disclosure" size={9} />
                </span>
                {meta(profile) || (profile.sourceUrl ? 'saved session' : 'empty profile')}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => setBindingPicker(current => current === profile.name ? null : profile.name)}
                aria-expanded={bindingPicker === profile.name}
                style={styles.bindingLink}
                title="Choose which Chrome profile this Codey profile mirrors"
              >
                <UIIcon name="link" size={9} />
                {profile.chromeProfileId
                  ? `Chrome: ${profile.chromeProfileLabel ?? 'Chrome profile'}`
                  : 'Not linked to Chrome'}
              </button>
            </div>
            <button
              type="button"
              role="radio"
              aria-checked={profile.active}
              disabled={busy}
              onClick={() => void run(() => window.codey.browser.profiles.setDefault(profile.name))}
              style={{ ...styles.defaultChoice, ...(profile.active ? styles.defaultChoiceActive : null) }}
              title={`Browse as ${profile.name}`}
            >
              <span aria-hidden="true">{profile.active ? '●' : '○'}</span>
              {profile.active ? 'Active' : 'Activate'}
            </button>
            {confirmDelete === profile.name ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => { setConfirmDelete(null); void run(() => window.codey.browser.profiles.delete(profile.name)) }}
                style={{ ...buttonStyle(compact), background: C.red, borderColor: C.red, color: '#fff' }}
                title="Click again to confirm"
              >Confirm</button>
            ) : (
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setConfirmDelete(profile.name)
                  setTimeout(() => setConfirmDelete(current => current === profile.name ? null : current), 3000)
                }}
                style={buttonStyle(compact)}
                title="Delete this profile"
              ><UIIcon name="trash" size={12} /></button>
            )}
          </div>

          {bindingPicker === profile.name && (
            <div style={styles.bindingPicker} role="menu" aria-label={`Chrome profile for ${profile.name}`}>
              <button
                type="button"
                role="menuitemradio"
                aria-checked={!profile.chromeProfileId}
                disabled={busy}
                style={{ ...styles.bindingOption, ...(!profile.chromeProfileId ? styles.bindingOptionActive : null) }}
                onClick={() => {
                  setBindingPicker(null)
                  void run(() => window.codey.browser.profiles.setChromeBinding(profile.name, null))
                }}
              >
                <span style={styles.bindingOptionName}>None</span>
                <span aria-hidden="true">{!profile.chromeProfileId ? '✓' : ''}</span>
              </button>
              {chromeClients.filter(client => client.profileId).map(client => {
                const owner = profiles.find(profile => profile.chromeProfileId === client.profileId)
                const moved = !!owner && owner.name !== profile.name
                return (
                  <button
                    key={client.profileId}
                    type="button"
                    role="menuitemradio"
                    aria-checked={profile.chromeProfileId === client.profileId}
                    disabled={busy}
                    style={{ ...styles.bindingOption, ...(profile.chromeProfileId === client.profileId ? styles.bindingOptionActive : null) }}
                    title={moved ? `Now linked to "${owner!.name}" — picking this moves it here` : undefined}
                    onClick={() => {
                      setBindingPicker(null)
                      void run(() => window.codey.browser.profiles.setChromeBinding(profile.name, client.profileId))
                    }}
                  >
                    <span style={styles.bindingOptionName}>
                      {client.label}
                      {client.connected ? '' : ' · offline'}
                    </span>
                    {moved && <span style={styles.bindingOptionNote}>from {owner!.name}</span>}
                    <span aria-hidden="true">{profile.chromeProfileId === client.profileId ? '✓' : ''}</span>
                  </button>
                )
              })}
              {chromeClients.filter(client => client.profileId).length === 0 && (
                <div style={styles.bindingEmpty}>No Chrome profiles paired yet — install the Codey extension in Chrome and it appears here.</div>
              )}
            </div>
          )}

          {/* What this profile actually holds. Worth being able to look at
              before trusting it with a task - and before handing it to an
              agent - without ever putting the values on screen. */}
          {expanded === profile.name && (
            <div style={styles.syncBox}>
              <label style={styles.exclusionLabel}>
                <span>Never sync these sites (comma-separated)</span>
                <input
                  key={`${profile.name}:${profile.excludedSites.join(',')}`}
                  defaultValue={profile.excludedSites.join(', ')}
                  disabled={busy}
                  placeholder="bank.example, private.example"
                  aria-label={`Sites excluded from Chrome sync for ${profile.name}`}
                  onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur() }}
                  onBlur={event => {
                    const sites = event.currentTarget.value.split(',').map(site => site.trim()).filter(Boolean)
                    if (JSON.stringify(sites.map(site => site.replace(/^\.+/, '').toLowerCase())) === JSON.stringify(profile.excludedSites)) return
                    void run(() => window.codey.browser.profiles.setExcludedSites(profile.name, sites))
                  }}
                  style={styles.exclusionInput}
                />
              </label>
              <div style={styles.syncRow}>
                <span style={styles.syncCopy}>
                  Mirror Chrome automatically — new sites, cookie changes, and localStorage from open Chrome tabs flow into this profile.
                </span>
                <Toggle
                  on={profile.autoSync}
                  disabled={busy}
                  onChange={next => void run(() => window.codey.browser.profiles.setAutoSync(profile.name, next))}
                  label={`Keep ${profile.name} in sync with Chrome`}
                />
              </div>
            </div>
          )}
          {expanded === profile.name && (
            <div style={styles.contents}>
              {!contents[profile.name] && <div style={styles.contentsEmpty}>Reading…</div>}
              {contents[profile.name]?.sites.length === 0 && (
                <div style={styles.contentsEmpty}>This profile holds no cookies or site storage.</div>
              )}
              {contents[profile.name]?.sites.map(site => (
                <div key={site.domain} style={styles.contentsRow}>
                  <span style={styles.contentsDomain} title={site.domain}>{site.domain}</span>
                  <span style={styles.contentsMeta} title={site.cookieNames.join(', ')}>
                    {site.cookieCount} cookie{site.cookieCount === 1 ? '' : 's'}
                    {site.storage.length > 0 && ` · ${site.storage.reduce((total, entry) => total + entry.keys, 0)} storage keys`}
                  </span>
                </div>
              ))}
              {contents[profile.name] && (
                <div style={styles.contentsNote}>Cookie names are shown on hover. Their values stay in Codey and are never displayed.</div>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

function buttonStyle(compact: boolean): React.CSSProperties {
  return {
    display: 'inline-flex', alignItems: 'center', gap: 5, whiteSpace: 'nowrap',
    background: C.surface, border: `1px solid ${C.border}`, color: C.fg,
    borderRadius: 8, padding: compact ? '4px 8px' : '7px 12px',
    fontSize: compact ? 11 : 12, cursor: 'pointer',
  }
}

const styles: Record<string, React.CSSProperties> = {
  defaultChoice: { display: 'inline-flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap', padding: '5px 8px', borderRadius: 8, border: `1px solid ${C.border}`, background: C.surface, color: C.fg2, cursor: 'pointer', fontSize: 11 },
  defaultChoiceActive: { borderColor: C.accent, background: C.accentDim, color: C.accent },
  syncBox: { display: 'flex', flexDirection: 'column', gap: 8, padding: '7px 8px', borderRadius: 8, background: C.surface2, border: `1px solid ${C.border}` },
  syncRow: { display: 'flex', alignItems: 'center', gap: 10 },
  syncCopy: { flex: 1, minWidth: 0, color: C.fg2, fontSize: 11, lineHeight: 1.45 },
  exclusionLabel: { display: 'flex', flexDirection: 'column', gap: 5, color: C.fg3, fontSize: 10 },
  exclusionInput: { width: '100%', boxSizing: 'border-box', border: `1px solid ${C.border2}`, borderRadius: 7, background: C.surface, color: C.fg, padding: '6px 8px', fontSize: 11, outline: 'none' },
  contents: { display: 'flex', flexDirection: 'column', gap: 1, maxHeight: 200, overflowY: 'auto', padding: '5px 6px', borderRadius: 8, background: C.surface2, border: `1px solid ${C.border}` },
  contentsRow: { display: 'flex', alignItems: 'baseline', gap: 8, padding: '2px 4px' },
  contentsDomain: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: C.fg2, fontSize: 11 },
  contentsMeta: { flexShrink: 0, color: C.fg3, fontSize: 10 },
  contentsEmpty: { color: C.fg3, fontSize: 11, padding: '4px 4px' },
  contentsNote: { marginTop: 4, paddingTop: 5, borderTop: `1px solid ${C.border}`, color: C.fg3, fontSize: 10, lineHeight: 1.4 },
  bindingLink: { display: 'inline-flex', alignItems: 'center', gap: 4, padding: 0, border: 'none', background: 'none', color: C.fg3, fontSize: 10, cursor: 'pointer', textAlign: 'left' },
  bindingPicker: { display: 'flex', flexDirection: 'column', gap: 2, padding: 6, borderRadius: 8, background: C.surface2, border: `1px solid ${C.border}` },
  bindingOption: { display: 'flex', alignItems: 'center', gap: 8, padding: '5px 7px', border: 'none', borderRadius: 6, background: 'transparent', color: C.fg2, cursor: 'pointer', fontSize: 11, textAlign: 'left' },
  bindingOptionActive: { background: C.accentDim, color: C.accent },
  bindingOptionName: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  bindingOptionNote: { flexShrink: 0, color: C.fg3, fontSize: 10 },
  bindingEmpty: { padding: '5px 7px', color: C.fg3, fontSize: 10.5, lineHeight: 1.4 },
  avatarControl: { position: 'relative', flexShrink: 0 },
  avatarButton: { width: 34, height: 34, display: 'grid', placeItems: 'center', padding: 0, borderRadius: 10, border: `1px solid ${C.border}`, background: C.surface2, cursor: 'pointer', fontSize: 18 },
  avatarButtonActive: { borderColor: C.green, background: `${C.green}14` },
  avatarPicker: { position: 'absolute', top: 39, left: 0, zIndex: 4, width: 224, display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 4, padding: 6, borderRadius: 10, border: `1px solid ${C.border2}`, background: C.surface2, boxShadow: '0 10px 24px rgba(0,0,0,0.28)' },
  avatarOption: { width: 32, height: 32, padding: 0, borderRadius: 8, border: '1px solid transparent', background: 'transparent', cursor: 'pointer', fontSize: 18 },
  avatarOptionActive: { borderColor: C.accent, background: C.accentDim },
  composer: {
    display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8,
    padding: 12, borderRadius: 11, background: C.surface, border: `1px solid ${C.border}`,
  },
  compactComposer: {
    display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8,
    padding: 10, borderRadius: 10, background: C.surface, border: `1px solid ${C.border}`,
  },
  empty: {
    display: 'flex', alignItems: 'center', gap: 10, color: C.fg3, fontSize: 12,
    padding: '18px 16px', borderRadius: 11, background: C.surface, border: `1px dashed ${C.border2}`,
  },
  compactEmpty: { color: C.fg3, fontSize: 11, lineHeight: 1.5, padding: '15px', borderRadius: 10, background: C.surface, border: `1px dashed ${C.border2}` },
  emptyIcon: {
    width: 28, height: 28, display: 'grid', placeItems: 'center', flexShrink: 0,
    borderRadius: 8, background: C.surface2, color: C.fg3,
  },
}
