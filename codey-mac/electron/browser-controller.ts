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

function sanitizeBounds(bounds: BrowserBounds, win: BrowserWindow): BrowserBounds {
  const content = win.getContentBounds()
  const x = Math.max(0, Math.round(Number(bounds.x) || 0))
  const y = Math.max(0, Math.round(Number(bounds.y) || 0))
  return {
    x,
    y,
    width: Math.max(0, Math.min(Math.round(Number(bounds.width) || 0), content.width - x)),
    height: Math.max(0, Math.min(Math.round(Number(bounds.height) || 0), content.height - y)),
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
  private state: BrowserState = { ...EMPTY_STATE }
  private downloads: BrowserDownload[] = []
  private downloadSessionBound = false
  private permissionSessionBound = false
  private downloadWaiters: Array<(download: BrowserDownload) => void> = []
  private downloadSequence = 0
  private sitePermissionManager: BrowserSitePermissionManager | null = null

  constructor(
    private readonly getWindow: () => BrowserWindow | null,
    private readonly onState: (state: BrowserState) => void,
    private readonly onDownload: (download: BrowserDownload) => void = () => {},
    private readonly getDownloadDirectory: () => string = () => path.join(os.tmpdir(), 'codey-downloads'),
    private readonly getBrowserSession: () => Session = () => session.fromPartition(BROWSER_PARTITION, { cache: true }),
  ) {}

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
      if (this.lastBounds) tab.view.setBounds(sanitizeBounds(this.lastBounds, win))
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
        if (this.lastBounds) next.view.setBounds(sanitizeBounds(this.lastBounds, win))
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
    view.setBounds(sanitizeBounds(bounds, win))
    return this.getState()
  }

  hide(): void {
    this.detach()
  }

  setBounds(bounds: BrowserBounds): void {
    this.lastBounds = { ...bounds }
    if (!this.view || !this.attachedTo) return
    this.view.setBounds(sanitizeBounds(bounds, this.attachedTo))
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
    contents.sendInputEvent({ type: 'mouseMove', x: point.x, y: point.y })
    contents.sendInputEvent({ type: 'mouseDown', x: point.x, y: point.y, button: 'left', clickCount: 1 })
    contents.sendInputEvent({ type: 'mouseUp', x: point.x, y: point.y, button: 'left', clickCount: 1 })
    return this.actionResult(`Clicked ${ref}`)
  }

  async clickAt(x: number, y: number, clickCount = 1): Promise<BrowserActionResult> {
    const contents = this.requirePage()
    const point = this.validatePoint(x, y)
    const count = Math.max(1, Math.min(3, Math.round(clickCount) || 1))
    contents.sendInputEvent({ type: 'mouseMove', ...point })
    for (let index = 1; index <= count; index += 1) {
      contents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: index })
      contents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: index })
    }
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
    return this.actionResult(`Dragged from ${from.x}, ${from.y} to ${to.x}, ${to.y}`)
  }

  async hover(ref: string): Promise<BrowserActionResult> {
    const contents = this.requirePage()
    const point = await this.elementPoint(ref)
    contents.sendInputEvent({ type: 'mouseMove', x: point.x, y: point.y })
    return this.actionResult(`Hovered ${ref}`)
  }

  async fill(ref: string, value: string): Promise<BrowserActionResult> {
    this.assertRef(ref)
    const contents = this.requirePage()
    // Select through the DOM, then insert through Chromium's native editing
    // pipeline. Assigning textContent/value only changes the rendered DOM and
    // leaves stateful editors (Draft.js, ProseMirror, X's composer, etc.)
    // unaware of the new text.
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
      contents.insertText(value)
    } else {
      // insertText('') does not replace the active selection, so preserve the
      // expected "fill with empty text" behavior through the same native path.
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
        if (this.lastBounds) view.setBounds(sanitizeBounds(this.lastBounds, win))
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
