import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  BrowserWindow,
  session,
  WebContentsView,
  type Session,
  type WebContents,
} from 'electron'
import type { BrowserSitePermissionDetails, BrowserSitePermissionManager } from './browser-site-permissions'
import {
  assertProfileName,
  BrowserProfileStore,
  conflictingCookie,
  cookieMatchesUrl,
  mergeProfileData,
  mergeProfileSites,
  parseProfileJsonText,
  readProfileJson,
  type BrowserProfile,
  type BrowserProfileCookie,
  type BrowserProfileData,
  type BrowserProfileStorageOrigin,
  type BrowserProfileSummary,
} from './browser-profiles'

export const BROWSER_PARTITION = 'persist:codey-browser'

export interface BrowserBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface BrowserState {
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  error: string | null
}

export interface BrowserPageContext {
  url: string
  title: string
  description: string
  text: string
  performance: {
    domContentLoadedMs: number | null
    loadMs: number | null
    transferBytes: number | null
  }
}

export interface BrowserInteractiveElement {
  ref: string
  tag: string
  role: string
  label: string
  type: string
  value?: string
  checked?: boolean
  disabled: boolean
}

export interface BrowserInteractiveSnapshot {
  url: string
  title: string
  elements: BrowserInteractiveElement[]
  viewport: BrowserViewport
}

export interface BrowserViewport {
  width: number
  height: number
  deviceScaleFactor: number
}

export interface BrowserActionResult {
  ok: true
  url: string
  message: string
}

/** Seams for deterministic, fast tests of the humanized input timing. */
export interface HumanInputOptions {
  random?: () => number
  sleep?: (ms: number) => Promise<void>
}

/** Constructor seams for the browser profile feature: where profile files live
 *  (defaults to a temp dir so the controller works without the app), and a
 *  factory for the hidden page used to apply localStorage of origins that are
 *  not currently open (injectable so tests need no real Electron). */
export interface BrowserControllerOptions extends HumanInputOptions {
  getProfilesDir?: () => string
  createHiddenView?: () => WebContentsView
}

export interface BrowserWaitRequest {
  kind: 'ref' | 'text' | 'url' | 'title'
  value: string
  state?: 'visible' | 'hidden' | 'enabled'
  timeoutMs?: number
}

export interface BrowserDownload {
  id: string
  name: string
  path: string
  url: string
  status: 'progressing' | 'completed' | 'cancelled' | 'interrupted'
  receivedBytes: number
  totalBytes: number
  startedAt: number
  finishedAt?: number
}

export interface BrowserTab {
  id: string
  title: string
  url: string
  active: boolean
}

/** Privacy-preserving signals used to detect when an authentication wall changes. */
export interface BrowserLoginStatus {
  tabId: string
  url: string
  title: string
  loading: boolean
  authLikely: boolean
  loggedInLikely: boolean
  /** Opaque page-state fingerprint. It never contains field values or page text. */
  statusKey: string
}

interface BrowserTabRecord {
  id: string
  view: WebContentsView
}

const EMPTY_STATE: BrowserState = {
  url: '',
  title: 'New tab',
  loading: false,
  canGoBack: false,
  canGoForward: false,
  error: null,
}

/** Convert address-bar input into a safe browser URL. */
export function normalizeBrowserUrl(input: string): string {
  const value = input.trim()
  if (!value) return 'about:blank'

  const search = () => `https://www.google.com/search?q=${encodeURIComponent(value)}`

  if (/\s/.test(value)) {
    return search()
  }

  let candidate = value
  const local = /^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/|$)/i.test(candidate)
  // `localhost:5173` resembles a custom URL scheme to URL parsers, so local
  // development addresses must be detected before the generic scheme check.
  if (local) {
    candidate = `http://${candidate}`
  } else if (!/^[a-z][a-z\d+.-]*:/i.test(candidate)) {
    // Match omnibox behavior: a bare word is a search, while a dotted host is
    // treated as an address. This also prevents non-Latin search queries from
    // being converted to nonexistent punycode hostnames.
    const host = candidate.split(/[/?#]/, 1)[0]
    if (!host.includes('.') && !/^\[[0-9a-f:]+\](?::\d+)?$/i.test(host)) return search()
    candidate = `https://${candidate}`
  }

  const parsed = new URL(candidate)
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:' && parsed.protocol !== 'about:') {
    throw new Error('Only HTTP and HTTPS pages can be opened in Codey Browser')
  }
  if (parsed.protocol === 'about:' && parsed.href !== 'about:blank') {
    throw new Error('Only about:blank is allowed')
  }
  return parsed.href
}

const MUTATING_NAVIGATION = /(^|[\/_?&=.-])(logout|log-out|signout|sign-out|delete|remove|unsubscribe|subscribe|purchase|checkout|pay|confirm|like|follow|bookmark|favorite|vote|join|leave|create|update)([\/_?&=.-]|$)/i

/** True only for direct page loads that are safe to perform in view-only mode. */
export function isSafeBrowserNavigationUrl(input: string): boolean {
  try {
    const url = new URL(input)
    return (url.protocol === 'http:' || url.protocol === 'https:')
      && !MUTATING_NAVIGATION.test(url.pathname + url.search)
  } catch {
    return false
  }
}

/**
 * The renderer measures the browser slot with getBoundingClientRect, which is
 * CSS px inside a window that may be zoomed. The native view is
 * laid out in the window's own units, so every incoming rect has to be scaled
 * by the same zoom factor or the browser drifts out of its slot.
 */
export function sanitizeBounds(bounds: BrowserBounds, win: BrowserWindow, zoom = 1): BrowserBounds {
  const content = win.getContentBounds()
  const scale = Number.isFinite(zoom) && zoom > 0 ? zoom : 1
  const x = Math.max(0, Math.round((Number(bounds.x) || 0) * scale))
  const y = Math.max(0, Math.round((Number(bounds.y) || 0) * scale))
  return {
    x,
    y,
    width: Math.max(0, Math.min(Math.round((Number(bounds.width) || 0) * scale), content.width - x)),
    height: Math.max(0, Math.min(Math.round((Number(bounds.height) || 0) * scale), content.height - y)),
  }
}

/**
 * Owns the native browser surface. The view is created lazily and detached
 * when hidden, while its persistent Electron partition keeps login state on
 * disk across app launches.
 */
export class BrowserController {
  private view: WebContentsView | null = null
  private tabs: BrowserTabRecord[] = []
  private tabSequence = 0
  private attachedTo: BrowserWindow | null = null
  private lastBounds: BrowserBounds | null = null
  /** Main-window zoom factor; lastBounds arrives in the renderer's CSS px. */
  private zoom = 1
  private state: BrowserState = { ...EMPTY_STATE }
  private downloads: BrowserDownload[] = []
  private downloadSessionBound = false
  private permissionSessionBound = false
  private downloadWaiters: Array<(download: BrowserDownload) => void> = []
  private downloadSequence = 0
  private sitePermissionManager: BrowserSitePermissionManager | null = null
  /** Last synthesized cursor position, so each move starts where the last ended. */
  private pointer: { x: number; y: number } | null = null
  private readonly random: () => number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly getProfilesDir: () => string
  private readonly createHiddenView?: () => WebContentsView
  private profileStore: BrowserProfileStore | null = null
  private profileStoreDir: string | null = null

