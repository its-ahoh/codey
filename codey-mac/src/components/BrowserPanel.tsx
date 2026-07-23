import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type {
  BrowserBounds,
  BrowserControlPermissionState,
  BrowserSitePermission,
  BrowserSitePermissionState,
  BrowserDownload,
  BrowserExtensionCandidate,
  BrowserExtensionEntry,
  BrowserLoginWaitEvent,
  ChromeBrowserExtensionCandidate,
  BrowserState,
  BrowserTab,
} from '../codey-api'
import { C } from '../theme'
import { UIIcon } from './UIIcons'
import { getDraft, setDraft } from './chatDrafts'
import { buildBrowserContextPrompt } from './browserContextPrompt'

interface Props {
  chatId?: string
  embedded?: boolean
  loginWait?: BrowserLoginWaitEvent | null
  onConfirmLoginWait?: (event: BrowserLoginWaitEvent) => void
  onDismissLoginWait?: () => void
  onClose: () => void
}

const EMPTY_STATE: BrowserState = {
  url: '',
  title: 'New tab',
  loading: false,
  canGoBack: false,
  canGoForward: false,
  error: null,
}

const VIEW_ONLY: BrowserControlPermissionState = { approved: false, pending: null }
const NO_SITE_PERMISSION: BrowserSitePermissionState = { pending: null, savedSiteCount: 0 }

const SITE_PERMISSION_LABELS: Record<BrowserSitePermission, string> = {
  camera: 'camera',
  microphone: 'microphone',
  geolocation: 'location',
  notifications: 'notifications',
}

function rectToBounds(rect: DOMRect): BrowserBounds {
  return {
    x: Math.round(rect.left),
    y: Math.round(rect.top),
    width: Math.max(0, Math.round(rect.width)),
    height: Math.max(0, Math.round(rect.height)),
  }
}

