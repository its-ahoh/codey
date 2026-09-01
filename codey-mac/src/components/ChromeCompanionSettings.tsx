import React, { useEffect, useState } from 'react'
import type { ChromeCompanionStatus, ChromeSessionSite } from '../codey-api'
import { C } from '../theme'

const EMPTY: ChromeCompanionStatus = {
  endpoint: null,
  paired: false,
  connected: false,
  clientName: null,
  pairedAt: null,
  lastSeenAt: null,
  clientVersion: null,
  expectedVersion: null,
  updateAvailable: false,
}

export function shouldShowChromeInstallInstructions(
  status: Pick<ChromeCompanionStatus, 'paired'>,
): boolean {
  return !status.paired
}

export const ChromeCompanionSettings: React.FC<{ compact?: boolean }> = ({ compact = false }) => {
  const [status, setStatus] = useState(EMPTY)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [profileName, setProfileName] = useState('chrome-session')
  const [exported, setExported] = useState<string | null>(null)
  const [installedPath, setInstalledPath] = useState<string | null>(null)
  const [sites, setSites] = useState<ChromeSessionSite[] | null>(null)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [siteFilter, setSiteFilter] = useState('')
  const [bulkName, setBulkName] = useState('chrome-logins')
  const [bulkResult, setBulkResult] = useState<{ name: string; cookieCount: number; siteCount: number } | null>(null)

  const useResult = <T,>(result: { ok: true; data: T } | { ok: false; error: string }): T | null => {
    if (!result.ok) { setError(result.error); return null }
    setError(null)
    return result.data
  }

  useEffect(() => {
    let cancelled = false
    const off = window.codey.chromeCompanion.onStatus(next => { if (!cancelled) setStatus(next) })
    void window.codey.chromeCompanion.status().then(result => {
      if (cancelled) return
      const next = useResult(result)
      if (next) setStatus(next)
    })
    return () => { cancelled = true; off() }
  }, [])

  const run = async (operation: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    try { await operation() }
    catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)) }
    finally { setBusy(false) }
  }

  return (
    <div style={styles.root}>
      {error && <div style={styles.error}>{error}</div>}
      {status.paired && !status.connected && (
        <div style={styles.noticeRow}>
          <span style={{ ...styles.dot, background: C.warningFg }} />
          <span style={styles.noticeCopy}>Chrome is temporarily unavailable. Open Chrome or reload the extension.</span>
          <button style={styles.secondary} disabled={busy} onClick={() => void run(async () => {
            const next = useResult(await window.codey.chromeCompanion.status())
            if (next) setStatus(next)
          })}>Check again</button>
        </div>
      )}

      {status.updateAvailable && (
        <div style={styles.noticeRow}>
          <span style={{ ...styles.dot, background: C.warningFg }} />
          <span style={styles.noticeCopy}>
            Codey installed extension {status.expectedVersion}, but Chrome is still running {status.clientVersion}.
            Chrome only picks up a new build when it restarts or you reload the extension.
          </span>
          <button style={styles.secondary} disabled={busy} onClick={() => void run(async () => {
            useResult(await window.codey.chromeCompanion.openExtensionsPage())
          })}>Open extensions</button>
        </div>
      )}

      {shouldShowChromeInstallInstructions(status) && (
        <div style={styles.card}>
          <div style={styles.title}>Install the Chrome extension</div>
          <div style={styles.copy}>Installation is one-time, and there is nothing to configure afterwards — the extension finds Codey and pairs itself within about 30 seconds, as long as Codey stays running. Clicking the Codey avatar in Chrome then opens its chat Side Panel.</div>
          <ol style={styles.steps}>
            <li>Pick a folder to install into. Codey copies the extension there and keeps it up to date with each Codey release.</li>
            <li>Open Chrome’s <code style={styles.code}>chrome://extensions</code> page and turn on <strong>Developer mode</strong>. (Chrome blocks links to its own pages, so it has to be opened by the button.)</li>
            <li>Click <strong>Load unpacked</strong> and choose the folder from step 1. Its path is already on the clipboard — press <strong>⌘⇧G</strong> and paste, or drag the revealed folder onto the extensions page.</li>
          </ol>
          <div style={{ ...styles.actions, ...(compact ? styles.stack : null) }}>
            <button style={styles.primary} disabled={busy} onClick={() => void run(async () => {
              const result = useResult(await window.codey.chromeCompanion.installExtensionTo())
              if (result?.installed) setInstalledPath(result.dir)
            })}>Choose folder &amp; install</button>
            <button style={styles.secondary} disabled={busy} onClick={() => void run(async () => {
              useResult(await window.codey.chromeCompanion.openExtensionsPage())
            })}>Open chrome://extensions</button>
            <button style={styles.secondary} disabled={busy} onClick={() => void run(async () => {
              const path = useResult(await window.codey.chromeCompanion.showExtensionFolder())
              if (path) setInstalledPath(path)
            })}>Reveal folder &amp; copy path</button>
          </div>
          {installedPath && (
            <div style={styles.success}>Installed, and the path is on the clipboard. Select this folder in Chrome’s <strong>Load unpacked</strong> picker: <code style={styles.code}>{installedPath}</code></div>
          )}
        </div>
      )}

      {status.connected && (
        <div style={styles.card}>
          <div>
            <div style={styles.title}>Create a Codey Browser profile</div>
            <div style={styles.copy}>Use the login from Chrome’s currently active site inside the separate Codey Browser.</div>
          </div>
          <div style={styles.impact}>
            <strong>This creates a new named profile and activates it immediately.</strong>
            <span>It copies only that site’s cookies and localStorage. Codey Browser switches its live session to the new profile; your other saved profiles remain available. Nothing in Chrome is changed.</span>
          </div>
          <div style={{ ...styles.navigate, ...(compact ? styles.stack : null) }}>
            <label style={styles.inputLabel}>
              New profile name
              <input
                style={styles.input}
                value={profileName}
                onChange={event => { setProfileName(event.target.value); setExported(null) }}
                placeholder="chrome-session"
                aria-label="New Codey Browser profile name"
                spellCheck={false}
              />
            </label>
            <button style={styles.primary} disabled={busy || !status.connected || !profileName.trim()} onClick={() => void run(async () => {
              const next = useResult(await window.codey.chromeCompanion.exportSession(profileName.trim()))
              if (next) setExported(next.profile.name)
            })}>Create &amp; activate profile</button>
          </div>
          {exported && (
            <div style={styles.success}>“{exported}” is now the active Codey Browser profile. Chrome was not changed.</div>
          )}
          {/* Keeping a profile up to date belongs with the profile, not here:
              refreshing is one button per profile in the Codey Browser. This
              page only creates them. */}
          <div style={styles.copy}>
            Already have a profile for this login? Refresh it from the Codey Browser — every profile has its own refresh button.
          </div>
        </div>
      )}

      {/* Copying one site at a time is fine for one login and tedious for a
          working set. The alternative is not "copy everything" - that would put
          banking and mail into a file on disk to save a few clicks - so the
          sites are listed and the user ticks what Codey may have. */}
      {status.connected && (
        <div style={styles.card}>
          <div>
            <div style={styles.title}>Pick which Chrome logins to copy</div>
            <div style={styles.copy}>List every site this Chrome profile is signed in to, then choose the ones the Codey Browser may use.</div>
          </div>
          {!sites && (
            <div style={styles.actions}>
              <button style={styles.secondary} disabled={busy} onClick={() => void run(async () => {
                const next = useResult(await window.codey.chromeCompanion.listSessionSites())
                if (next) {
                  setSites(next.sites)
                  setPicked(new Set())
                  setBulkResult(null)
                }
              })}>List Chrome’s signed-in sites</button>
              <span style={styles.copy}>Nothing is copied until you pick sites and confirm.</span>
            </div>
          )}
          {sites && (
            <>
              <div style={styles.impact}>
                <strong>Cookies are copied for every site you tick.</strong>
                <span>Site storage (localStorage) can only be read from a page that is open in Chrome right now, so a site with no open tab is copied by its cookies alone — enough for most logins, but not all. Nothing in Chrome is changed.</span>
              </div>
              <input
                style={styles.input}
                value={siteFilter}
                onChange={event => setSiteFilter(event.target.value)}
                placeholder="Filter sites"
                aria-label="Filter Chrome sites"
                spellCheck={false}
              />
              <div style={styles.siteList}>
                {sites.length === 0 && <div style={styles.copy}>Chrome has no cookies to copy.</div>}
                {sites
                  .filter(entry => entry.site.includes(siteFilter.trim().toLowerCase()))
                  .map(entry => (
                    <label key={entry.site} style={styles.siteRow}>
                      <input
                        type="checkbox"
                        checked={picked.has(entry.site)}
                        onChange={event => setPicked(current => {
                          const next = new Set(current)
                          if (event.target.checked) next.add(entry.site)
                          else next.delete(entry.site)
                          return next
                        })}
                      />
                      <span style={styles.siteName}>{entry.site}</span>
                      <span style={styles.siteMeta}>
                        {entry.cookieCount} cookie{entry.cookieCount === 1 ? '' : 's'}
                        {entry.openTabs > 0 ? ' · open' : ''}
                      </span>
                    </label>
                  ))}
              </div>
              <div style={{ ...styles.navigate, ...(compact ? styles.stack : null) }}>
                <label style={styles.inputLabel}>
                  New profile name
                  <input
                    style={styles.input}
                    value={bulkName}
                    onChange={event => { setBulkName(event.target.value); setBulkResult(null) }}
                    placeholder="chrome-logins"
                    aria-label="New Codey Browser profile name for the picked sites"
                    spellCheck={false}
                  />
                </label>
                <button style={styles.primary} disabled={busy || picked.size === 0 || !bulkName.trim()} onClick={() => void run(async () => {
                  const next = useResult(await window.codey.chromeCompanion.importSites(bulkName.trim(), [...picked]))
                  if (next?.imported && next.profile) {
                    setBulkResult({ name: next.profile.name, cookieCount: next.cookieCount, siteCount: next.sites.length })
                    setSites(null)
                    setPicked(new Set())
                  }
                })}>Copy {picked.size || ''} site{picked.size === 1 ? '' : 's'} into a profile</button>
              </div>
            </>
          )}
          {bulkResult && (
            <div style={styles.success}>
              “{bulkResult.name}” is now the active Codey Browser profile, carrying {bulkResult.cookieCount} cookies from {bulkResult.siteCount} site{bulkResult.siteCount === 1 ? '' : 's'}. Chrome was not changed.
            </div>
          )}
        </div>
      )}

    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  root: { display: 'flex', flexDirection: 'column', gap: 10 },
  card: { display: 'flex', flexDirection: 'column', gap: 9, padding: 12, borderRadius: 10, background: C.surface, border: `1px solid ${C.border}` },
  dot: { width: 8, height: 8, flexShrink: 0, borderRadius: '50%' },
  title: { color: C.fg, fontSize: 12.5, fontWeight: 750 },
  copy: { color: C.fg3, fontSize: 10.5, lineHeight: 1.45, marginTop: 3 },
  steps: { margin: 0, paddingLeft: 20, color: C.fg2, fontSize: 10.5, lineHeight: 1.7 },
  code: { padding: '1px 5px', borderRadius: 4, background: C.surface2, color: C.fg, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 10 },
  impact: { display: 'flex', flexDirection: 'column', gap: 3, padding: '9px 10px', borderRadius: 8, background: C.surface2, color: C.fg2, fontSize: 10.5, lineHeight: 1.45 },
  actions: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8 },
  stack: { alignItems: 'stretch', flexDirection: 'column' },
  primary: { minHeight: 38, padding: '0 14px', border: `1px solid ${C.accent}`, borderRadius: 8, background: C.accent, color: C.onAccent, cursor: 'pointer', fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap' },
  secondary: { minHeight: 31, padding: '0 11px', border: `1px solid ${C.border2}`, borderRadius: 7, background: C.surface2, color: C.fg2, cursor: 'pointer', fontSize: 10.5 },
  error: { padding: '9px 11px', borderRadius: 8, color: C.red, background: `${C.red}18`, border: `1px solid ${C.red}55`, fontSize: 11 },
  success: { padding: '9px 11px', borderRadius: 8, color: C.green, background: `${C.green}18`, border: `1px solid ${C.green}55`, fontSize: 11 },
  noticeRow: { display: 'flex', alignItems: 'center', gap: 9, padding: '8px 10px', borderRadius: 8, background: C.surface, border: `1px solid ${C.border}` },
  noticeCopy: { flex: 1, minWidth: 0, color: C.fg3, fontSize: 10.5 },
  navigate: { display: 'flex', alignItems: 'flex-end', gap: 8 },
  siteList: { display: 'flex', flexDirection: 'column', gap: 1, maxHeight: 220, overflowY: 'auto', padding: 4, borderRadius: 8, border: `1px solid ${C.border}`, background: C.surface2 },
  siteRow: { display: 'flex', alignItems: 'center', gap: 8, padding: '4px 6px', borderRadius: 6, color: C.fg2, fontSize: 11, cursor: 'pointer' },
  siteName: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  siteMeta: { flexShrink: 0, color: C.fg3, fontSize: 10 },
  inputLabel: { display: 'flex', flex: 1, minWidth: 0, flexDirection: 'column', gap: 4, color: C.fg2, fontSize: 10 },
  input: { flexShrink: 0, width: '100%', minWidth: 0, height: 38, boxSizing: 'border-box', padding: '0 12px', borderRadius: 8, border: `1px solid ${C.border2}`, background: C.surface2, color: C.fg, outline: 'none', fontSize: 12.5 },
}
