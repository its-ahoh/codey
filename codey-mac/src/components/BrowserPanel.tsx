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
  BrowserProfileSummary,
  ChromeBrowserExtensionCandidate,
  BrowserState,
  BrowserTab,
} from '../codey-api'
import { C } from '../theme'
import { UIIcon } from './UIIcons'
import { BrowserProfiles } from './BrowserProfiles'
import { appendDraftText } from './chatDrafts'
import { buildBrowserContextPrompt } from './browserContextPrompt'
import { browserProfileAvatar } from './browserProfileAvatars'

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

const VIEW_ONLY: BrowserControlPermissionState = { granted: { browser: 'none', chrome: 'none' }, pending: null }
const NO_SITE_PERMISSION: BrowserSitePermissionState = { pending: null, savedSiteCount: 0 }

type BrowserSettingsSection = 'extensions' | 'profiles'

const SETTINGS_SECTIONS: Record<BrowserSettingsSection, { title: string; url: string }> = {
  extensions: { title: 'Extensions', url: 'codey://settings/extensions' },
  profiles: { title: 'Profiles', url: 'codey://settings/profiles' },
}

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
  const rootRef = useRef<HTMLElement>(null)
  const hostRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const menuButtonRef = useRef<HTMLButtonElement>(null)
  const profileMenuRef = useRef<HTMLDivElement>(null)
  const profileButtonRef = useRef<HTMLButtonElement>(null)
  const shownRef = useRef(false)
  const browserCoveredRef = useRef(false)
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
  const [settingsTabOpen, setSettingsTabOpen] = useState(false)
  const [activeSettingsSection, setActiveSettingsSection] = useState<BrowserSettingsSection | null>(null)
  const [lastSettingsSection, setLastSettingsSection] = useState<BrowserSettingsSection>('extensions')
  const [extensions, setExtensions] = useState<BrowserExtensionEntry[]>([])
  const [extensionCandidate, setExtensionCandidate] = useState<BrowserExtensionCandidate | null>(null)
  const [chromeExtensions, setChromeExtensions] = useState<ChromeBrowserExtensionCandidate[]>([])
  const [chromeScanComplete, setChromeScanComplete] = useState(false)
  const [extensionBusy, setExtensionBusy] = useState(false)
  const [browserMenuOpen, setBrowserMenuOpen] = useState(false)
  const [profileMenuOpen, setProfileMenuOpen] = useState(false)
  const [profiles, setProfiles] = useState<BrowserProfileSummary[]>([])
  const [activeProfile, setActiveProfile] = useState<string | null>(null)
  const [profileBusy, setProfileBusy] = useState(false)
  const [syncBusy, setSyncBusy] = useState(false)
  const [syncNote, setSyncNote] = useState<string | null>(null)
  const [panelWidth, setPanelWidth] = useState(900)

  const browserCovered = browserMenuOpen || profileMenuOpen || activeSettingsSection !== null
  browserCoveredRef.current = browserCovered
  const browserPageVisible = !browserCovered && !!state.url

  useLayoutEffect(() => {
    const root = rootRef.current
    if (!root) return
    const updateWidth = () => setPanelWidth(Math.round(root.getBoundingClientRect().width))
    const observer = new ResizeObserver(updateWidth)
    observer.observe(root)
    updateWidth()
    return () => observer.disconnect()
  }, [])

  const unwrapResult = <T,>(result: { ok: true; data: T } | { ok: false; error: string }): T | undefined => {
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
      const next = unwrapResult(result)
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
      const next = unwrapResult(result)
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
      const next = unwrapResult(result)
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
        if (bounds.width === 0 || bounds.height === 0 || browserCoveredRef.current || !state.url) return
        if (!shownRef.current) {
          shownRef.current = true
          void window.codey.browser.show(bounds).then(result => {
            const next = unwrapResult(result)
            if (next) setState(next)
          })
        } else {
          void window.codey.browser.setBounds(bounds).then(unwrapResult)
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
  }, [state.url])

  useLayoutEffect(() => {
    if (!browserPageVisible) {
      shownRef.current = false
      void window.codey.browser.hide()
      return
    }
    const host = hostRef.current
    if (!host) return
    const bounds = rectToBounds(host.getBoundingClientRect())
    if (bounds.width === 0 || bounds.height === 0) return
    shownRef.current = true
    void window.codey.browser.show(bounds).then(result => {
      const next = unwrapResult(result)
      if (next) setState(next)
    })
  }, [browserPageVisible])

  useEffect(() => {
    if (!browserMenuOpen) return
    const closeMenu = (event: MouseEvent) => {
      const target = event.target as Node
      if (!menuRef.current?.contains(target) && !menuButtonRef.current?.contains(target)) setBrowserMenuOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setBrowserMenuOpen(false)
    }
    document.addEventListener('mousedown', closeMenu)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('mousedown', closeMenu)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [browserMenuOpen])

  useEffect(() => {
    if (!profileMenuOpen) return
    const closeMenu = (event: MouseEvent) => {
      const target = event.target as Node
      if (!profileMenuRef.current?.contains(target) && !profileButtonRef.current?.contains(target)) setProfileMenuOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setProfileMenuOpen(false)
    }
    document.addEventListener('mousedown', closeMenu)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('mousedown', closeMenu)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [profileMenuOpen])

  // The toolbar's profile chip. There is no profile-changed event, so refresh
  // on mount and every time the menu opens — the Settings ▸ Profiles page can
  // have activated a different one behind our back.
  const refreshProfiles = async () => {
    if (!window.codey?.browser?.profiles) return
    const result = await window.codey.browser.profiles.list()
    if (!result.ok) {
      setLocalError(result.error)
      return
    }
    setProfiles(result.data.profiles)
    setActiveProfile(result.data.active)
  }

  useEffect(() => { void refreshProfiles() }, [])

  // Several profiles can be on at once, so the menu toggles rather than picks.
  // The menu stays open: turning on a working set is usually more than one
  // click, and closing after each would make that tedious.
  const toggleProfile = async (name: string, enabled: boolean) => {
    setProfileBusy(true)
    try {
      const result = enabled
        ? await window.codey.browser.profiles.disable(name)
        : await window.codey.browser.profiles.enable(name)
      if (!result.ok) setLocalError(result.error)
      else setLocalError(null)
      await refreshProfiles()
    } finally {
      setProfileBusy(false)
    }
  }

  // Refresh one profile's saved logins from Chrome, whether or not it is in
  // use. The menu stays open: this is maintenance, not a choice.
  const syncProfile = async (name: string) => {
    setProfileBusy(true)
    setSyncNote(null)
    try {
      const result = await window.codey.browser.profiles.syncProfile(name)
      if (!result.ok) {
        setLocalError(result.error)
        return
      }
      setLocalError(null)
      setSyncNote(`Refreshed “${name}”: ${result.data.cookieCount} cookies from ${result.data.siteCount} site${result.data.siteCount === 1 ? '' : 's'}`)
      await refreshProfiles()
      await run(() => window.codey.browser.reload())
    } finally {
      setProfileBusy(false)
    }
  }

  // Pull this site's login out of the user's real Chrome and into the profile
  // that is enabled here, without leaving the page. Scoped to this one site, so
  // a profile carrying several logins keeps the rest. The page is reloaded
  // afterwards because a signed-out page does not re-check its cookies.
  const syncProfileFromChrome = async () => {
    if (!state.url || syncBusy) return
    setSyncBusy(true)
    setSyncNote(null)
    try {
      const result = await window.codey.browser.profiles.syncFromChrome(state.url)
      if (!result.ok) {
        setLocalError(result.error)
        return
      }
      setLocalError(null)
      setSyncNote(`Synced ${result.data.cookieCount} cookies for ${result.data.origin} into "${result.data.profileName}"`)
      await refreshProfiles()
      await run(() => window.codey.browser.reload())
    } finally {
      setSyncBusy(false)
    }
  }

  useEffect(() => {
    if (!syncNote) return
    const timer = setTimeout(() => setSyncNote(null), 6000)
    return () => clearTimeout(timer)
  }, [syncNote])

  const navigate = async () => {
    const next = unwrapResult(await window.codey.browser.navigate(address))
    if (next) setState(next)
  }

  const run = async (operation: () => Promise<{ ok: true; data: BrowserState } | { ok: false; error: string }>) => {
    const next = unwrapResult(await operation())
    if (next) {
      setState(next)
      if (!addressFocusedRef.current) setAddress(next.url)
      const tabResult = await window.codey.browser.tabs()
      if (tabResult.ok) setTabs(tabResult.data)
    }
  }

  const displayedError = localError ?? state.error
  const secure = state.url.startsWith('https://')
  const enabledProfiles = profiles.filter(profile => profile.active)
  const currentProfile = profiles.find(profile => profile.name === activeProfile)
  const profileLabel = enabledProfiles.length === 0
    ? 'No profile'
    : enabledProfiles.length === 1 ? enabledProfiles[0].name : `${enabledProfiles.length} profiles`

  const sendPageToChat = async () => {
    if (!chatId) return
    const context = unwrapResult(await window.codey.browser.getPageContext())
    if (!context) return
    appendDraftText(chatId, buildBrowserContextPrompt(context))
    onClose()
  }

  const updateControlPermission = async (
    operation: () => Promise<{ ok: true; data: BrowserControlPermissionState } | { ok: false; error: string }>,
  ) => {
    const next = unwrapResult(await operation())
    if (next) setControlPermission(next)
  }

  const updateSitePermission = async (
    operation: () => Promise<{ ok: true; data: BrowserSitePermissionState } | { ok: false; error: string }>,
  ) => {
    const next = unwrapResult(await operation())
    if (next) setSitePermission(next)
  }

  const resetBrowserSession = async () => {
    setResetBusy(true)
    try {
      const next = unwrapResult(await window.codey.browser.resetSession())
      if (!next) return
      setState(next)
      setAddress(next.url)
      setLatestDownload(null)
      setResetConfirmation(false)
      const host = hostRef.current
      if (host) {
        const shown = unwrapResult(await window.codey.browser.show(rectToBounds(host.getBoundingClientRect())))
        if (shown) setState(shown)
      }
      const tabResult = await window.codey.browser.tabs()
      if (tabResult.ok) setTabs(tabResult.data)
    } finally {
      setResetBusy(false)
    }
  }

  const openSettingsSection = (section: BrowserSettingsSection) => {
    setSettingsTabOpen(true)
    setLastSettingsSection(section)
    setActiveSettingsSection(section)
    setBrowserMenuOpen(false)
  }

  const openExtensions = async () => {
    openSettingsSection('extensions')
    setExtensionCandidate(null)
    const next = unwrapResult(await window.codey.browser.extensions.list())
    if (next) setExtensions(next)
  }

  const openProfiles = () => {
    openSettingsSection('profiles')
  }

  const showWebTab = async (operation: () => Promise<{ ok: true; data: BrowserState } | { ok: false; error: string }>) => {
    setActiveSettingsSection(null)
    await run(operation)
  }

  const closeSettingsTab = () => {
    setSettingsTabOpen(false)
    setActiveSettingsSection(null)
  }

  const pickExtension = async () => {
    setExtensionBusy(true)
    try {
      const candidate = unwrapResult(await window.codey.browser.extensions.pick())
      if (candidate) setExtensionCandidate(candidate)
    } finally {
      setExtensionBusy(false)
    }
  }

  const discoverChromeExtensions = async () => {
    setExtensionBusy(true)
    try {
      const candidates = unwrapResult(await window.codey.browser.extensions.discoverChrome())
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
      const next = unwrapResult(await window.codey.browser.extensions.importFromChrome(candidate.path))
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
      const next = unwrapResult(await window.codey.browser.extensions.install(extensionCandidate.path))
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
      const next = unwrapResult(await operation())
      if (next) setExtensions(next)
    } finally {
      setExtensionBusy(false)
    }
  }

  const pendingDomain = (() => {
    try { return controlPermission.pending ? new URL(controlPermission.pending.url).hostname : '' }
    catch { return controlPermission.pending?.url || '' }
  })()

  const compactSettings = panelWidth < 700
  const narrowSettings = panelWidth < 480
  const settingsContentTop = compactSettings ? 138 : 82
  const settingsSidebarStyle: React.CSSProperties = compactSettings
    ? { ...styles.settingsSidebar, inset: '82px 0 auto 0', width: 'auto', height: 56, padding: '9px 12px', flexDirection: 'row', alignItems: 'center', gap: 6, borderRight: 'none', borderBottom: `1px solid ${C.border}` }
    : styles.settingsSidebar
  const settingsPanelStyle: React.CSSProperties = {
    inset: `${settingsContentTop}px 0 0 ${compactSettings ? 0 : 216}px`,
    padding: narrowSettings ? '18px 14px 28px' : '28px clamp(22px, 5vw, 56px) 40px',
  }

  return (
    <section ref={rootRef} style={styles.root} aria-label="Codey Browser">
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
          <span style={{ ...styles.security, color: activeSettingsSection ? C.accent : secure ? C.green : C.fg3 }} title={activeSettingsSection ? 'Codey browser page' : secure ? 'Secure connection' : 'Connection information'}>
            {activeSettingsSection ? '◆' : secure ? '●' : '○'}
          </span>
          <input
            value={activeSettingsSection ? SETTINGS_SECTIONS[activeSettingsSection].url : address}
            onChange={event => setAddress(event.target.value)}
            onFocus={event => { addressFocusedRef.current = true; event.currentTarget.select() }}
            onBlur={() => { addressFocusedRef.current = false }}
            readOnly={activeSettingsSection !== null}
            placeholder="Search or enter an address"
            aria-label="Browser address"
            spellCheck={false}
            autoCapitalize="none"
            style={styles.address}
          />
          {state.loading && <span style={styles.loadingDot} aria-label="Loading" />}
        </form>

        <button
          ref={profileButtonRef}
          type="button"
          style={{ ...styles.profileButton, ...(profileMenuOpen ? styles.profileButtonActive : null) }}
          title={enabledProfiles.length > 0
            ? `Browser profiles in use: ${enabledProfiles.map(profile => profile.name).join(', ')} — click to change`
            : 'No browser profile active — click to pick one'}
          aria-label="Browser profile"
          aria-haspopup="menu"
          aria-expanded={profileMenuOpen}
          onClick={() => {
            setProfileMenuOpen(current => {
              if (!current) void refreshProfiles()
              return !current
            })
          }}
        >
          <span aria-hidden="true" style={styles.profileAvatarSmall}>{browserProfileAvatar(currentProfile)}</span>
          {panelWidth >= 640 && <span style={styles.profileButtonLabel}>{profileLabel}</span>}
        </button>
        <button
          type="button"
          style={{ ...styles.iconButton, ...(syncBusy ? styles.iconButtonActive : null) }}
          title={activeProfile
            ? `Sync this site's Chrome login into "${activeProfile}"`
            : 'Enable a browser profile first, then sync this site\u2019s Chrome login into it'}
          aria-label="Sync this site's login from Chrome"
          disabled={syncBusy || !state.url || !activeProfile || activeSettingsSection !== null}
          onClick={() => void syncProfileFromChrome()}
        ><UIIcon name="refresh" size={14} /></button>
        <button
          type="button"
          style={{ ...styles.contextButton, opacity: chatId && state.url && !activeSettingsSection ? 1 : 0.5 }}
          title={chatId ? 'Add this page and its performance timing to the current chat' : 'Select a chat first'}
          disabled={!chatId || !state.url || activeSettingsSection !== null}
          onClick={() => void sendPageToChat()}
        >
          <UIIcon name="sparkle" size={14} />
          {!embedded && <span>Use in chat</span>}
        </button>
        <button
          ref={menuButtonRef}
          type="button"
          style={{ ...styles.iconButton, ...(browserMenuOpen ? styles.iconButtonActive : null) }}
          title="More browser actions"
          aria-label="More browser actions"
          aria-haspopup="menu"
          aria-expanded={browserMenuOpen}
          onClick={() => setBrowserMenuOpen(current => !current)}
        ><UIIcon name="more" size={15} /></button>
        {!embedded && <button type="button" style={styles.closeButton} onClick={onClose} title="Close browser" aria-label="Close browser">
          <UIIcon name="close" size={15} />
        </button>}
      </div>

      {profileMenuOpen && (
        <div ref={profileMenuRef} style={styles.profileMenu} role="menu" aria-label="Browser profiles">
          <div style={styles.profileMenuHeading}>Profiles in use</div>
          {profiles.length === 0 && (
            <div style={styles.profileMenuEmpty}>No profiles saved yet.</div>
          )}
          {profiles.map(profile => (
            <div key={profile.name} style={styles.profileMenuRow}>
              <button
                type="button"
                role="menuitemcheckbox"
                aria-checked={profile.active}
                disabled={profileBusy}
                style={{ ...styles.menuButton, flex: 1, ...(profile.active ? styles.profileMenuItemActive : null) }}
                onClick={() => void toggleProfile(profile.name, profile.active)}
              >
                <span aria-hidden="true" style={styles.profileMenuAvatar}>{browserProfileAvatar(profile)}</span>
                <span style={styles.profileMenuName}>{profile.name}</span>
                <span aria-hidden="true" style={styles.profileMenuCheck}>{profile.active ? '✓' : ''}</span>
              </button>
              <button
                type="button"
                style={styles.profileMenuSync}
                disabled={profileBusy}
                title={`Refresh every login in ${profile.name} from Chrome`}
                aria-label={`Refresh ${profile.name} from Chrome`}
                onClick={() => void syncProfile(profile.name)}
              ><UIIcon name="refresh" size={12} /></button>
            </div>
          ))}
          {enabledProfiles.length > 1 && (
            <div style={styles.profileMenuNote}>
              The browser is carrying all {enabledProfiles.length} logins at once.
            </div>
          )}
          <div style={styles.profileMenuDivider} />
          <button type="button" style={styles.menuButton} onClick={() => { setProfileMenuOpen(false); openProfiles() }}>
            <UIIcon name="settings" size={13} /> Manage profiles…
          </button>
        </div>
      )}

      {browserMenuOpen && (
        <div ref={menuRef} style={styles.browserMenu} role="menu" aria-label="Browser actions">
          <button type="button" style={styles.menuButton} onClick={() => { setBrowserMenuOpen(false); void openExtensions() }}>
            <span aria-hidden="true">⊞</span> Extensions
          </button>
          <button type="button" style={styles.menuButton} onClick={() => { setBrowserMenuOpen(false); openProfiles() }}>
            <UIIcon name="users" size={13} /> Profiles
          </button>
          <button type="button" style={styles.menuButton} disabled={!state.url || activeSettingsSection !== null} onClick={() => { setBrowserMenuOpen(false); if (state.url && !activeSettingsSection) void window.codey.openExternal(state.url) }}>
            <span aria-hidden="true">↗</span> Open externally
          </button>
          {(['browser', 'chrome'] as const).map(surface => {
            const grant = controlPermission.granted[surface]
            const label = surface === 'browser' ? 'this browser' : 'Chrome'
            return (
              <button
                key={surface}
                type="button"
                style={{ ...styles.menuButton, ...(grant !== 'none' ? styles.menuButtonWarning : null) }}
                onClick={() => {
                  setBrowserMenuOpen(false)
                  if (grant !== 'none') void updateControlPermission(() => window.codey.browser.controlPermission.revoke(surface))
                }}
              >
                <span aria-hidden="true">{grant === 'none' ? '○' : '●'}</span>
                {grant === 'none'
                  ? `Agent access to ${label}: view only`
                  : `Revoke ${grant === 'full' ? 'full' : 'write'} access to ${label}`}
              </button>
            )
          })}
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
            aria-selected={tab.active && activeSettingsSection === null}
            title={tab.title || tab.url || 'New tab'}
            style={{ ...styles.tab, ...(tab.active && activeSettingsSection === null ? styles.activeTab : null) }}
            onClick={() => void showWebTab(() => window.codey.browser.switchTab(tab.id))}
            onKeyDown={event => {
              if (event.key === 'Enter' || event.key === ' ') void showWebTab(() => window.codey.browser.switchTab(tab.id))
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
        {settingsTabOpen && (
          <div
            role="tab"
            tabIndex={0}
            aria-selected={activeSettingsSection !== null}
            title="Browser settings"
            style={{ ...styles.tab, ...(activeSettingsSection !== null ? styles.activeTab : null) }}
            onClick={() => setActiveSettingsSection(lastSettingsSection)}
            onKeyDown={event => {
              if (event.key === 'Enter' || event.key === ' ') setActiveSettingsSection(lastSettingsSection)
            }}
          >
            <span style={styles.tabTitle}>Browser settings</span>
            <button
              type="button"
              aria-label="Close browser settings"
              style={styles.tabClose}
              onClick={event => { event.stopPropagation(); closeSettingsTab() }}
            >×</button>
          </div>
        )}
        <button
          type="button"
          style={styles.newTabButton}
          title="New tab"
          aria-label="New tab"
          onClick={() => void showWebTab(() => window.codey.browser.newTab())}
        >+</button>
      </div>

      {activeSettingsSection !== null && (
        <aside style={settingsSidebarStyle} aria-label="Browser settings sections">
          {!compactSettings && <div style={styles.settingsSidebarTitle}>Browser settings</div>}
          <button
            type="button"
            style={{ ...styles.settingsNavButton, ...(compactSettings ? styles.settingsNavButtonCompact : null), ...(activeSettingsSection === 'extensions' ? styles.settingsNavButtonActive : null) }}
            aria-current={activeSettingsSection === 'extensions' ? 'page' : undefined}
            onClick={() => void openExtensions()}
          >
            <span aria-hidden="true">⊞</span> Extensions
          </button>
          <button
            type="button"
            style={{ ...styles.settingsNavButton, ...(compactSettings ? styles.settingsNavButtonCompact : null), ...(activeSettingsSection === 'profiles' ? styles.settingsNavButtonActive : null) }}
            aria-current={activeSettingsSection === 'profiles' ? 'page' : undefined}
            onClick={openProfiles}
          >
            <UIIcon name="users" size={14} /> Profiles
          </button>
        </aside>
      )}

      {activeSettingsSection === 'extensions' && (
        <div style={{ ...styles.settingsPanel, ...settingsPanelStyle }} aria-label="Browser extensions">
          <div style={styles.settingsContent}>
          <div style={styles.settingsPageHeader}>
            <div style={styles.settingsPageIcon}><UIIcon name="tools" size={20} /></div>
            <div>
              <div style={styles.settingsPageTitle}>Extensions</div>
              <div style={styles.extensionsCopy}>Install in Chrome first, then import a compatible copy into Codey. Chrome Web Store buttons cannot install directly into Electron.</div>
            </div>
          </div>
            <div style={{ ...styles.extensionsActions, ...(narrowSettings ? styles.extensionsActionsNarrow : null) }}>
              <button
                type="button"
                style={{ ...styles.secondaryButton, ...(narrowSettings ? styles.responsiveActionButton : null) }}
                onClick={() => void window.codey.openExternal('https://chromewebstore.google.com/category/extensions')}
              >View Web Store ↗</button>
              <button type="button" style={{ ...styles.primaryButton, ...(narrowSettings ? styles.responsiveActionButton : null) }} disabled={extensionBusy} onClick={() => void discoverChromeExtensions()}>
                {chromeScanComplete ? 'Scan Chrome again' : 'Import from Chrome'}
              </button>
              <button type="button" style={{ ...styles.secondaryButton, ...(narrowSettings ? styles.responsiveActionButton : null) }} disabled={extensionBusy} onClick={() => void pickExtension()}>
                Load unpacked
              </button>
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
            <div key={`${candidate.profile}:${candidate.extensionId}`} style={{ ...styles.extensionRow, ...(narrowSettings ? styles.extensionRowNarrow : null) }}>
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
            <div key={extension.key} style={{ ...styles.extensionRow, ...(narrowSettings ? styles.extensionRowNarrow : null) }}>
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
        </div>
      )}

      {activeSettingsSection === 'profiles' && (
        <div style={{ ...styles.settingsPanel, ...settingsPanelStyle }} aria-label="Browser profiles">
          <div style={styles.settingsContent}>
          <div style={styles.settingsPageHeader}>
            <div style={styles.settingsPageIcon}><UIIcon name="users" size={20} /></div>
            <div>
              <div style={styles.settingsPageTitle}>Profiles</div>
              <div style={styles.extensionsCopy}>Manage saved browser sessions, cookies, and site storage.</div>
            </div>
          </div>
          <BrowserProfiles compact={narrowSettings} />
          </div>
        </div>
      )}

      {controlPermission.pending && (
        <div style={styles.permissionPrompt} role="alertdialog" aria-label="Agent browser control permission">
          <div style={styles.permissionPromptIcon}><UIIcon name="bot" size={18} /></div>
          <div style={styles.permissionPromptText}>
            <div style={styles.permissionPromptTitle}>
              {controlPermission.pending.surface === 'chrome'
                ? 'Allow the agent to act in your Chrome?'
                : 'Allow the agent to control this browser?'}
            </div>
            <div style={styles.permissionPromptCopy}>
              The agent wants to <strong>{controlPermission.pending.command}</strong>{pendingDomain ? ` on ${pendingDomain}` : ''}.
              {' '}Write access allows clicking, typing, submitting forms and acting through your signed-in accounts.
              Full access also allows deleting saved profiles and replacing the live session.
              {controlPermission.pending.surface === 'chrome'
                ? ' This applies to your real Chrome only, not Codey\u2019s browser.'
                : ' This applies to Codey\u2019s browser only, not your real Chrome.'}
            </div>
          </div>
          <button
            type="button"
            style={styles.denyButton}
            onClick={() => void updateControlPermission(window.codey.browser.controlPermission.deny)}
          >Not now</button>
          {controlPermission.pending.level === 'write' && (
            <button
              type="button"
              style={styles.approveButton}
              onClick={() => void updateControlPermission(() => window.codey.browser.controlPermission.approve('write'))}
            >Allow write</button>
          )}
          <button
            type="button"
            style={styles.approveButton}
            onClick={() => void updateControlPermission(() => window.codey.browser.controlPermission.approve('full'))}
          >Allow full access</button>
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

      {syncNote && !displayedError && (
        <div style={styles.syncBar} role="status">
          <span>{syncNote}</span>
          <button type="button" onClick={() => setSyncNote(null)} style={styles.dismissError}>Dismiss</button>
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

      <div ref={hostRef} data-codey-browser-host style={styles.host}>
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
  root: { position: 'relative', flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: C.bg },
  toolbar: { height: 48, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 7, padding: '7px 10px', background: C.surface, borderBottom: `1px solid ${C.border}` },
  compactToolbar: { gap: 4, padding: '7px 6px' },
  browserMenu: {
    position: 'absolute', top: 43, right: 8, zIndex: 20, width: 230,
    display: 'flex', flexDirection: 'column', gap: 2, padding: 6,
    background: C.surface2, border: `1px solid ${C.border2}`, borderRadius: 10,
    boxShadow: '0 12px 30px rgba(0,0,0,0.32)',
  },
  menuButton: {
    width: '100%', minHeight: 32, display: 'flex', alignItems: 'center', gap: 8,
    padding: '0 9px', border: 'none', borderRadius: 6, background: 'transparent',
    color: C.fg2, cursor: 'pointer', fontSize: 11, textAlign: 'left', whiteSpace: 'nowrap',
  },
  menuButtonWarning: { color: C.warningFg, background: C.warningBg },
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
  profileButton: {
    height: 31, maxWidth: 150, padding: '0 9px', border: `1px solid ${C.border}`, borderRadius: 7,
    display: 'flex', alignItems: 'center', gap: 6, background: C.surface2, color: C.fg2,
    cursor: 'pointer', fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap',
  },
  profileButtonActive: { background: C.accentDim, color: C.accent, borderColor: `${C.accent}66` },
  profileButtonLabel: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  profileAvatarSmall: { width: 17, textAlign: 'center', fontSize: 14, lineHeight: 1 },
  profileMenu: {
    position: 'absolute', top: 43, right: 8, zIndex: 20, width: 230,
    display: 'flex', flexDirection: 'column', gap: 2, padding: 6,
    background: C.surface2, border: `1px solid ${C.border2}`, borderRadius: 10,
    boxShadow: '0 12px 30px rgba(0,0,0,0.32)',
  },
  profileMenuHeading: { padding: '4px 9px', color: C.fg3, fontSize: 10, fontWeight: 700, letterSpacing: 0.4, textTransform: 'uppercase' },
  profileMenuEmpty: { padding: '4px 9px 8px', color: C.fg3, fontSize: 11 },
  profileMenuItemActive: { color: C.accent },
  profileMenuCheck: { width: 12, flexShrink: 0, textAlign: 'center' },
  profileMenuAvatar: { width: 20, flexShrink: 0, textAlign: 'center', fontSize: 15 },
  profileMenuName: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  profileMenuRow: { display: 'flex', alignItems: 'center', gap: 2 },
  profileMenuSync: { flexShrink: 0, display: 'flex', alignItems: 'center', marginRight: 4, padding: '3px 6px', border: 'none', borderRadius: 6, background: 'transparent', color: C.fg3, cursor: 'pointer' },
  profileMenuNote: { padding: '4px 10px 6px', color: C.fg3, fontSize: 10, lineHeight: 1.4 },
  profileMenuDivider: { height: 1, margin: '4px 0', background: C.border },
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
  settingsSidebar: { position: 'absolute', inset: '82px auto 0 0', zIndex: 4, width: 216, padding: '24px 14px', display: 'flex', flexDirection: 'column', background: C.surface, borderRight: `1px solid ${C.border}` },
  settingsSidebarTitle: { padding: '0 10px 14px', color: C.fg3, fontSize: 10, fontWeight: 750, textTransform: 'uppercase', letterSpacing: 0.8 },
  settingsNavButton: { width: '100%', minHeight: 38, display: 'flex', alignItems: 'center', gap: 10, padding: '0 11px', border: '1px solid transparent', borderRadius: 9, background: 'transparent', color: C.fg2, cursor: 'pointer', fontSize: 12, textAlign: 'left' },
  settingsNavButtonCompact: { width: 'auto', flex: 1, justifyContent: 'center', minHeight: 36, padding: '0 12px' },
  settingsNavButtonActive: { color: C.accent, background: C.accentDim, fontWeight: 700 },
  settingsPanel: { position: 'absolute', zIndex: 3, overflowY: 'auto', background: C.bg },
  settingsContent: { width: '100%', maxWidth: 900, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 20 },
  settingsPageHeader: { display: 'flex', alignItems: 'center', gap: 14 },
  settingsPageIcon: { width: 42, height: 42, flexShrink: 0, display: 'grid', placeItems: 'center', borderRadius: 12, color: C.accent, background: C.accentDim, border: `1px solid ${C.accent}44` },
  settingsPageTitle: { color: C.fg, fontSize: 20, lineHeight: 1.2, fontWeight: 750 },
  extensionsCopy: { maxWidth: 620, color: C.fg3, fontSize: 11.5, lineHeight: 1.5, marginTop: 3 },
  extensionsActions: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8, padding: 12, borderRadius: 11, background: C.surface, border: `1px solid ${C.border}` },
  extensionsActionsNarrow: { alignItems: 'stretch' },
  responsiveActionButton: { flex: '1 1 140px' },
  primaryButton: { minHeight: 29, padding: '0 10px', border: `1px solid ${C.accent}`, borderRadius: 7, background: C.accent, color: C.onAccent, cursor: 'pointer', fontSize: 10.5, fontWeight: 700, whiteSpace: 'nowrap' },
  secondaryButton: { minHeight: 29, padding: '0 10px', border: `1px solid ${C.border2}`, borderRadius: 7, background: C.surface2, color: C.fg2, cursor: 'pointer', fontSize: 10.5, whiteSpace: 'nowrap' },
  smallButton: { minHeight: 25, padding: '0 8px', border: `1px solid ${C.border}`, borderRadius: 6, background: C.surface2, color: C.fg2, cursor: 'pointer', fontSize: 10 },
  extensionsEmpty: { padding: '18px 20px', color: C.fg3, background: C.surface, border: `1px dashed ${C.border2}`, borderRadius: 11, fontSize: 11.5, lineHeight: 1.5 },
  extensionReview: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8, padding: 12, background: C.surface, border: `1px solid ${C.accent}66`, borderRadius: 11 },
  extensionReviewBody: { flex: 1, minWidth: 0 },
  extensionSectionLabel: { marginTop: 11, color: C.fg2, fontSize: 10, fontWeight: 750, textTransform: 'uppercase', letterSpacing: 0.5 },
  extensionRow: { display: 'flex', alignItems: 'center', gap: 8, padding: '11px 12px', background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10 },
  extensionRowNarrow: { flexWrap: 'wrap', alignItems: 'center' },
  extensionStatusIcon: { width: 15, flexShrink: 0, color: C.green, fontSize: 9, textAlign: 'center' },
  extensionInfo: { flex: 1, minWidth: 0 },
  extensionName: { color: C.fg, fontSize: 11.5, fontWeight: 700 },
  extensionVersion: { color: C.fg3, fontSize: 9.5, fontWeight: 500 },
  extensionDescription: { color: C.fg2, fontSize: 10.5, lineHeight: 1.35, marginTop: 2 },
  extensionAccess: { color: C.fg2, fontSize: 10, lineHeight: 1.35, marginTop: 5, overflowWrap: 'anywhere' },
  extensionWarning: { color: C.warningFg, fontSize: 9.5, lineHeight: 1.35, marginTop: 3 },
  extensionPath: { color: C.fg3, fontSize: 9.5, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  extensionError: { color: C.red, fontSize: 9.5, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  syncBar: { minHeight: 30, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '5px 12px', background: `${C.green}18`, color: C.green, borderBottom: `1px solid ${C.green}55`, fontSize: 11 },
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