export const BrowserPanel: React.FC<Props> = ({
  chatId,
  loginWait,
  onConfirmLoginWait,
  onDismissLoginWait,
  onClose,
  embedded = false,
}) => {
  const hostRef = useRef<HTMLDivElement>(null)
  const shownRef = useRef(false)
  const addressFocusedRef = useRef(false)
  const [state, setState] = useState<BrowserState>(EMPTY_STATE)
  const [address, setAddress] = useState('')
  const [localError, setLocalError] = useState<string | null>(null)
  const [controlPermission, setControlPermission] = useState<BrowserControlPermissionState>(VIEW_ONLY)
  const [sitePermission, setSitePermission] = useState<BrowserSitePermissionState>(NO_SITE_PERMISSION)
  const [resetConfirmation, setResetConfirmation] = useState(false)
  const [resetBusy, setResetBusy] = useState(false)
  const [tabs, setTabs] = useState<BrowserTab[]>([])
  const [latestDownload, setLatestDownload] = useState<BrowserDownload | null>(null)
  const [extensionsOpen, setExtensionsOpen] = useState(false)
  const [extensions, setExtensions] = useState<BrowserExtensionEntry[]>([])
  const [extensionCandidate, setExtensionCandidate] = useState<BrowserExtensionCandidate | null>(null)
  const [chromeExtensions, setChromeExtensions] = useState<ChromeBrowserExtensionCandidate[]>([])
  const [chromeScanComplete, setChromeScanComplete] = useState(false)
  const [extensionBusy, setExtensionBusy] = useState(false)
  const [browserMenuOpen, setBrowserMenuOpen] = useState(false)

  const useResult = <T,>(result: { ok: true; data: T } | { ok: false; error: string }): T | undefined => {
    if (!result.ok) {
      setLocalError(result.error)
      return undefined
    }
    setLocalError(null)
    return result.data
  }

  useEffect(() => {
    let cancelled = false
    const off = window.codey.browser.onState(next => {
      if (cancelled) return
      setState(next)
      if (!addressFocusedRef.current) setAddress(next.url)
      void window.codey.browser.tabs().then(result => { if (result.ok) setTabs(result.data) })
    })
    void window.codey.browser.getState().then(result => {
      const next = useResult(result)
      if (!cancelled && next) {
        setState(next)
        setAddress(next.url)
      }
    })
    void window.codey.browser.tabs().then(result => { if (!cancelled && result.ok) setTabs(result.data) })
    return () => {
      cancelled = true
      off()
      shownRef.current = false
      void window.codey.browser.hide()
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    const off = window.codey.browser.onSitePermission(next => {
      if (!cancelled) setSitePermission(next)
    })
    void window.codey.browser.sitePermission.get().then(result => {
      const next = useResult(result)
      if (!cancelled && next) setSitePermission(next)
    })
    return () => { cancelled = true; off() }
  }, [])

  useEffect(() => {
    let cancelled = false
    const off = window.codey.browser.onDownload(download => {
      if (!cancelled) setLatestDownload(download)
    })
    void window.codey.browser.downloads().then(result => {
      if (!cancelled && result.ok) {
        const latest = result.data[0]
        const recent = latest && (latest.status === 'progressing' || Date.now() - (latest.finishedAt ?? 0) < 15000)
        setLatestDownload(recent ? latest : null)
      }
    })
    return () => { cancelled = true; off() }
  }, [])

  useEffect(() => {
    let cancelled = false
    const off = window.codey.browser.onControlPermission(next => {
      if (!cancelled) setControlPermission(next)
    })
    void window.codey.browser.controlPermission.get().then(result => {
      const next = useResult(result)
      if (!cancelled && next) setControlPermission(next)
    })
    return () => { cancelled = true; off() }
  }, [])

  useLayoutEffect(() => {
    const host = hostRef.current
    if (!host) return

    let frame = 0
    const placeBrowser = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const bounds = rectToBounds(host.getBoundingClientRect())
        if (bounds.width === 0 || bounds.height === 0) return
        if (!shownRef.current) {
          shownRef.current = true
          void window.codey.browser.show(bounds).then(result => {
            const next = useResult(result)
            if (next) setState(next)
          })
        } else {
          void window.codey.browser.setBounds(bounds).then(useResult)
        }
      })
    }

    const observer = new ResizeObserver(placeBrowser)
    observer.observe(host)
    window.addEventListener('resize', placeBrowser)
    placeBrowser()
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      window.removeEventListener('resize', placeBrowser)
    }
  }, [])

  const navigate = async () => {
    const next = useResult(await window.codey.browser.navigate(address))
    if (next) setState(next)
  }

  const run = async (operation: () => Promise<{ ok: true; data: BrowserState } | { ok: false; error: string }>) => {
    const next = useResult(await operation())
    if (next) {
      setState(next)
      if (!addressFocusedRef.current) setAddress(next.url)
      const tabResult = await window.codey.browser.tabs()
      if (tabResult.ok) setTabs(tabResult.data)
    }
  }

  const displayedError = localError ?? state.error
  const secure = state.url.startsWith('https://')

  const usePageInChat = async () => {
    if (!chatId) return
    const context = useResult(await window.codey.browser.getPageContext())
    if (!context) return
    const current = getDraft(chatId)
    const pagePrompt = buildBrowserContextPrompt(context)
    setDraft(chatId, {
      ...current,
      text: current.text ? `${current.text}\n\n${pagePrompt}` : pagePrompt,
    })
    onClose()
  }

  const updateControlPermission = async (
    operation: () => Promise<{ ok: true; data: BrowserControlPermissionState } | { ok: false; error: string }>,
  ) => {
    const next = useResult(await operation())
    if (next) setControlPermission(next)
  }

  const updateSitePermission = async (
    operation: () => Promise<{ ok: true; data: BrowserSitePermissionState } | { ok: false; error: string }>,
  ) => {
    const next = useResult(await operation())
    if (next) setSitePermission(next)
  }

  const resetBrowserSession = async () => {
    setResetBusy(true)
    try {
      const next = useResult(await window.codey.browser.resetSession())
      if (!next) return
      setState(next)
      setAddress(next.url)
      setLatestDownload(null)
      setResetConfirmation(false)
      const host = hostRef.current
      if (host) {
        const shown = useResult(await window.codey.browser.show(rectToBounds(host.getBoundingClientRect())))
        if (shown) setState(shown)
      }
      const tabResult = await window.codey.browser.tabs()
      if (tabResult.ok) setTabs(tabResult.data)
    } finally {
      setResetBusy(false)
    }
  }

  const openExtensions = async () => {
    const nextOpen = !extensionsOpen
    setExtensionsOpen(nextOpen)
    setExtensionCandidate(null)
    if (!nextOpen) return
    const next = useResult(await window.codey.browser.extensions.list())
    if (next) setExtensions(next)
  }

  const pickExtension = async () => {
    setExtensionBusy(true)
    try {
      const candidate = useResult(await window.codey.browser.extensions.pick())
      if (candidate) setExtensionCandidate(candidate)
    } finally {
      setExtensionBusy(false)
    }
  }

  const discoverChromeExtensions = async () => {
    setExtensionBusy(true)
    try {
      const candidates = useResult(await window.codey.browser.extensions.discoverChrome())
      if (candidates) {
        setChromeExtensions(candidates)
        setChromeScanComplete(true)
        setExtensionCandidate(null)
      }
    } finally {
      setExtensionBusy(false)
    }
  }

  const importChromeExtension = async (candidate: ChromeBrowserExtensionCandidate) => {
    if (!candidate.compatible) return
    setExtensionBusy(true)
    try {
      const next = useResult(await window.codey.browser.extensions.importFromChrome(candidate.path))
      if (next) {
        setExtensions(next)
        setChromeExtensions(current => current.filter(extension => extension.path !== candidate.path))
      }
    } finally {
      setExtensionBusy(false)
    }
  }

  const installExtension = async () => {
    if (!extensionCandidate) return
    setExtensionBusy(true)
    try {
      const next = useResult(await window.codey.browser.extensions.install(extensionCandidate.path))
      if (next) {
        setExtensions(next)
        setExtensionCandidate(null)
      }
    } finally {
      setExtensionBusy(false)
    }
  }

  const updateExtensions = async (
    operation: () => Promise<{ ok: true; data: BrowserExtensionEntry[] } | { ok: false; error: string }>,
  ) => {
    setExtensionBusy(true)
    try {
      const next = useResult(await operation())
      if (next) setExtensions(next)
    } finally {
      setExtensionBusy(false)
    }
  }

  const pendingDomain = (() => {
    try { return controlPermission.pending ? new URL(controlPermission.pending.url).hostname : '' }
    catch { return controlPermission.pending?.url || '' }
  })()

  return (
    <section style={styles.root} aria-label="Codey Browser">
      <div style={{ ...styles.toolbar, ...(embedded ? styles.compactToolbar : null) }}>
        <div style={styles.navGroup}>
          <button
            type="button"
            style={{ ...styles.iconButton, opacity: state.canGoBack ? 1 : 0.38 }}
            disabled={!state.canGoBack}
            title="Back"
            aria-label="Back"
            onClick={() => void run(window.codey.browser.back)}
          >‹</button>
          {!embedded && (
            <button
              type="button"
              style={{ ...styles.iconButton, opacity: state.canGoForward ? 1 : 0.38 }}
              disabled={!state.canGoForward}
              title="Forward"
              aria-label="Forward"
              onClick={() => void run(window.codey.browser.forward)}
            >›</button>
          )}
          <button
            type="button"
            style={styles.iconButton}
            title={state.loading ? 'Stop loading' : 'Reload'}
            aria-label={state.loading ? 'Stop loading' : 'Reload'}
            onClick={() => void run(state.loading ? window.codey.browser.stop : window.codey.browser.reload)}
          >{state.loading ? '×' : <UIIcon name="refresh" size={14} />}</button>
        </div>

        <form
          style={{ ...styles.addressForm, ...(displayedError ? styles.addressError : null) }}
          onSubmit={event => { event.preventDefault(); void navigate() }}
        >
          <span style={{ ...styles.security, color: secure ? C.green : C.fg3 }} title={secure ? 'Secure connection' : 'Connection information'}>
            {secure ? '●' : '○'}
          </span>
          <input
            value={address}
            onChange={event => setAddress(event.target.value)}
            onFocus={event => { addressFocusedRef.current = true; event.currentTarget.select() }}
            onBlur={() => { addressFocusedRef.current = false }}
            placeholder="Search or enter an address"
            aria-label="Browser address"
            spellCheck={false}
            autoCapitalize="none"
            style={styles.address}
          />
          {state.loading && <span style={styles.loadingDot} aria-label="Loading" />}
        </form>

        <button
          type="button"
          style={{ ...styles.contextButton, opacity: chatId && state.url ? 1 : 0.5 }}
          title={chatId ? 'Add this page and its performance timing to the current chat' : 'Select a chat first'}
          disabled={!chatId || !state.url}
          onClick={() => void usePageInChat()}
        >
          <UIIcon name="sparkle" size={14} />
          {!embedded && <span>Use in chat</span>}
        </button>
        {!embedded && <button
          type="button"
          style={{ ...styles.iconButton, ...(extensionsOpen ? styles.iconButtonActive : null) }}
          title="Browser extensions"
          aria-label="Browser extensions"
          aria-expanded={extensionsOpen}
          onClick={() => void openExtensions()}
        >⊞</button>}
        {!embedded && <button
          type="button"
          style={styles.iconButton}
          title="Open in default browser"
          aria-label="Open in default browser"
          disabled={!state.url}
          onClick={() => { if (state.url) void window.codey.openExternal(state.url) }}
        >↗</button>}
        {!embedded && <button
          type="button"
          style={{
            ...styles.permissionBadge,
            ...(controlPermission.approved ? styles.permissionApproved : styles.permissionViewOnly),
          }}
          title={controlPermission.approved ? 'Revoke agent browser control' : 'Agents can only view until you approve control'}
          onClick={() => {
            if (controlPermission.approved) void updateControlPermission(window.codey.browser.controlPermission.revoke)
          }}
        >
          <span style={styles.permissionDot} />
          {controlPermission.approved ? 'Full Control' : 'View Only'}
        </button>}
        {!embedded && <button
          type="button"
          style={{ ...styles.iconButton, ...(resetConfirmation ? styles.iconButtonDanger : null) }}
          title="Clear browser data and sign out"
          aria-label="Clear browser data and sign out"
          aria-expanded={resetConfirmation}
          onClick={() => setResetConfirmation(current => !current)}
        ><UIIcon name="trash" size={14} /></button>}
        {embedded && (
          <button
            type="button"
            style={{ ...styles.iconButton, ...(browserMenuOpen ? styles.iconButtonActive : null) }}
            title="More browser actions"
            aria-label="More browser actions"
            aria-expanded={browserMenuOpen}
            onClick={() => setBrowserMenuOpen(current => !current)}
          ><UIIcon name="more" size={15} /></button>
        )}
        {!embedded && <button type="button" style={styles.closeButton} onClick={onClose} title="Close browser" aria-label="Close browser">
          <UIIcon name="close" size={15} />
        </button>}
      </div>

      {embedded && browserMenuOpen && (
        <div style={styles.browserMenu} aria-label="Browser actions">
          <button type="button" style={styles.menuButton} onClick={() => { setBrowserMenuOpen(false); void openExtensions() }}>
            <span aria-hidden="true">⊞</span> Extensions
          </button>
          <button type="button" style={styles.menuButton} disabled={!state.url} onClick={() => { setBrowserMenuOpen(false); if (state.url) void window.codey.openExternal(state.url) }}>
            <span aria-hidden="true">↗</span> Open externally
          </button>
          <button
            type="button"
            style={{ ...styles.menuButton, ...(controlPermission.approved ? styles.menuButtonWarning : null) }}
            onClick={() => {
              setBrowserMenuOpen(false)
              if (controlPermission.approved) void updateControlPermission(window.codey.browser.controlPermission.revoke)
            }}
          >
            <span aria-hidden="true">{controlPermission.approved ? '●' : '○'}</span>
            {controlPermission.approved ? 'Revoke agent control' : 'Agent access: view only'}
          </button>
          <button type="button" style={{ ...styles.menuButton, color: C.red }} onClick={() => { setBrowserMenuOpen(false); setResetConfirmation(true) }}>
            <UIIcon name="trash" size={13} /> Clear data & sign out
          </button>
        </div>
      )}

      <div style={styles.tabStrip} role="tablist" aria-label="Browser tabs">
        {tabs.map(tab => (
          <div
            key={tab.id}
            role="tab"
            tabIndex={0}
            aria-selected={tab.active}
            title={tab.title || tab.url || 'New tab'}
            style={{ ...styles.tab, ...(tab.active ? styles.activeTab : null) }}
            onClick={() => void run(() => window.codey.browser.switchTab(tab.id))}
            onKeyDown={event => {
              if (event.key === 'Enter' || event.key === ' ') void run(() => window.codey.browser.switchTab(tab.id))
            }}
          >
            <span style={styles.tabTitle}>{tab.title || 'New tab'}</span>
            <button
              type="button"
              aria-label={`Close ${tab.title || 'tab'}`}
              style={styles.tabClose}
              onClick={event => {
                event.stopPropagation()
                void run(() => window.codey.browser.closeTab(tab.id))
              }}
            >×</button>
          </div>
        ))}
        <button
          type="button"
          style={styles.newTabButton}
          title="New tab"
          aria-label="New tab"
          onClick={() => void run(() => window.codey.browser.newTab())}
        >+</button>
      </div>

      {extensionsOpen && (
        <div style={styles.extensionsPanel} aria-label="Browser extensions">
          <div style={styles.extensionsHeader}>
            <div>
              <div style={styles.extensionsTitle}>Extensions</div>
              <div style={styles.extensionsCopy}>Install in Chrome first, then import a compatible copy into Codey. Chrome Web Store buttons cannot install directly into Electron.</div>
            </div>
            <div style={styles.extensionsActions}>
              <button
                type="button"
                style={styles.secondaryButton}
                onClick={() => void window.codey.openExternal('https://chromewebstore.google.com/category/extensions')}
              >View Web Store ↗</button>
              <button type="button" style={styles.primaryButton} disabled={extensionBusy} onClick={() => void discoverChromeExtensions()}>
                {chromeScanComplete ? 'Scan Chrome again' : 'Import from Chrome'}
              </button>
              <button type="button" style={styles.secondaryButton} disabled={extensionBusy} onClick={() => void pickExtension()}>
                Load unpacked
              </button>
            </div>
          </div>

          {extensionCandidate && (
            <div style={styles.extensionReview} role="dialog" aria-label="Review unpacked extension">
              <div style={styles.extensionReviewBody}>
                <div style={styles.extensionName}>{extensionCandidate.name} <span style={styles.extensionVersion}>v{extensionCandidate.version}</span></div>
                {extensionCandidate.description && <div style={styles.extensionDescription}>{extensionCandidate.description}</div>}
                <div style={styles.extensionAccess}>
                  <strong>Requested access:</strong>{' '}
                  {[...extensionCandidate.permissions, ...extensionCandidate.hostPermissions].join(', ') || 'No declared permissions'}
                </div>
                {extensionCandidate.warnings.map(warning => <div key={warning} style={styles.extensionWarning}>⚠ {warning}</div>)}
              </div>
              <button type="button" style={styles.secondaryButton} disabled={extensionBusy} onClick={() => setExtensionCandidate(null)}>Cancel</button>
              <button type="button" style={styles.primaryButton} disabled={extensionBusy} onClick={() => void installExtension()}>Load extension</button>
            </div>
          )}

          {!extensionCandidate && chromeExtensions.length > 0 && (
            <div style={styles.extensionSectionLabel}>Installed in Chrome</div>
          )}

          {!extensionCandidate && chromeExtensions.map(candidate => (
            <div key={`${candidate.profile}:${candidate.extensionId}`} style={styles.extensionRow}>
              <div style={{ ...styles.extensionStatusIcon, color: candidate.compatible ? C.green : C.warningFg }}>
                {candidate.compatible ? '●' : '⚠'}
              </div>
              <div style={styles.extensionInfo}>
                <div style={styles.extensionName}>
                  {candidate.name} <span style={styles.extensionVersion}>v{candidate.version} · {candidate.profile}</span>
                </div>
                {candidate.description && <div style={styles.extensionDescription}>{candidate.description}</div>}
                <div style={styles.extensionAccess}>
                  <strong>Requested access:</strong>{' '}
                  {[...candidate.permissions, ...candidate.hostPermissions].join(', ') || 'No declared permissions'}
                </div>
                {candidate.incompatibilities.map(reason => (
                  <div key={reason} style={styles.extensionError}>{reason}</div>
                ))}
              </div>
              <button
                type="button"
                style={candidate.compatible ? styles.primaryButton : styles.smallButton}
                disabled={extensionBusy || !candidate.compatible}
                title={candidate.compatible ? 'Copy and load this extension in Codey' : candidate.incompatibilities.join(' ')}
                onClick={() => void importChromeExtension(candidate)}
              >{candidate.compatible ? 'Import' : 'Unsupported'}</button>
            </div>
          ))}

          {!extensionCandidate && chromeScanComplete && chromeExtensions.length === 0 && (
            <div style={styles.extensionsEmpty}>No importable extensions were found in your Chrome profiles. Install one in Chrome, then scan again.</div>
          )}

          {!extensionCandidate && extensions.length === 0 && !chromeScanComplete && (
            <div style={styles.extensionsEmpty}>No Codey extensions loaded. Import one from Chrome or choose an unpacked extension folder.</div>
          )}

          {!extensionCandidate && extensions.length > 0 && (
            <div style={styles.extensionSectionLabel}>Loaded in Codey</div>
          )}

          {!extensionCandidate && extensions.map(extension => (
            <div key={extension.key} style={styles.extensionRow}>
              <div style={styles.extensionStatusIcon}>{extension.enabled && !extension.error ? '●' : '○'}</div>
              <div style={styles.extensionInfo}>
                <div style={styles.extensionName}>
                  {extension.name} <span style={styles.extensionVersion}>{extension.version ? `v${extension.version}` : ''}</span>
                </div>
                <div style={extension.error ? styles.extensionError : styles.extensionPath} title={extension.path}>
                  {extension.error || extension.path}
                </div>
              </div>
              <button
                type="button"
                style={styles.smallButton}
                disabled={extensionBusy}
                onClick={() => void updateExtensions(() => window.codey.browser.extensions.setEnabled(extension.key, !extension.enabled))}
              >{extension.enabled ? 'Disable' : 'Enable'}</button>
              <button
                type="button"
                style={styles.smallButton}
                disabled={extensionBusy || !extension.enabled}
                onClick={() => void updateExtensions(() => window.codey.browser.extensions.reload(extension.key))}
              >Reload</button>
              <button
                type="button"
                style={{ ...styles.smallButton, color: C.red }}
                disabled={extensionBusy}
                onClick={() => void updateExtensions(() => window.codey.browser.extensions.remove(extension.key))}
              >Remove</button>
            </div>
          ))}
        </div>
      )}

      {controlPermission.pending && !controlPermission.approved && (
        <div style={styles.permissionPrompt} role="alertdialog" aria-label="Agent browser control permission">
          <div style={styles.permissionPromptIcon}><UIIcon name="bot" size={18} /></div>
          <div style={styles.permissionPromptText}>
            <div style={styles.permissionPromptTitle}>Allow the agent to control this browser?</div>
            <div style={styles.permissionPromptCopy}>
              The agent wants to <strong>{controlPermission.pending.command}</strong>{pendingDomain ? ` on ${pendingDomain}` : ''}.
              Full control allows clicking, typing, submitting forms, sending posts, and acting through your signed-in accounts.
            </div>
          </div>
          <button
            type="button"
            style={styles.denyButton}
            onClick={() => void updateControlPermission(window.codey.browser.controlPermission.deny)}
          >Not now</button>
          <button
            type="button"
            style={styles.approveButton}
            onClick={() => void updateControlPermission(window.codey.browser.controlPermission.approve)}
          >Allow full control</button>
        </div>
      )}

      {sitePermission.pending && (
        <div style={styles.sitePermissionPrompt} role="alertdialog" aria-label="Website permission request">
          <div style={styles.sitePermissionIcon}><UIIcon name="globe" size={18} /></div>
          <div style={styles.permissionPromptText}>
            <div style={styles.permissionPromptTitle}>{sitePermission.pending.hostname} wants website access</div>
            <div style={styles.permissionPromptCopy}>
              Allow this site to use {sitePermission.pending.permissions.map(permission => SITE_PERMISSION_LABELS[permission]).join(' and ')}?
            </div>
          </div>
          <button
            type="button"
            style={styles.denyButton}
            onClick={() => void updateSitePermission(() => window.codey.browser.sitePermission.block(sitePermission.pending!.id))}
          >Block</button>
          <button
            type="button"
            style={styles.secondaryButton}
            onClick={() => void updateSitePermission(() => window.codey.browser.sitePermission.allowForSession(sitePermission.pending!.id))}
          >Allow for session</button>
          <button
            type="button"
            style={styles.approveButton}
            onClick={() => void updateSitePermission(() => window.codey.browser.sitePermission.alwaysAllow(sitePermission.pending!.id))}
          >Always allow</button>
        </div>
      )}

      {resetConfirmation && (
        <div style={styles.resetPrompt} role="alertdialog" aria-label="Clear browser data confirmation">
          <div style={styles.resetPromptIcon}><UIIcon name="trash" size={18} /></div>
          <div style={styles.permissionPromptText}>
            <div style={styles.permissionPromptTitle}>Clear browser data and sign out?</div>
            <div style={styles.permissionPromptCopy}>
              This closes every tab, clears cookies, cache, saved website permissions, and revokes agent Full Control. Installed extensions remain available.
            </div>
          </div>
          <button type="button" style={styles.denyButton} disabled={resetBusy} onClick={() => setResetConfirmation(false)}>Cancel</button>
          <button type="button" style={styles.resetButton} disabled={resetBusy} onClick={() => void resetBrowserSession()}>
            {resetBusy ? 'Clearing…' : 'Clear data'}
          </button>
        </div>
      )}

      {loginWait && (
        <div
          style={{
            ...styles.loginWaitBar,
            ...(loginWait.status === 'expired' ? styles.loginWaitExpired : null),
            ...(loginWait.status === 'changed' ? styles.loginWaitChanged : null),
          }}
          role="status"
        >
          <span style={styles.loginWaitDot} />
          <div style={styles.loginWaitText}>
            <strong>
              {loginWait.status === 'watching'
                ? 'Waiting for you to sign in'
                : loginWait.status === 'changed'
                  ? 'Login changed — retrying the chat'
                  : 'Login wait ended'}
            </strong>
            <span>
              {loginWait.status === 'watching'
                ? ` Codey is checking this page until ${new Date(loginWait.expiresAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.`
                : loginWait.status === 'changed'
                  ? ' The agent will verify the current page before continuing.'
                  : ' Finish signing in, then confirm when you want the agent to retry.'}
            </span>
          </div>
          {loginWait.status === 'expired' && onConfirmLoginWait && (
            <button type="button" style={styles.loginWaitConfirm} onClick={() => onConfirmLoginWait(loginWait)}>
              I’m signed in — Retry
            </button>
          )}
          {loginWait.status !== 'watching' && onDismissLoginWait && (
            <button type="button" style={styles.loginWaitDismiss} onClick={onDismissLoginWait}>Dismiss</button>
          )}
        </div>
      )}

      {displayedError && (
        <div style={styles.errorBar} role="status">
          <span>{displayedError}</span>
          <button type="button" onClick={() => setLocalError(null)} style={styles.dismissError}>Dismiss</button>
        </div>
      )}

      {latestDownload && (
        <div style={styles.downloadBar} role="status">
          <span style={styles.downloadName}>
            {latestDownload.status === 'progressing' ? 'Downloading' : latestDownload.status === 'completed' ? 'Downloaded' : 'Download'}: {latestDownload.name}
          </span>
          {latestDownload.status === 'completed' && (
            <button type="button" style={styles.downloadOpen} onClick={() => void window.codey.openPath(latestDownload.path)}>Open</button>
          )}
          <button type="button" style={styles.dismissError} onClick={() => setLatestDownload(null)}>Dismiss</button>
        </div>
      )}

      <div ref={hostRef} style={styles.host}>
        {!state.url && !state.loading && (
          <div style={styles.empty}>
            <div style={styles.emptyIcon}><UIIcon name="globe" size={30} /></div>
            <div style={styles.emptyTitle}>Browse without leaving Codey</div>
            <div style={styles.emptyCopy}>Your cookies and login sessions persist securely between app launches.</div>
          </div>
        )}
      </div>
    </section>
  )
}

