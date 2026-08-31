import React, { useEffect, useState } from 'react'
import type { ChromeCompanionStatus } from '../codey-api'
import { C } from '../theme'

const EMPTY: ChromeCompanionStatus = {
  endpoint: null,
  paired: false,
  connected: false,
  clientName: null,
  pairedAt: null,
  lastSeenAt: null,
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
  const [copiedPath, setCopiedPath] = useState<string | null>(null)

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

      {shouldShowChromeInstallInstructions(status) && (
        <div style={styles.card}>
          <div style={styles.title}>Install the Chrome extension</div>
          <div style={styles.copy}>Installation is one-time, and there is nothing to configure afterwards — the extension finds Codey and pairs itself within about 30 seconds, as long as Codey stays running. Clicking the Codey avatar in Chrome then opens its chat Side Panel.</div>
          <ol style={styles.steps}>
            <li>Open Chrome’s <code style={styles.code}>chrome://extensions</code> page with the button below. (Chrome blocks links to its own pages, so it has to be opened this way.)</li>
            <li>Turn on <strong>Developer mode</strong>, then click <strong>Load unpacked</strong>.</li>
            <li>Click the second button below: it reveals the folder in Finder and copies its path. In Chrome’s picker, press <strong>⌘⇧G</strong>, paste, and press Return — or just drag the revealed folder onto the extensions page.</li>
          </ol>
          <div style={{ ...styles.actions, ...(compact ? styles.stack : null) }}>
            <button style={styles.primary} disabled={busy} onClick={() => void run(async () => {
              useResult(await window.codey.chromeCompanion.openExtensionsPage())
            })}>Open chrome://extensions</button>
            <button style={styles.secondary} disabled={busy} onClick={() => void run(async () => {
              const path = useResult(await window.codey.chromeCompanion.showExtensionFolder())
              if (path) setCopiedPath(path)
            })}>Reveal folder &amp; copy path</button>
          </div>
          {copiedPath && (
            <div style={styles.success}>Path copied. Paste it into Chrome’s picker with ⌘⇧G: <code style={styles.code}>{copiedPath}</code></div>
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
              if (next) {
                setExported(next.profile.name)
              }
            })}>Create &amp; activate profile</button>
          </div>
          {exported && (
            <div style={styles.success}>“{exported}” is now the active Codey Browser profile. Chrome was not changed.</div>
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
  inputLabel: { display: 'flex', flex: 1, minWidth: 0, flexDirection: 'column', gap: 4, color: C.fg2, fontSize: 10 },
  input: { flexShrink: 0, width: '100%', minWidth: 0, height: 38, boxSizing: 'border-box', padding: '0 12px', borderRadius: 8, border: `1px solid ${C.border2}`, background: C.surface2, color: C.fg, outline: 'none', fontSize: 12.5 },
}