  constructor(
    private readonly getWindow: () => BrowserWindow | null,
    private readonly onState: (state: BrowserState) => void,
    private readonly onDownload: (download: BrowserDownload) => void = () => {},
    private readonly getDownloadDirectory: () => string = () => path.join(os.tmpdir(), 'codey-downloads'),
    private readonly getBrowserSession: () => Session = () => session.fromPartition(BROWSER_PARTITION, { cache: true }),
    options: BrowserControllerOptions = {},
  ) {
    this.random = options.random ?? Math.random
    this.sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)))
    this.getProfilesDir = options.getProfilesDir ?? (() => path.join(os.tmpdir(), 'codey-browser-profiles'))
    // Hidden page used to apply a profile's localStorage for origins that are
    // not currently open in a tab. Shares the browser's persistent partition,
    // so it reads and writes the same storage the visible tabs use.
    this.createHiddenView = options.createHiddenView ?? (() => new WebContentsView({
      webPreferences: {
        partition: BROWSER_PARTITION,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        backgroundThrottling: false,
      },
    }))
  }

  private profiles(): BrowserProfileStore {
    const dir = this.getProfilesDir()
    if (!this.profileStore || this.profileStoreDir !== dir) {
      this.profileStore = new BrowserProfileStore(dir)
      this.profileStoreDir = dir
    }
    return this.profileStore
  }

  setSitePermissionManager(manager: BrowserSitePermissionManager): void {
    this.sitePermissionManager = manager
    const browserSession = this.getBrowserSession()
    this.bindSitePermissions(browserSession)
  }

  getState(): BrowserState {
    return { ...this.state }
  }

  listTabs(): BrowserTab[] {
    return this.tabs.map(tab => ({
      id: tab.id,
      title: tab.view.webContents.getTitle() || 'New tab',
      url: tab.view.webContents.getURL() === 'about:blank' ? '' : tab.view.webContents.getURL(),
      active: tab.view === this.view,
    }))
  }

  async newTab(input = 'about:blank'): Promise<BrowserState> {
    const url = normalizeBrowserUrl(input)
    const tab = this.createTab(true)
    if (url !== 'about:blank') await tab.view.webContents.loadURL(url)
    return this.refreshState()
  }

  switchTab(id: string): BrowserState {
    const tab = this.tabs.find(candidate => candidate.id === id)
    if (!tab) throw new Error('Browser tab not found')
    if (tab.view === this.view) return this.refreshState()
    const win = this.attachedTo
    this.detach()
    this.view = tab.view
    this.state = { ...EMPTY_STATE }
    if (win && !win.isDestroyed()) {
      win.contentView.addChildView(tab.view)
      this.attachedTo = win
      if (this.lastBounds) tab.view.setBounds(sanitizeBounds(this.lastBounds, win, this.zoom))
    }
    return this.refreshState()
  }

  closeTab(id: string): BrowserState {
    const index = this.tabs.findIndex(candidate => candidate.id === id)
    if (index < 0) throw new Error('Browser tab not found')
    const [tab] = this.tabs.splice(index, 1)
    const wasActive = tab.view === this.view
    const win = wasActive ? this.attachedTo : null
    if (wasActive) this.detach()
    if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close({ waitForBeforeUnload: false })
    if (wasActive) {
      const next = this.tabs[Math.min(index, this.tabs.length - 1)] ?? this.createTab(false)
      if (!next.view.webContents.getURL()) {
        void next.view.webContents.loadURL('about:blank').catch(() => {})
      }
      this.view = next.view
      this.state = { ...EMPTY_STATE }
      if (win && !win.isDestroyed()) {
        win.contentView.addChildView(next.view)
        this.attachedTo = win
        if (this.lastBounds) next.view.setBounds(sanitizeBounds(this.lastBounds, win, this.zoom))
      }
    }
    return this.refreshState()
  }

  show(bounds: BrowserBounds): BrowserState {
    const win = this.requireWindow()
    const view = this.ensureView()
    if (this.attachedTo !== win) {
      this.detach()
      win.contentView.addChildView(view)
      this.attachedTo = win
    }
    this.lastBounds = { ...bounds }
    view.setBounds(sanitizeBounds(bounds, win, this.zoom))
    return this.getState()
  }

  hide(): void {
    this.detach()
  }

  /**
   * Re-places the view when the window's zoom changes: the last bounds
   * were measured in the old scale, and the renderer may not re-measure.
   */
  setZoomFactor(zoom: number): void {
    const next = Number.isFinite(zoom) && zoom > 0 ? zoom : 1
    if (next === this.zoom) return
    this.zoom = next
    if (this.lastBounds && this.view && this.attachedTo && !this.attachedTo.isDestroyed()) {
      this.view.setBounds(sanitizeBounds(this.lastBounds, this.attachedTo, this.zoom))
    }
  }

  setBounds(bounds: BrowserBounds): void {
    this.lastBounds = { ...bounds }
    if (!this.view || !this.attachedTo) return
    this.view.setBounds(sanitizeBounds(bounds, this.attachedTo, this.zoom))
  }

  async navigate(input: string): Promise<BrowserState> {
    const url = normalizeBrowserUrl(input)
    const contents = this.ensureView().webContents
    this.patchState({ error: null })
    await contents.loadURL(url)
    return this.getState()
  }

  back(): BrowserState {
    const contents = this.view?.webContents
    if (contents?.canGoBack()) contents.goBack()
    return this.refreshState()
  }

  forward(): BrowserState {
    const contents = this.view?.webContents
    if (contents?.canGoForward()) contents.goForward()
    return this.refreshState()
  }

  reload(): BrowserState {
    this.view?.webContents.reload()
    return this.refreshState()
  }

  stop(): BrowserState {
    this.view?.webContents.stop()
    return this.refreshState()
  }

  async getPageContext(): Promise<BrowserPageContext> {
    const contents = this.view?.webContents
    if (!contents || contents.isDestroyed() || !contents.getURL() || contents.getURL() === 'about:blank') {
      throw new Error('Open a page before adding browser context')
    }
    // Only JSON-like scalar data crosses from the untrusted page into Codey.
    // Bounding visible text avoids accidentally feeding an entire application
    // shell or a huge document into an agent prompt.
    const result = await contents.executeJavaScript(`(() => {
      const nav = performance.getEntriesByType('navigation')[0]
      const text = (document.body?.innerText || '')
        .replace(/\\r/g, '')
        .replace(/[ \\t]+\\n/g, '\\n')
        .replace(/\\n{3,}/g, '\\n\\n')
        .trim()
        .slice(0, 20000)
      return {
        url: location.href,
        title: document.title || '',
        description: document.querySelector('meta[name="description"]')?.getAttribute('content') || '',
        text,
        performance: {
          domContentLoadedMs: nav ? Math.round(nav.domContentLoadedEventEnd) : null,
          loadMs: nav && nav.loadEventEnd ? Math.round(nav.loadEventEnd) : null,
          transferBytes: nav && typeof nav.transferSize === 'number' ? nav.transferSize : null,
        },
      }
    })()`, true) as BrowserPageContext

    return {
      url: String(result?.url || contents.getURL()),
      title: String(result?.title || contents.getTitle() || ''),
      description: String(result?.description || '').slice(0, 1000),
      text: String(result?.text || '').slice(0, 20000),
      performance: {
        domContentLoadedMs: Number.isFinite(result?.performance?.domContentLoadedMs) ? result.performance.domContentLoadedMs : null,
        loadMs: Number.isFinite(result?.performance?.loadMs) ? result.performance.loadMs : null,
        transferBytes: Number.isFinite(result?.performance?.transferBytes) ? result.performance.transferBytes : null,
      },
    }
  }

  async getLoginStatus(tabId?: string): Promise<BrowserLoginStatus> {
    const tab = tabId
      ? this.tabs.find(candidate => candidate.id === tabId)
      : this.tabs.find(candidate => candidate.view === this.view)
    if (!tab || tab.view.webContents.isDestroyed()) throw new Error('Browser tab is no longer available')
    const contents = tab.view.webContents
    if (!contents.getURL() || contents.getURL() === 'about:blank') throw new Error('Open the login page before waiting')

    // Only booleans, counts, URL/title, and an opaque hash cross the page
    // boundary. Login field values, cookies, storage, and page text are never
    // read. Requiring visible controls avoids hidden sign-in templates that
    // many authenticated single-page apps keep mounted in the DOM.
    const result = await contents.executeJavaScript(`(() => {
      const visible = el => {
        const rect = el.getBoundingClientRect()
        const style = getComputedStyle(el)
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
      }
      const controls = Array.from(document.querySelectorAll('input, button, a[href], [role="button"], [role="link"]')).filter(visible)
      const label = el => (el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || '').replace(/\\s+/g, ' ').trim().toLowerCase()
      const loginWords = /\\b(sign[ -]?in|log[ -]?in|continue with|authenticate|verification)\\b|\\u767b\\u5f55|\\u767b\\u5165|iniciar sesi[oó]n|connexion/i
      const logoutWords = /\\b(sign[ -]?out|log[ -]?out|my account|account menu|profile menu)\\b|\\u9000\\u51fa\\u767b\\u5f55|\\u767b\\u51fa/i
      const passwordFields = controls.filter(el => el instanceof HTMLInputElement && el.type === 'password').length
      const identityFields = controls.filter(el => el instanceof HTMLInputElement && (
        ['email', 'username'].includes(el.autocomplete) || el.type === 'email'
        || /email|user(name)?|phone|account|\\u90ae\\u7bb1|\\u7528\\u6237\\u540d/i.test(el.name + ' ' + el.id + ' ' + el.placeholder)
      )).length
      const loginActions = controls.filter(el => loginWords.test(label(el))).length
      const logoutActions = controls.filter(el => logoutWords.test(label(el))).length
      const authUrl = /(^|[./_-])(auth|login|signin|sign-in|oauth|sso|accounts)([./?_-]|$)/i.test(location.hostname + location.pathname)
      const profileControls = controls.filter(el => /profile|account|avatar/i.test(
        (el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('data-testid') || '') + ' ' + (el.getAttribute('href') || '')
      )).length
      const authLikely = passwordFields > 0 || authUrl || loginActions > 0 || (identityFields > 0 && !!document.querySelector('form'))
      const loggedInLikely = logoutActions > 0 || (!authLikely && profileControls > 0)
      const rawKey = JSON.stringify({
        origin: location.origin,
        path: location.pathname,
        title: document.title || '',
        passwordFields,
        identityFields,
        loginActions,
        logoutActions,
        profileControls,
        authLikely,
        loggedInLikely,
      })
      let hash = 2166136261
      for (let i = 0; i < rawKey.length; i += 1) {
        hash ^= rawKey.charCodeAt(i)
        hash = Math.imul(hash, 16777619)
      }
      return {
        url: location.href,
        title: document.title || '',
        authLikely,
        loggedInLikely,
        statusKey: (hash >>> 0).toString(16),
      }
    })()`, true) as Omit<BrowserLoginStatus, 'tabId' | 'loading'>

    return {
      tabId: tab.id,
      url: String(result?.url || contents.getURL()),
      title: String(result?.title || contents.getTitle() || ''),
      loading: contents.isLoading(),
      authLikely: !!result?.authLikely,
      loggedInLikely: !!result?.loggedInLikely,
      statusKey: String(result?.statusKey || ''),
    }
  }

  async capturePage(): Promise<Buffer> {
    const contents = this.view?.webContents
    if (!contents || contents.isDestroyed() || !contents.getURL() || contents.getURL() === 'about:blank') {
      throw new Error('Open a page before taking a browser screenshot')
    }
    const image = await contents.capturePage()
    return image.toPNG()
  }

  async getViewport(): Promise<BrowserViewport> {
    const contents = this.requirePage()
    const viewport = await contents.executeJavaScript(`({
      width: Math.max(0, Math.round(window.innerWidth || 0)),
      height: Math.max(0, Math.round(window.innerHeight || 0)),
      deviceScaleFactor: Number(window.devicePixelRatio) || 1,
    })`, true) as BrowserViewport
    return {
      width: Math.max(0, Math.round(Number(viewport?.width) || 0)),
      height: Math.max(0, Math.round(Number(viewport?.height) || 0)),
      deviceScaleFactor: Math.max(0.1, Number(viewport?.deviceScaleFactor) || 1),
    }
  }

  async snapshotInteractive(): Promise<BrowserInteractiveSnapshot> {
    const contents = this.requirePage()
    return await contents.executeJavaScript(`(() => {
      document.querySelectorAll('[data-codey-ref]').forEach(el => el.removeAttribute('data-codey-ref'))
      const selector = [
        'a[href]', 'button', 'input:not([type="hidden"])', 'textarea', 'select', 'form',
        '[role="button"]', '[role="link"]', '[role="checkbox"]', '[role="radio"]',
        '[role="tab"]', '[role="menuitem"]', '[contenteditable="true"]', '[tabindex]'
      ].join(',')
      const visible = el => {
        const rect = el.getBoundingClientRect()
        const style = getComputedStyle(el)
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
      }
      const labelFor = el => {
        const labelledBy = el.getAttribute('aria-labelledby')
        const labelledText = labelledBy
          ? labelledBy.split(/\\s+/).map(id => document.getElementById(id)?.textContent || '').join(' ')
          : ''
        const nativeLabels = el.labels ? Array.from(el.labels).map(label => label.innerText).join(' ') : ''
        return (el.getAttribute('aria-label') || labelledText || nativeLabels || el.getAttribute('placeholder')
          || el.getAttribute('title') || el.innerText || el.getAttribute('name') || '').replace(/\\s+/g, ' ').trim().slice(0, 300)
      }
      const nodes = Array.from(document.querySelectorAll(selector)).filter(visible).slice(0, 500)
      const elements = nodes.map((el, index) => {
        const ref = 'e' + (index + 1)
        el.setAttribute('data-codey-ref', ref)
        const input = el instanceof HTMLInputElement
        const select = el instanceof HTMLSelectElement
        const editable = el.getAttribute('contenteditable') === 'true'
        const isPassword = input && el.type === 'password'
        const value = isPassword ? undefined
          : input || el instanceof HTMLTextAreaElement || select ? el.value.slice(0, 300)
          : editable ? (el.innerText || '').slice(0, 300)
          : undefined
        return {
          ref,
          tag: el.tagName.toLowerCase(),
          role: el.getAttribute('role') || '',
          label: labelFor(el),
          type: input ? el.type : '',
          ...(value !== undefined ? { value } : {}),
          ...(input && (el.type === 'checkbox' || el.type === 'radio') ? { checked: el.checked } : {}),
          disabled: !!el.disabled || el.getAttribute('aria-disabled') === 'true',
        }
      })
      return {
        url: location.href,
        title: document.title || '',
        elements,
        viewport: {
          width: Math.max(0, Math.round(window.innerWidth || 0)),
          height: Math.max(0, Math.round(window.innerHeight || 0)),
          deviceScaleFactor: Number(window.devicePixelRatio) || 1,
        },
      }
    })()`, true) as BrowserInteractiveSnapshot
  }

  /**
   * Follow an ordinary HTTP(S) anchor without dispatching the page's click
   * handler. Returning null means the ref is not a safely classifiable link
   * and the bridge must use the full-control click path instead.
   */
  async follow(ref: string): Promise<BrowserActionResult | null> {
    this.assertRef(ref)
    const contents = this.requirePage()
    const target = await contents.executeJavaScript(`(() => {
      const el = document.querySelector('[data-codey-ref="${ref}"]')
      if (!el) throw new Error('Element ${ref} is no longer available; take a new snapshot')
      const anchor = el.closest('a[href]')
      if (!(anchor instanceof HTMLAnchorElement) || anchor.hasAttribute('download')) return null
      let url
      try { url = new URL(anchor.href, location.href) } catch { return null }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
      // A direct load bypasses JavaScript handlers, but some legacy sites
      // still mutate state through GET endpoints. Keep obviously destructive
      // targets behind full-control permission.
      const mutation = /(^|[\\/_?&=.-])(logout|log-out|signout|sign-out|delete|remove|unsubscribe|subscribe|purchase|checkout|pay|confirm|like|follow|bookmark|favorite|vote|join|leave|create|update)([\\/_?&=.-]|$)/i
      if (mutation.test(url.pathname + url.search)) return null
      return { url: url.href, newTab: anchor.target === '_blank' }
    })()`, true) as { url: string; newTab: boolean } | null

    if (!target?.url || !isSafeBrowserNavigationUrl(target.url)) return null
    if (target.newTab) {
      const state = await this.newTab(target.url)
      return { ok: true, url: state.url, message: `Opened link in a new tab: ${target.url}` }
    }
    await contents.loadURL(target.url)
    return { ok: true, url: target.url, message: `Opened link: ${target.url}` }
  }

  async click(ref: string): Promise<BrowserActionResult> {
    const contents = this.requirePage()
    const point = await this.elementPoint(ref)
    await this.humanClick(contents, point)
    return this.actionResult(`Clicked ${ref}`)
  }

  async clickAt(x: number, y: number, clickCount = 1): Promise<BrowserActionResult> {
    const contents = this.requirePage()
    const point = this.validatePoint(x, y)
    const count = Math.max(1, Math.min(3, Math.round(clickCount) || 1))
    await this.humanClick(contents, point, count)
    return this.actionResult(`Clicked at ${point.x}, ${point.y}${count > 1 ? ` (${count} times)` : ''}`)
  }

  async drag(
    fromX: number,
    fromY: number,
    toX: number,
    toY: number,
    steps = 12,
  ): Promise<BrowserActionResult> {
    const contents = this.requirePage()
    const from = this.validatePoint(fromX, fromY)
    const to = this.validatePoint(toX, toY)
    const count = Math.max(1, Math.min(100, Math.round(steps) || 12))
    contents.sendInputEvent({ type: 'mouseMove', ...from })
    contents.sendInputEvent({ type: 'mouseDown', ...from, button: 'left', clickCount: 1 })
    for (let index = 1; index <= count; index += 1) {
      const ratio = index / count
      contents.sendInputEvent({
        type: 'mouseMove',
        x: Math.round(from.x + (to.x - from.x) * ratio),
        y: Math.round(from.y + (to.y - from.y) * ratio),
        button: 'left',
      })
    }
    contents.sendInputEvent({ type: 'mouseUp', ...to, button: 'left', clickCount: 1 })
    this.pointer = { x: to.x, y: to.y }
    return this.actionResult(`Dragged from ${from.x}, ${from.y} to ${to.x}, ${to.y}`)
  }

  async hover(ref: string): Promise<BrowserActionResult> {
    const contents = this.requirePage()
    const point = await this.elementPoint(ref)
    await this.humanMove(contents, point)
    return this.actionResult(`Hovered ${ref}`)
  }

  async fill(ref: string, value: string): Promise<BrowserActionResult> {
    this.assertRef(ref)
    const contents = this.requirePage()
    // Select through the DOM, then type through Chromium's native key pipeline.
    // Assigning textContent/value only changes the rendered DOM and leaves
    // stateful editors (Draft.js, ProseMirror, X's composer, etc.) unaware of
    // the new text; real keystrokes drive their editing model and also emit the
    // keydown/keyup cadence that anti-bot heuristics look for.
    await contents.executeJavaScript(`(() => {
      const el = document.querySelector('[data-codey-ref="${ref}"]')
      if (!el) throw new Error('Element ${ref} is no longer available; take a new snapshot')
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') throw new Error('Element ${ref} is disabled')
      el.focus()
      if (el.isContentEditable) {
        const selection = window.getSelection()
        const range = document.createRange()
        range.selectNodeContents(el)
        selection?.removeAllRanges()
        selection?.addRange(range)
      } else if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
        el.select()
      } else {
        throw new Error('Element ${ref} is not a text field')
      }
      return true
    })()`, true)
    if (value) {
      // Typing over the existing selection replaces it, just like a person
      // does after the field is selected above.
      await this.humanType(contents, value)
    } else {
      // Nothing to type, so clear the active selection through the same native
      // path to preserve the expected "fill with empty text" behavior.
      contents.sendInputEvent({ type: 'keyDown', keyCode: 'Backspace' })
      contents.sendInputEvent({ type: 'keyUp', keyCode: 'Backspace' })
    }
    return this.actionResult(`Filled ${ref}`)
  }

  async select(ref: string, value: string): Promise<BrowserActionResult> {
    this.assertRef(ref)
    const contents = this.requirePage()
    await contents.executeJavaScript(`(() => {
      const el = document.querySelector('[data-codey-ref="${ref}"]')
      if (!(el instanceof HTMLSelectElement)) throw new Error('Element ${ref} is not a select field')
      const value = ${JSON.stringify(value)}
      const option = Array.from(el.options).find(item => item.value === value || item.text === value)
      if (!option) throw new Error('Option not found: ' + value)
      el.value = option.value
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
      return true
    })()`, true)
    return this.actionResult(`Selected ${JSON.stringify(value)} in ${ref}`)
  }

  async check(ref: string, checked: boolean): Promise<BrowserActionResult> {
    this.assertRef(ref)
    const contents = this.requirePage()
    const current = await contents.executeJavaScript(`(() => {
      const el = document.querySelector('[data-codey-ref="${ref}"]')
      if (!(el instanceof HTMLInputElement) || (el.type !== 'checkbox' && el.type !== 'radio')) {
        throw new Error('Element ${ref} is not a checkbox or radio button')
      }
      return el.checked
    })()`, true) as boolean
    if (current !== checked) await this.click(ref)
    return this.actionResult(`${checked ? 'Checked' : 'Unchecked'} ${ref}`)
  }

  async press(key: string, ref?: string): Promise<BrowserActionResult> {
    const contents = this.requirePage()
    if (ref) {
      this.assertRef(ref)
      await contents.executeJavaScript(`(() => {
        const el = document.querySelector('[data-codey-ref="${ref}"]')
        if (!el) throw new Error('Element ${ref} is no longer available; take a new snapshot')
        el.focus()
      })()`, true)
    }
    const parts = key.split('+').filter(Boolean)
    const requestedKey = parts.pop()
    if (!requestedKey) throw new Error('A key is required')
    const modifiers = parts.map(part => part.toLowerCase()).map(part => {
      if (part === 'cmd' || part === 'command' || part === 'meta') return 'meta'
      if (part === 'ctrl' || part === 'control') return 'control'
      if (part === 'alt' || part === 'option') return 'alt'
      if (part === 'shift') return 'shift'
      throw new Error(`Unsupported key modifier: ${part}`)
    }) as Array<'meta' | 'control' | 'alt' | 'shift'>
    const keyCode = [' ', 'space', 'spacebar'].includes(requestedKey.toLowerCase()) ? 'Space' : requestedKey
    contents.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
    const printable = keyCode === 'Space' ? ' ' : keyCode.length === 1 && modifiers.length === 0 ? keyCode : undefined
    if (printable !== undefined) {
      contents.sendInputEvent({ type: 'char', keyCode: printable, modifiers })
    }
    contents.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
    return this.actionResult(`Pressed ${key}${ref ? ` on ${ref}` : ''}`)
  }

  async scroll(deltaY: number, deltaX = 0): Promise<BrowserActionResult> {
    return await this.scrollAt(100, 100, deltaY, deltaX)
  }

  async scrollAt(x: number, y: number, deltaY: number, deltaX = 0): Promise<BrowserActionResult> {
    const contents = this.requirePage()
    const point = this.validatePoint(x, y)
    if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY)) throw new Error('Scroll deltas must be finite numbers')
    contents.sendInputEvent({
      type: 'mouseWheel', ...point,
      deltaX: Math.round(deltaX), deltaY: Math.round(deltaY),
      canScroll: true,
    })
    return this.actionResult(`Scrolled at ${point.x}, ${point.y} by ${Math.round(deltaX)}, ${Math.round(deltaY)}`)
  }

  async waitFor(request: BrowserWaitRequest): Promise<BrowserActionResult> {
    const kind = request.kind
    if (!['ref', 'text', 'url', 'title'].includes(kind)) throw new Error('Wait kind must be ref, text, url, or title')
    const value = String(request.value || '')
    if (!value) throw new Error('A wait value is required')
    if (kind === 'ref') this.assertRef(value)
    const state = request.state ?? 'visible'
    if (!['visible', 'hidden', 'enabled'].includes(state)) throw new Error('Wait state must be visible, hidden, or enabled')
    const timeoutMs = Math.max(100, Math.min(60000, Math.round(request.timeoutMs ?? 10000)))
    const started = Date.now()
    while (Date.now() - started <= timeoutMs) {
      try {
        const contents = this.requirePage()
        let matched: boolean
        if (kind === 'url' || kind === 'title') {
          const present = (kind === 'url' ? contents.getURL() : contents.getTitle()).includes(value)
          matched = state === 'hidden' ? !present : present
        } else {
          matched = await contents.executeJavaScript(`(() => {
            const kind = ${JSON.stringify(kind)}
            const value = ${JSON.stringify(value)}
            const wantedState = ${JSON.stringify(state)}
            if (kind === 'text') {
              const present = (document.body?.innerText || '').includes(value)
              return wantedState === 'hidden' ? !present : present
            }
            const el = document.querySelector('[data-codey-ref="' + value + '"]')
            const visible = !!el && (() => {
              const rect = el.getBoundingClientRect()
              const style = getComputedStyle(el)
              return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
            })()
            return wantedState === 'hidden'
              ? !visible
              : wantedState === 'enabled'
                ? visible && !el.disabled && el.getAttribute('aria-disabled') !== 'true'
                : visible
          })()`, true) as boolean
        }
        if (matched) return this.actionResult(`Wait condition matched after ${Date.now() - started}ms`)
      } catch {
        // Navigation can replace the execution context between polls. Retry
        // against the current active page until the bounded timeout expires.
      }
      await new Promise<void>(resolve => setTimeout(resolve, 100))
    }
    throw new Error(`Timed out waiting for ${kind}: ${value}`)
  }

  async upload(ref: string, filePaths: string[]): Promise<BrowserActionResult> {
    this.assertRef(ref)
    const contents = this.requirePage()
    if (!Array.isArray(filePaths) || filePaths.length === 0) throw new Error('At least one upload file is required')
    if (filePaths.length > 20) throw new Error('A maximum of 20 files can be uploaded at once')
    const files = filePaths.map(filePath => path.resolve(String(filePath))).map(filePath => {
      const stat = fs.statSync(filePath)
      if (!stat.isFile()) throw new Error(`Upload path is not a file: ${filePath}`)
      return filePath
    })

    const attachedHere = !contents.debugger.isAttached()
    if (attachedHere) contents.debugger.attach('1.3')
    try {
      const document = await contents.debugger.sendCommand('DOM.getDocument', { depth: -1, pierce: true }) as { root: { nodeId: number } }
      const selected = await contents.debugger.sendCommand('DOM.querySelector', {
        nodeId: document.root.nodeId,
        selector: `[data-codey-ref="${ref}"]`,
      }) as { nodeId: number }
      if (!selected.nodeId) throw new Error(`Element ${ref} is no longer available; take a new snapshot`)
      await contents.debugger.sendCommand('DOM.setFileInputFiles', { nodeId: selected.nodeId, files })
    } finally {
      if (attachedHere && contents.debugger.isAttached()) contents.debugger.detach()
    }
    return this.actionResult(`Attached ${files.length} file${files.length === 1 ? '' : 's'} to ${ref}`)
  }

  listDownloads(): BrowserDownload[] {
    return this.downloads.map(download => ({ ...download }))
  }

  async waitForDownload(timeoutMs = 60000): Promise<BrowserDownload> {
    const latest = this.downloads[0]
    if (latest?.status === 'completed' && Date.now() - (latest.finishedAt ?? 0) < 10000) return { ...latest }
    const boundedTimeout = Math.max(100, Math.min(300000, Math.round(timeoutMs) || 60000))
    return await new Promise<BrowserDownload>((resolve, reject) => {
      const waiter = (download: BrowserDownload) => {
        clearTimeout(timer)
        resolve({ ...download })
      }
      const timer = setTimeout(() => {
        this.downloadWaiters = this.downloadWaiters.filter(candidate => candidate !== waiter)
        reject(new Error('Timed out waiting for a browser download'))
      }, boundedTimeout)
      this.downloadWaiters.push(waiter)
    })
  }

  async submit(ref: string): Promise<BrowserActionResult> {
    this.assertRef(ref)
    const contents = this.requirePage()
    await contents.executeJavaScript(`(() => {
      const el = document.querySelector('[data-codey-ref="${ref}"]')
      if (!el) throw new Error('Element ${ref} is no longer available; take a new snapshot')
      const form = el instanceof HTMLFormElement ? el : el.form || el.closest('form')
      if (!(form instanceof HTMLFormElement)) throw new Error('No form found for ${ref}')
      const submitter = el instanceof HTMLButtonElement || (el instanceof HTMLInputElement && ['submit', 'image'].includes(el.type)) ? el : undefined
      form.requestSubmit(submitter)
      return true
    })()`, true)
    return this.actionResult(`Submitted form for ${ref}`)
  }

  /** Close every page and remove cookies, storage, HTTP auth, and cache data. */
  async resetSession(): Promise<BrowserState> {
    this.destroy()
    this.downloads = []
    const browserSession = this.getBrowserSession()
    await browserSession.clearStorageData()
    await browserSession.clearCache()
    await browserSession.clearAuthCache()
    return this.patchState({ ...EMPTY_STATE })
  }

  // ── Profiles ─────────────────────────────────────────────────────────
  // A profile is a named snapshot of the browser's session state — cookies
  // plus per-origin localStorage — that can be saved from the live session,
  // imported from a file, and activated to switch the browser's identity.
  // See browser-profiles.ts for the model and store.

  /** All saved profiles, with the enabled one flagged. */
  listProfiles(): BrowserProfileSummary[] {
    return this.profiles().list()
  }

  /** Name of the enabled profile, or null when none is enabled. */
  activeProfileName(): string | null {
    return this.profiles().active()
  }

  /** Snapshot the live session (cookies + reachable per-site storage) into a
   *  named profile. Saving does not activate the profile — call activateProfile
   *  (or import with activate) to switch the browser to it.
   *
   *  With several profiles enabled the live session is their union, so writing
   *  it back over one of them would quietly swallow the others. Saving to a new
   *  name is still fine: that snapshot is honestly everything the browser
   *  currently carries. */
  async saveProfile(name: string): Promise<BrowserProfile> {
    assertProfileName(name)
    const enabled = this.profiles().activeNames()
    if (enabled.length > 1 && enabled.includes(name)) {
      throw new Error(
        `${enabled.length} profiles are enabled, so the live session is their combined logins. `
        + `Saving it over "${name}" would pull ${enabled.filter(entry => entry !== name).join(', ')} into it. `
        + 'Save to a new name, or leave only that profile enabled first.',
      )
    }
    const data = await this.captureProfileData()
    const sourceUrl = this.view?.webContents.getURL() || null
    return this.profiles().write(name, data, sourceUrl)
  }

  /** Import a session snapshot from a file path or raw JSON (our profile
   *  format or a Playwright storageState) into a named profile. Activating is
   *  the default — "import then enable" in one step. */
  async importProfile(
    name: string,
    source: { path: string } | { json: string },
    activate = true,
    sourceUrl: string | null = null,
  ): Promise<BrowserProfile> {
    assertProfileName(name)
    const data = 'path' in source
      ? readProfileJson(source.path)
      : parseProfileJsonText(source.json)
    const profile = this.profiles().write(name, data, sourceUrl)
    if (activate) {
      await this.applyProfileData(profile)
      this.profiles().setActive(name)
    }
    return profile
  }

  /** Names of saved profiles that already hold a cookie scoped to `url` -
   *  the profiles a handoff of that page would be refreshing rather than
   *  creating. Unreadable profiles are simply not offered. */
  profilesForUrl(url: string): string[] {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return []
    }
    const store = this.profiles()
    return store.list()
      .filter(summary => {
        try {
          return store.read(summary.name).cookies.some(cookie => cookieMatchesUrl(cookie, parsed))
        } catch {
          return false
        }
      })
      .map(summary => summary.name)
  }

  /** Refresh part of a saved profile from a freshly exported session, so a
   *  login that was renewed elsewhere stops being stale here. The profile must
   *  already exist - this is the "my Chrome login changed" path, not a second
   *  way to create one - and only the scope URL's cookies and the exported
   *  origins' storage are replaced, so other sites saved in the same profile
   *  survive. Refreshing the enabled profile re-applies it too: the live
   *  session would otherwise keep serving the cookies it was activated with. */
  async resyncProfile(
    name: string,
    source: { json: string },
    scopeUrl: string,
  ): Promise<BrowserProfile> {
    assertProfileName(name)
    const existing = this.profiles().read(name)
    const merged = mergeProfileData(existing, parseProfileJsonText(source.json), scopeUrl)
    const profile = this.profiles().write(name, merged, existing.sourceUrl ?? scopeUrl)
    if (this.profiles().activeNames().includes(name)) await this.applyLiveProfiles()
    return profile
  }

  /** The registrable domains a profile holds cookies for - what a refresh of
   *  the whole profile has to ask Chrome about. */
  profileSites(name: string): string[] {
    assertProfileName(name)
    const seen = new Set<string>()
    for (const cookie of this.profiles().read(name).cookies) {
      const domain = cookie.domain.replace(/^\./, '').toLowerCase()
      if (domain) seen.add(domain)
    }
    return [...seen]
  }

  /** Refresh every site a profile holds from a fresh multi-site export, so one
   *  click brings a whole saved identity back up to date. Only the sites the
   *  export covers are replaced; anything the profile holds from elsewhere
   *  survives. Refreshing an enabled profile re-applies the live session too. */
  async resyncProfileSites(
    name: string,
    source: { json: string },
    sites: readonly string[],
  ): Promise<BrowserProfile> {
    assertProfileName(name)
    const existing = this.profiles().read(name)
    const merged = mergeProfileSites(existing, parseProfileJsonText(source.json), sites)
    const profile = this.profiles().write(name, merged, existing.sourceUrl)
    if (this.profiles().activeNames().includes(name)) await this.applyLiveProfiles()
    return profile
  }

  /** Names of every enabled profile, in the order they were enabled. */
  activeProfileNames(): string[] {
    return this.profiles().activeNames()
  }

  /** Switch the live session to a single saved profile, replacing whatever was
   *  enabled. This is the identity switch: leftovers from the profiles that
   *  were enabled cannot leak into the new one. Use `enableProfile` to add a
   *  profile alongside the ones already on. */
  async activateProfile(name: string): Promise<BrowserProfileSummary> {
    assertProfileName(name)
    const enabled = this.profiles().activeNames()
    if (enabled.length === 1 && enabled[0] === name) {
      const current = this.profiles().list().find(profile => profile.name === name)
      if (current) return current
      throw new Error(`Profile ${name} is enabled but missing on disk`)
    }
    this.profiles().read(name)
    await this.setEnabledProfiles([name])
    return this.summaryOf(name)
  }

  /** Turn a profile on alongside the ones already enabled, so a browser can
   *  hold several logins at once (a GitHub profile and a Jira one, say). The
   *  live session becomes the union of every enabled profile.
   *
   *  Two profiles that carry the same cookie cannot both be honoured - one
   *  value would silently win - so an overlap is refused and named instead. */
  async enableProfile(name: string): Promise<BrowserProfileSummary> {
    assertProfileName(name)
    const enabled = this.profiles().activeNames()
    if (enabled.includes(name)) return this.summaryOf(name)
    const incoming = this.profiles().read(name)
    for (const other of enabled) {
      let held: BrowserProfile
      try {
        held = this.profiles().read(other)
      } catch {
        continue
      }
      const clash = conflictingCookie(held, incoming)
      if (clash) {
        throw new Error(
          `"${name}" and "${other}" both hold a different ${clash.name} cookie for ${clash.domain}. `
          + `Turn "${other}" off first, or switch to "${name}" instead of adding it.`,
        )
      }
    }
    await this.setEnabledProfiles([...enabled, name])
    return this.summaryOf(name)
  }

  /** Turn one profile off and leave the rest enabled. The live session is
   *  rebuilt from what remains rather than having cookies picked out of it, so
   *  nothing of the disabled profile can survive by accident. */
  async disableProfile(name: string): Promise<BrowserProfileSummary> {
    assertProfileName(name)
    const enabled = this.profiles().activeNames()
    if (!enabled.includes(name)) return this.summaryOf(name)
    await this.setEnabledProfiles(enabled.filter(entry => entry !== name))
    return this.summaryOf(name)
  }

  private summaryOf(name: string): BrowserProfileSummary {
    const summary = this.profiles().list().find(entry => entry.name === name)
    if (summary) return summary
    const profile = this.profiles().read(name)
    return {
      name,
      avatar: profile.avatar ?? null,
      createdAt: profile.createdAt,
      updatedAt: profile.updatedAt,
      cookieCount: profile.cookies.length,
      originCount: profile.origins.length,
      active: this.profiles().activeNames().includes(name),
      sourceUrl: profile.sourceUrl,
    }
  }

  /** Record the enabled set and make the live session match it. */
  private async setEnabledProfiles(names: string[]): Promise<void> {
    this.profiles().setActive(names)
    await this.applyLiveProfiles()
  }

  /** Rebuild the live session from every enabled profile. Always a full
   *  replace, so disabling a profile really removes it and re-syncing one
   *  cannot leave a stale copy of itself behind. */
  private async applyLiveProfiles(): Promise<void> {
    const names = this.profiles().activeNames()
    const cookies: BrowserProfileCookie[] = []
    const origins: BrowserProfileStorageOrigin[] = []
    let sourceUrl: string | null = null
    let createdAt = Date.now()
    for (const name of names) {
      let profile: BrowserProfile
      try {
        profile = this.profiles().read(name)
      } catch {
        continue
      }
      cookies.push(...profile.cookies)
      origins.push(...profile.origins)
      sourceUrl = sourceUrl ?? profile.sourceUrl
      createdAt = Math.min(createdAt, profile.createdAt || createdAt)
    }
    await this.applyProfileData({
      name: names.join('+'),
      cookies,
      origins,
      avatar: null,
      createdAt,
      updatedAt: Date.now(),
      sourceUrl,
    })
  }

  setProfileAvatar(name: string, avatar: string): BrowserProfileSummary {
    return this.profiles().setAvatar(name, avatar)
  }

  /** Remove a saved profile. Deleting an enabled profile turns it off and
   *  rebuilds the live session from whichever profiles are still on. */
  async deleteProfile(name: string): Promise<{ deleted: boolean }> {
    assertProfileName(name)
    const enabled = this.profiles().activeNames()
    this.profiles().remove(name)
    if (enabled.includes(name)) await this.setEnabledProfiles(enabled.filter(entry => entry !== name))
    return { deleted: true }
  }

  /** Write a saved profile to an arbitrary path, so a session can be handed to
   *  another machine (or another profile-enabled tool). */
  async exportProfile(name: string, targetPath: string): Promise<{ path: string }> {
    const profile = this.profiles().read(name)
    const file = path.resolve(String(targetPath))
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(profile, null, 2), { encoding: 'utf8', mode: 0o600 })
    try { fs.chmodSync(file, 0o600) } catch { /* best-effort */ }
    return { path: file }
  }

  /** Collect the live session's cookies and the localStorage of every open
   *  http(s) tab (unique origins). Page text and fields are never read — only
   *  the storage that holds login state. */
  private async captureProfileData(): Promise<BrowserProfileData> {
    let cookies: BrowserProfileCookie[] = []
    try {
      const found = await this.getBrowserSession().cookies.get({})
      cookies = found.map(cookie => ({
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain || '',
        path: cookie.path || '/',
        expires: cookie.expirationDate !== undefined && Number.isFinite(cookie.expirationDate)
          ? cookie.expirationDate
          : -1,
        httpOnly: cookie.httpOnly === true,
        secure: cookie.secure === true,
        sameSite: cookie.sameSite || 'unspecified',
        ...(cookie.hostOnly ? { hostOnly: true } : {}),
      })).filter(cookie => cookie.domain)
    } catch {
      // Cookies unavailable (session torn down) — save what is reachable.
    }

    const origins = new Map<string, BrowserProfileStorageOrigin>()
    for (const tab of this.tabs) {
      const contents = tab.view.webContents
      if (contents.isDestroyed()) continue
      const url = contents.getURL()
      if (!url || url === 'about:blank') continue
      let origin: string
      try {
        const parsed = new URL(url)
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue
        origin = parsed.origin
      } catch {
        continue
      }
      if (origins.has(origin)) continue
      try {
        const result = await contents.executeJavaScript(`(() => {
          const entries = []
          for (let i = 0; i < localStorage.length; i += 1) {
            const key = localStorage.key(i)
            if (key === null) continue
            try { entries.push({ name: key, value: localStorage.getItem(key) || '' }) } catch { /* skip */ }
          }
          return { origin: location.origin, entries }
        })()`, true) as { origin?: unknown; entries?: unknown }
        const originName = typeof result?.origin === 'string' && result.origin ? result.origin : origin
        const entries = Array.isArray(result?.entries)
          ? result.entries
            .map(entry => {
              if (typeof entry !== 'object' || entry === null) return null
              const record = entry as Record<string, unknown>
              return {
                name: typeof record.name === 'string' ? record.name : '',
                value: typeof record.value === 'string' ? record.value : String(record.value ?? ''),
              }
            })
            .filter((entry): entry is { name: string; value: string } => !!entry && !!entry.name)
          : []
        if (entries.length > 0) origins.set(originName, { origin: originName, localStorage: entries })
      } catch {
        // Page context unavailable — skip this tab's storage.
      }
    }
    return { cookies, origins: Array.from(origins.values()) }
  }

  /** Replace the live session's cookies with the profile's, then apply its
   *  per-origin localStorage. Replacing rather than merging is what makes
   *  activating a profile an identity switch: leftovers from the previous
   *  profile cannot leak into the new one. */
  private async applyProfileData(profile: BrowserProfile): Promise<void> {
    const browserSession = this.getBrowserSession()
    let existing: Electron.Cookie[] = []
    try {
      existing = await browserSession.cookies.get({})
    } catch {
      // Session unavailable — nothing to replace.
    }
    for (const cookie of existing) {
      const domain = cookie.domain || ''
      if (!domain) continue
      const url = `https://${domain.replace(/^\./, '')}${cookie.path || '/'}`
      try { await browserSession.cookies.remove(url, cookie.name) } catch { /* best-effort */ }
    }
    for (const cookie of profile.cookies) {
      try {
        const url = `https://${cookie.domain}${cookie.path || '/'}`
        await browserSession.cookies.set({
          url,
          name: cookie.name,
          value: cookie.value,
          domain: cookie.domain,
          path: cookie.path || '/',
          secure: cookie.secure,
          httpOnly: cookie.httpOnly,
          ...(cookie.expires > 0 ? { expirationDate: cookie.expires } : {}),
          ...(cookie.sameSite !== 'unspecified' ? { sameSite: cookie.sameSite } : {}),
        })
      } catch {
        // One cookie failing must not abort the whole activation.
      }
    }
    for (const origin of profile.origins) {
      await this.applyLocalStorage(origin.origin, origin.localStorage)
    }
  }

  /** Write localStorage entries for one origin: through a tab that is already
   *  on it when possible, otherwise through a hidden page loaded for that
   *  origin. Best-effort — a site that refuses to load just keeps its storage
   *  untouched (cookies, the part that matters most for logins, are applied
   *  unconditionally). */
  private async applyLocalStorage(origin: string, items: Array<{ name: string; value: string }>): Promise<void> {
    if (items.length === 0) return
    const open = this.tabs.find(tab => {
      try { return new URL(tab.view.webContents.getURL()).origin === origin } catch { return false }
    })
    if (open && !open.view.webContents.isDestroyed()) {
      try {
        await open.view.webContents.executeJavaScript(this.localStorageApplyScript(items), true)
        return
      } catch {
        // Fall through to a hidden page.
      }
    }
    const view = this.createHiddenView?.()
    if (!view) return
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timeout')), 10000)
        view.webContents.once('did-finish-load', () => { clearTimeout(timer); resolve() })
        view.webContents.once('did-fail-load', (_event, errorCode, errorDescription) => {
          clearTimeout(timer)
          reject(new Error(errorDescription || String(errorCode)))
        })
        void view.webContents.loadURL(origin + '/').catch(() => {})
      })
      await view.webContents.executeJavaScript(this.localStorageApplyScript(items), true)
    } catch {
      // Best-effort per origin.
    } finally {
      if (!view.webContents.isDestroyed()) view.webContents.close({ waitForBeforeUnload: false })
    }
  }

  private localStorageApplyScript(items: Array<{ name: string; value: string }>): string {
    return `(() => {
      const items = ${JSON.stringify(items)}
      for (const item of items) {
        try { localStorage.setItem(item.name, item.value) } catch { /* quota or private mode */ }
      }
      return true
    })()`
  }

  destroy(options: { closeContents?: boolean } = {}): void {
    this.detach()
    const tabs = this.tabs.splice(0)
    this.view = null
    if (options.closeContents !== false) {
      for (const tab of tabs) {
        if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close({ waitForBeforeUnload: false })
      }
    }
    this.state = { ...EMPTY_STATE }
    const waiters = this.downloadWaiters.splice(0)
    const interrupted = this.downloads[0] ?? {
      id: 'browser-closed', name: '', path: '', url: '', status: 'interrupted' as const,
      receivedBytes: 0, totalBytes: 0, startedAt: Date.now(), finishedAt: Date.now(),
    }
    for (const resolve of waiters) resolve({ ...interrupted })
  }

  private requireWindow(): BrowserWindow {
    const win = this.getWindow()
    if (!win || win.isDestroyed()) throw new Error('Codey window is unavailable')
    return win
  }

  private requirePage(): WebContents {
    const contents = this.view?.webContents
    if (!contents || contents.isDestroyed() || !contents.getURL() || contents.getURL() === 'about:blank') {
      throw new Error('Open a page before controlling the browser')
    }
    return contents
  }

  private assertRef(ref: string): void {
    if (!/^e\d+$/.test(ref)) throw new Error('Invalid element reference; take a new snapshot')
  }

  private validatePoint(x: number, y: number): { x: number; y: number } {
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('Pointer coordinates must be finite numbers')
    return { x: Math.max(0, Math.round(x)), y: Math.max(0, Math.round(y)) }
  }

  private async elementPoint(ref: string): Promise<{ x: number; y: number }> {
    this.assertRef(ref)
    const contents = this.requirePage()
    return await contents.executeJavaScript(`(() => {
      const el = document.querySelector('[data-codey-ref="${ref}"]')
      if (!el) throw new Error('Element ${ref} is no longer available; take a new snapshot')
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') throw new Error('Element ${ref} is disabled')
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
      const rect = el.getBoundingClientRect()
      return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) }
    })()`, true) as { x: number; y: number }
  }

  /**
   * Emit a curved, variable-speed pointer path from the last known cursor
   * position to the target. A straight line traversed at a constant rate is a
   * strong automation tell, so the synthesized motion arcs off-axis, eases in
   * and out, and jitters between samples the way a real hand does.
   */
  private async humanMove(contents: WebContents, target: { x: number; y: number }): Promise<void> {
    const from = this.pointer ?? {
      x: Math.max(0, target.x - 40 - Math.round(this.random() * 40)),
      y: Math.max(0, target.y - 30 - Math.round(this.random() * 30)),
    }
    for (const point of this.buildPointerPath(from, target)) {
      contents.sendInputEvent({ type: 'mouseMove', x: point.x, y: point.y })
      await this.sleep(this.humanDelay(6, 10))
    }
    this.pointer = { x: target.x, y: target.y }
  }

  /** Approach the target, settle, then press and release with human-scale gaps. */
  private async humanClick(
    contents: WebContents,
    target: { x: number; y: number },
    clickCount = 1,
  ): Promise<void> {
    await this.humanMove(contents, target)
    await this.sleep(this.humanDelay(40, 90))
    const count = Math.max(1, Math.min(3, Math.round(clickCount) || 1))
    for (let index = 1; index <= count; index += 1) {
      contents.sendInputEvent({ type: 'mouseDown', x: target.x, y: target.y, button: 'left', clickCount: index })
      await this.sleep(this.humanDelay(55, 70))
      contents.sendInputEvent({ type: 'mouseUp', x: target.x, y: target.y, button: 'left', clickCount: index })
      if (index < count) await this.sleep(this.humanDelay(70, 90))
    }
  }

  private buildPointerPath(
    from: { x: number; y: number },
    to: { x: number; y: number },
  ): Array<{ x: number; y: number }> {
    const dx = to.x - from.x
    const dy = to.y - from.y
    const distance = Math.hypot(dx, dy)
    const steps = Math.max(8, Math.min(40, Math.round(distance / 12) + 8))
    const length = distance || 1
    // Perpendicular unit vector used to bow the straight line into a gentle arc.
    const perpX = -dy / length
    const perpY = dx / length
    const bow = (this.random() * 2 - 1) * Math.min(60, distance * 0.2)
    const controlX = from.x + dx / 2 + perpX * bow
    const controlY = from.y + dy / 2 + perpY * bow
    const points: Array<{ x: number; y: number }> = []
    for (let index = 1; index <= steps; index += 1) {
      const progress = index / steps
      // Ease-in-out clusters samples near the endpoints, like a real hand.
      const eased = progress < 0.5 ? 2 * progress * progress : 1 - Math.pow(-2 * progress + 2, 2) / 2
      const inverse = 1 - eased
      const last = index === steps
      // Quadratic Bézier through the bowed control point.
      const x = inverse * inverse * from.x + 2 * inverse * eased * controlX + eased * eased * to.x
      const y = inverse * inverse * from.y + 2 * inverse * eased * controlY + eased * eased * to.y
      // Land exactly on the target; only intermediate samples carry jitter.
      const jitterX = last ? 0 : (this.random() * 2 - 1) * 1.2
      const jitterY = last ? 0 : (this.random() * 2 - 1) * 1.2
      points.push({ x: Math.round(x + jitterX), y: Math.round(y + jitterY) })
    }
    return points
  }

  /**
   * Type a string one character at a time as full keydown/char/keyup
   * keystrokes with a jittered inter-key delay. `Array.from` keeps multi-code-
   * unit characters (emoji, combined glyphs) intact, and newlines are sent as
   * Return so multi-line fields receive the break a real keyboard would insert.
   */
  private async humanType(contents: WebContents, value: string): Promise<void> {
    for (const char of Array.from(value)) {
      if (char === '\n' || char === '\r') {
        contents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' })
        contents.sendInputEvent({ type: 'char', keyCode: '\r' })
        contents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' })
      } else {
        contents.sendInputEvent({ type: 'keyDown', keyCode: char })
        contents.sendInputEvent({ type: 'char', keyCode: char })
        contents.sendInputEvent({ type: 'keyUp', keyCode: char })
      }
      await this.sleep(this.humanDelay(40, 90))
    }
  }

  private humanDelay(base: number, spread: number): number {
    return Math.max(0, Math.round(base + this.random() * spread))
  }

  private actionResult(message: string): BrowserActionResult {
    return { ok: true, url: this.view?.webContents.getURL() || '', message }
  }

  private ensureView(): WebContentsView {
    if (this.view && !this.view.webContents.isDestroyed()) return this.view

    const tab = this.createTab(true)
    void tab.view.webContents.loadURL('about:blank').catch(() => {
      // A caller may immediately navigate elsewhere and abort this initial
      // blank load; the real navigation owns any user-visible error state.
    })
    return tab.view
  }

  private createTab(activate: boolean): BrowserTabRecord {
    const browserSession = this.getBrowserSession()
    this.bindSitePermissions(browserSession)
    this.bindDownloads(browserSession)

    const view = new WebContentsView({
      webPreferences: {
        partition: BROWSER_PARTITION,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        // Keep the page compositing and running timers even when the Codey
        // window is backgrounded or occluded, so agent screenshots
        // (capturePage) stay fresh without forcing the window to the front.
        backgroundThrottling: false,
      },
    })
    view.setBackgroundColor('#141414')
    const tab: BrowserTabRecord = { id: `t${++this.tabSequence}`, view }
    this.tabs.push(tab)
    this.bindEvents(view.webContents)
    if (activate) {
      const win = this.attachedTo
      this.detach()
      this.view = view
      this.state = { ...EMPTY_STATE }
      if (win && !win.isDestroyed()) {
        win.contentView.addChildView(view)
        this.attachedTo = win
        if (this.lastBounds) view.setBounds(sanitizeBounds(this.lastBounds, win, this.zoom))
      }
    }
    return tab
  }

  private bindSitePermissions(browserSession: Session): void {
    if (this.permissionSessionBound) return
    this.permissionSessionBound = true
    browserSession.setPermissionCheckHandler((_contents, permission, requestingOrigin, details) => {
      return this.sitePermissionManager?.check(
        permission,
        requestingOrigin,
        details as BrowserSitePermissionDetails,
      ) ?? false
    })
    browserSession.setPermissionRequestHandler((contents, permission, callback, details) => {
      const requestingOrigin = (details as BrowserSitePermissionDetails).securityOrigin
        || details.requestingUrl
        || contents.getURL()
      const manager = this.sitePermissionManager
      if (!manager) {
        callback(false)
        return
      }
      void manager.request(
        permission,
        requestingOrigin,
        details as BrowserSitePermissionDetails,
      ).then(callback, () => callback(false))
    })
  }

  private bindEvents(contents: WebContents): void {
    const active = () => this.view?.webContents === contents
    const refresh = () => { if (active()) this.refreshState() }
    contents.on('did-start-loading', () => { if (active()) this.patchState({ loading: true, error: null }) })
    contents.on('did-stop-loading', refresh)
    contents.on('did-navigate', refresh)
    contents.on('did-navigate-in-page', refresh)
    contents.on('page-title-updated', (_event, title) => { if (active()) this.patchState({ title }) })
    contents.on('did-fail-load', (_event, errorCode, errorDescription) => {
      if (errorCode === -3) return // ERR_ABORTED: normal for interrupted navigation.
      if (active()) this.patchState({ loading: false, error: errorDescription || `Navigation failed (${errorCode})` })
    })
    contents.on('render-process-gone', (_event, details) => {
      if (active()) this.patchState({ loading: false, error: `Browser renderer stopped: ${details.reason}` })
    })
    contents.setWindowOpenHandler(({ url, disposition, features }) => {
      try {
        normalizeBrowserUrl(url)
      } catch (error) {
        if (active()) this.patchState({ error: error instanceof Error ? error.message : String(error) })
        return { action: 'deny' }
      }

      let authenticationProvider = false
      try {
        const hostname = new URL(url).hostname.toLowerCase()
        authenticationProvider = hostname === 'accounts.google.com'
          || hostname === 'appleid.apple.com'
          || hostname === 'login.microsoftonline.com'
      } catch { /* about:blank is a common first URL for OAuth popups */ }

      const popupRequested = disposition === 'new-window'
        || !!features.trim()
        || url === 'about:blank'
        || authenticationProvider
      if (popupRequested) {
        const parent = this.getWindow()
        return {
          action: 'allow',
          outlivesOpener: false,
          overrideBrowserWindowOptions: {
            parent: parent && !parent.isDestroyed() ? parent : undefined,
            backgroundColor: '#141414',
            autoHideMenuBar: true,
            webPreferences: {
              partition: BROWSER_PARTITION,
              contextIsolation: true,
              nodeIntegration: false,
              sandbox: true,
              webSecurity: true,
            },
          },
        }
      }

      const target = normalizeBrowserUrl(url)
      const tab = this.createTab(true)
      void tab.view.webContents.loadURL(target).catch(error => this.patchState({ error: error instanceof Error ? error.message : String(error) }))
      return { action: 'deny' }
    })
    contents.on('did-create-window', child => {
      child.setMenuBarVisibility(false)
      child.once('closed', () => {
        if (!contents.isDestroyed()) contents.focus()
      })
    })
    const guardNavigation = (event: Electron.Event, url: string) => {
      try {
        normalizeBrowserUrl(url)
      } catch {
        event.preventDefault()
        if (active()) this.patchState({ error: 'The page tried to open a blocked URL' })
      }
    }
    contents.on('will-navigate', guardNavigation)
    contents.on('will-redirect', guardNavigation)
  }

  private bindDownloads(browserSession: Session): void {
    if (this.downloadSessionBound) return
    this.downloadSessionBound = true
    browserSession.on('will-download', (_event, item) => {
      const directory = this.getDownloadDirectory()
      fs.mkdirSync(directory, { recursive: true })
      const candidateName = path.basename(item.getFilename()).replace(/[\u0000-\u001f]/g, '_')
      const safeName = !candidateName || candidateName === '.' || candidateName === '..' ? 'download' : candidateName
      const savePath = this.uniqueDownloadPath(directory, safeName)
      item.setSavePath(savePath)
      const download: BrowserDownload = {
        id: `d${Date.now()}-${++this.downloadSequence}`,
        name: safeName,
        path: savePath,
        url: item.getURL(),
        status: 'progressing',
        receivedBytes: item.getReceivedBytes(),
        totalBytes: item.getTotalBytes(),
        startedAt: Date.now(),
      }
      this.downloads.unshift(download)
      this.downloads = this.downloads.slice(0, 50)
      this.emitDownload(download)
      item.on('updated', (_updatedEvent, state) => {
        download.status = state === 'interrupted' ? 'interrupted' : 'progressing'
        download.receivedBytes = item.getReceivedBytes()
        download.totalBytes = item.getTotalBytes()
        this.emitDownload(download)
      })
      item.once('done', (_doneEvent, state) => {
        download.status = state
        download.receivedBytes = item.getReceivedBytes()
        download.totalBytes = item.getTotalBytes()
        download.finishedAt = Date.now()
        this.emitDownload(download)
        const waiters = this.downloadWaiters.splice(0)
        for (const resolve of waiters) resolve({ ...download })
      })
    })
  }

  private emitDownload(download: BrowserDownload): void {
    this.onDownload({ ...download })
  }

  private uniqueDownloadPath(directory: string, name: string): string {
    const parsed = path.parse(name)
    let candidate = path.join(directory, name)
    let suffix = 1
    while (fs.existsSync(candidate) || this.downloads.some(download => download.path === candidate)) {
      candidate = path.join(directory, `${parsed.name} (${suffix++})${parsed.ext}`)
    }
    return candidate
  }

  private detach(): void {
    if (!this.view || !this.attachedTo || this.attachedTo.isDestroyed()) {
      this.attachedTo = null
      return
    }
    try { this.attachedTo.contentView.removeChildView(this.view) } catch { /* already detached */ }
    this.attachedTo = null
  }

  private refreshState(): BrowserState {
    const contents = this.view?.webContents
    if (!contents || contents.isDestroyed()) return this.getState()
    return this.patchState({
      url: contents.getURL() === 'about:blank' ? '' : contents.getURL(),
      title: contents.getTitle() || 'New tab',
      loading: contents.isLoading(),
      canGoBack: contents.canGoBack(),
      canGoForward: contents.canGoForward(),
    })
  }

  private patchState(patch: Partial<BrowserState>): BrowserState {
    this.state = { ...this.state, ...patch }
    const snapshot = this.getState()
    this.onState(snapshot)
    return snapshot
  }
}