const styles: Record<string, React.CSSProperties> = {
  root: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: C.bg },
  toolbar: { height: 48, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 7, padding: '7px 10px', background: C.surface, borderBottom: `1px solid ${C.border}` },
  compactToolbar: { gap: 4, padding: '7px 6px' },
  browserMenu: { minHeight: 38, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 4, padding: '5px 7px', overflowX: 'auto', background: C.surface2, borderBottom: `1px solid ${C.border}` },
  menuButton: { height: 28, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 5, padding: '0 8px', border: `1px solid ${C.border}`, borderRadius: 6, background: C.surface, color: C.fg2, cursor: 'pointer', fontSize: 10, whiteSpace: 'nowrap' },
  menuButtonWarning: { color: C.warningFg, borderColor: `${C.warningFg}88`, background: C.warningBg },
  tabStrip: { height: 34, flexShrink: 0, display: 'flex', alignItems: 'flex-end', gap: 3, padding: '4px 8px 0', overflowX: 'auto', background: C.surface, borderBottom: `1px solid ${C.border}` },
  tab: { maxWidth: 180, minWidth: 90, height: 29, padding: '0 6px 0 9px', display: 'flex', alignItems: 'center', gap: 7, border: `1px solid transparent`, borderBottom: 'none', borderRadius: '7px 7px 0 0', background: 'transparent', color: C.fg3, cursor: 'pointer', fontSize: 10.5 },
  activeTab: { background: C.bg, color: C.fg, borderColor: C.border },
  tabTitle: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'left' },
  tabClose: { width: 16, height: 16, padding: 0, flexShrink: 0, display: 'grid', placeItems: 'center', border: 'none', borderRadius: 4, background: 'transparent', color: C.fg3, cursor: 'pointer', fontSize: 14, lineHeight: 1 },
  newTabButton: { width: 27, height: 27, flexShrink: 0, border: 'none', borderRadius: 6, background: 'transparent', color: C.fg2, cursor: 'pointer', fontSize: 18 },
  navGroup: { display: 'flex', alignItems: 'center', gap: 3 },
  iconButton: { width: 31, height: 31, padding: 0, border: 'none', borderRadius: 7, display: 'grid', placeItems: 'center', background: 'transparent', color: C.fg2, cursor: 'pointer', fontSize: 21, lineHeight: 1 },
  iconButtonActive: { background: C.accentDim, color: C.accent },
  iconButtonDanger: { background: `${C.red}18`, color: C.red },
  closeButton: { width: 31, height: 31, padding: 0, border: `1px solid ${C.border}`, borderRadius: 7, display: 'grid', placeItems: 'center', background: C.surface2, color: C.fg3, cursor: 'pointer' },
  contextButton: { height: 31, padding: '0 10px', border: `1px solid ${C.accent}66`, borderRadius: 7, display: 'flex', alignItems: 'center', gap: 6, background: C.accentDim, color: C.accent, cursor: 'pointer', fontSize: 11, fontWeight: 650, whiteSpace: 'nowrap' },
  permissionBadge: { height: 28, padding: '0 8px', borderRadius: 7, display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer', fontSize: 10, fontWeight: 650, whiteSpace: 'nowrap' },
  permissionApproved: { color: C.warningFg, background: C.warningBg, border: `1px solid ${C.warningFg}88` },
  permissionViewOnly: { color: C.fg3, background: C.surface2, border: `1px solid ${C.border}` },
  permissionDot: { width: 6, height: 6, borderRadius: '50%', background: 'currentColor' },
  permissionPrompt: { minHeight: 76, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', background: C.surface2, borderBottom: `1px solid ${C.accent}66` },
  permissionPromptIcon: { width: 34, height: 34, flexShrink: 0, borderRadius: 10, display: 'grid', placeItems: 'center', color: C.accent, background: C.accentDim, border: `1px solid ${C.accent}55` },
  sitePermissionPrompt: { minHeight: 76, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', background: C.surface2, borderBottom: `1px solid ${C.green}66` },
  sitePermissionIcon: { width: 34, height: 34, flexShrink: 0, borderRadius: 10, display: 'grid', placeItems: 'center', color: C.green, background: `${C.green}18`, border: `1px solid ${C.green}55` },
  resetPrompt: { minHeight: 76, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', background: C.surface2, borderBottom: `1px solid ${C.red}66` },
  resetPromptIcon: { width: 34, height: 34, flexShrink: 0, borderRadius: 10, display: 'grid', placeItems: 'center', color: C.red, background: `${C.red}18`, border: `1px solid ${C.red}55` },
  resetButton: { height: 30, padding: '0 11px', flexShrink: 0, borderRadius: 7, border: `1px solid ${C.red}`, background: C.red, color: '#fff', cursor: 'pointer', fontSize: 11, fontWeight: 700 },
  permissionPromptText: { flex: 1, minWidth: 0 },
  permissionPromptTitle: { color: C.fg, fontSize: 12, fontWeight: 750 },
  permissionPromptCopy: { color: C.fg2, fontSize: 10.5, lineHeight: 1.45, marginTop: 3 },
  loginWaitBar: { minHeight: 38, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 9, padding: '7px 12px', background: `${C.accent}14`, color: C.fg2, borderBottom: `1px solid ${C.accent}55`, fontSize: 10.5 },
  loginWaitExpired: { background: `${C.warningFg}12`, borderBottomColor: `${C.warningFg}55` },
  loginWaitChanged: { background: `${C.green}12`, borderBottomColor: `${C.green}55` },
  loginWaitDot: { width: 7, height: 7, flexShrink: 0, borderRadius: '50%', background: 'currentColor', animation: 'codey-pulse 1.2s ease-in-out infinite' },
  loginWaitText: { flex: 1, minWidth: 0, lineHeight: 1.4 },
  loginWaitConfirm: { height: 28, padding: '0 10px', flexShrink: 0, borderRadius: 7, border: `1px solid ${C.accent}`, background: C.accent, color: C.onAccent, cursor: 'pointer', fontSize: 10.5, fontWeight: 700 },
  loginWaitDismiss: { border: 'none', background: 'transparent', color: C.fg3, cursor: 'pointer', fontSize: 10.5, textDecoration: 'underline' },
  denyButton: { height: 30, padding: '0 10px', flexShrink: 0, borderRadius: 7, border: `1px solid ${C.border2}`, background: C.surface3, color: C.fg2, cursor: 'pointer', fontSize: 11 },
  approveButton: { height: 30, padding: '0 11px', flexShrink: 0, borderRadius: 7, border: `1px solid ${C.accent}`, background: C.accent, color: C.onAccent, cursor: 'pointer', fontSize: 11, fontWeight: 700 },
  addressForm: { flex: 1, minWidth: 120, height: 32, display: 'flex', alignItems: 'center', gap: 7, padding: '0 10px', borderRadius: 9, background: C.surface2, border: `1px solid ${C.border2}` },
  addressError: { borderColor: C.red },
  security: { fontSize: 9, flexShrink: 0 },
  address: { flex: 1, minWidth: 0, height: '100%', padding: 0, border: 'none', outline: 'none', background: 'transparent', color: C.fg, fontSize: 12.5 },
  loadingDot: { width: 7, height: 7, borderRadius: '50%', background: C.accent, animation: 'codey-pulse 1s ease-in-out infinite', flexShrink: 0 },
  extensionsPanel: { maxHeight: 360, flexShrink: 0, overflowY: 'auto', padding: '10px 12px', background: C.surface, borderBottom: `1px solid ${C.border}` },
  extensionsHeader: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 },
  extensionsTitle: { color: C.fg, fontSize: 12.5, fontWeight: 750 },
  extensionsCopy: { color: C.fg3, fontSize: 10.5, lineHeight: 1.4, marginTop: 2 },
  extensionsActions: { display: 'flex', alignItems: 'center', gap: 7, flexShrink: 0 },
  primaryButton: { minHeight: 29, padding: '0 10px', border: `1px solid ${C.accent}`, borderRadius: 7, background: C.accent, color: C.onAccent, cursor: 'pointer', fontSize: 10.5, fontWeight: 700, whiteSpace: 'nowrap' },
  secondaryButton: { minHeight: 29, padding: '0 10px', border: `1px solid ${C.border2}`, borderRadius: 7, background: C.surface2, color: C.fg2, cursor: 'pointer', fontSize: 10.5, whiteSpace: 'nowrap' },
  smallButton: { minHeight: 25, padding: '0 8px', border: `1px solid ${C.border}`, borderRadius: 6, background: C.surface2, color: C.fg2, cursor: 'pointer', fontSize: 10 },
  extensionsEmpty: { marginTop: 10, padding: '10px 12px', color: C.fg3, background: C.surface2, border: `1px dashed ${C.border2}`, borderRadius: 8, fontSize: 10.5 },
  extensionReview: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 10, padding: 10, background: C.surface2, border: `1px solid ${C.accent}66`, borderRadius: 9 },
  extensionReviewBody: { flex: 1, minWidth: 0 },
  extensionSectionLabel: { marginTop: 11, color: C.fg2, fontSize: 10, fontWeight: 750, textTransform: 'uppercase', letterSpacing: 0.5 },
  extensionRow: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, padding: '8px 9px', background: C.surface2, border: `1px solid ${C.border}`, borderRadius: 8 },
  extensionStatusIcon: { width: 15, flexShrink: 0, color: C.green, fontSize: 9, textAlign: 'center' },
  extensionInfo: { flex: 1, minWidth: 0 },
  extensionName: { color: C.fg, fontSize: 11.5, fontWeight: 700 },
  extensionVersion: { color: C.fg3, fontSize: 9.5, fontWeight: 500 },
  extensionDescription: { color: C.fg2, fontSize: 10.5, lineHeight: 1.35, marginTop: 2 },
  extensionAccess: { color: C.fg2, fontSize: 10, lineHeight: 1.35, marginTop: 5, overflowWrap: 'anywhere' },
  extensionWarning: { color: C.warningFg, fontSize: 9.5, lineHeight: 1.35, marginTop: 3 },
  extensionPath: { color: C.fg3, fontSize: 9.5, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  extensionError: { color: C.red, fontSize: 9.5, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  errorBar: { minHeight: 30, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '5px 12px', background: `${C.red}18`, color: C.red, borderBottom: `1px solid ${C.red}55`, fontSize: 11 },
  downloadBar: { minHeight: 30, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 10, padding: '5px 12px', background: `${C.green}12`, color: C.green, borderBottom: `1px solid ${C.green}44`, fontSize: 11 },
  downloadName: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  downloadOpen: { border: 'none', background: 'transparent', color: C.green, cursor: 'pointer', fontSize: 11, fontWeight: 700, textDecoration: 'underline' },
  dismissError: { border: 'none', background: 'transparent', color: C.red, cursor: 'pointer', fontSize: 11, textDecoration: 'underline' },
  host: { flex: 1, minHeight: 0, position: 'relative', overflow: 'hidden', background: C.bg },
  empty: { position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 24, color: C.fg3, textAlign: 'center' },
  emptyIcon: { width: 62, height: 62, borderRadius: 20, display: 'grid', placeItems: 'center', color: C.accent, background: C.accentDim, border: `1px solid ${C.accent}66` },
  emptyTitle: { color: C.fg, fontSize: 16, fontWeight: 700, marginTop: 14 },
  emptyCopy: { color: C.fg2, fontSize: 12, lineHeight: 1.5, marginTop: 6, maxWidth: 330 },
}
