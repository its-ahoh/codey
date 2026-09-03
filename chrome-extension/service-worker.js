// `siteOfHost`: kept in its own file so it can be tested without Chrome.
// It needs the real Public Suffix List (tldts) loaded first.
importScripts('vendor/tldts.min.js', 'site-grouping.js')

const DEFAULT_ENDPOINT = 'http://127.0.0.1:49321'
const ENDPOINT_COUNT = 10
const EXTENSION_ID = 'nkfblackdfiplaekehijkgimhmlhlfib'
const POLL_ALARM = 'codey-companion-poll'
const CONTROLLED_TAB_KEY = 'controlledTabId'
const CONTROLLED_TITLE_PREFIX = '● Codey · '
const OFFSCREEN_DOCUMENT = 'offscreen.html'
const CONTROLLED_GROUP_TITLE = 'Codey'
// How long one opt-in "open the missing sites" pass may take in total. Kept
// under the bridge's own timeout for that command so Codey hears an answer.
const STORAGE_VISIT_BUDGET_MS = 25_000
// Stamped on interactive elements by `snapshot` so click/fill can address the
// same element later. Renumbered on every snapshot.
const REF_ATTR = 'data-codey-ref'
const ACCENT_KEY = 'accent'
// Toolbar badge: a green chip with a white check, independent of the accent so
// "Codey is driving this tab" always reads as an OK signal.
const BADGE_TEXT = '\u2713'
const BADGE_BG = '#1e8e3e'
const BADGE_FG = '#ffffff'
const DEFAULT_ACCENT = '#3377d5'
// Chrome only accepts these nine names for a tab group, so the Mac app's accent
// hex is snapped to whichever one sits closest in RGB space.
const GROUP_COLORS = {
  grey: [95, 99, 104],
  blue: [26, 115, 232],
  red: [217, 48, 37],
  yellow: [249, 171, 0],
  green: [30, 142, 62],
  pink: [208, 24, 132],
  purple: [147, 52, 230],
  cyan: [0, 123, 131],
  orange: [250, 144, 62],
}
let polling = false
let controlledTabId = null
let controlledGroupId = null
let accent = DEFAULT_ACCENT
let creatingOffscreenDocument = null
let voicePort = null
let voiceRequestId = 0
const pendingVoiceRequests = new Map()
const voicePortWaiters = new Set()

function isExpectedLifecycleError(error) {
  const message = error instanceof Error ? error.message : String(error)
  return /No SW|Extension context invalidated|The message port closed|Receiving end does not exist/i.test(message)
}

function runSafely(operation) {
  void Promise.resolve()
    .then(operation)
    .catch(error => {
      if (!isExpectedLifecycleError(error)) console.warn('[Codey]', error)
    })
}

async function configureSidePanel() {
  if (!chrome.sidePanel?.setPanelBehavior) return
  try { await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }) }
  catch { /* Older Chrome builds keep the extension usable without the panel shortcut. */ }
}

async function ensureOffscreenDocument() {
  if (!chrome.offscreen) throw new Error('Update Chrome to use Codey voice input')
  if (typeof chrome.offscreen.hasDocument === 'function' && await chrome.offscreen.hasDocument()) return
  if (typeof chrome.runtime.getContexts === 'function') {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [chrome.runtime.getURL(OFFSCREEN_DOCUMENT)],
    })
    if (contexts.length) return
  }
  if (!creatingOffscreenDocument) {
    creatingOffscreenDocument = chrome.offscreen.createDocument({
      url: OFFSCREEN_DOCUMENT,
      reasons: ['USER_MEDIA'],
      justification: 'Record microphone audio after the user starts Codey voice input',
    }).finally(() => { creatingOffscreenDocument = null })
  }
  await creatingOffscreenDocument
}

async function waitForVoicePort() {
  if (voicePort) return voicePort
  return await new Promise((resolve, reject) => {
    const waiter = port => {
      clearTimeout(timeout)
      voicePortWaiters.delete(waiter)
      resolve(port)
    }
    const timeout = setTimeout(() => {
      voicePortWaiters.delete(waiter)
      reject(new Error('Chrome voice recorder did not initialize'))
    }, 3000)
    voicePortWaiters.add(waiter)
  })
}

async function voiceCommand(message) {
  await ensureOffscreenDocument()
  const port = await waitForVoicePort()
  const id = ++voiceRequestId
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingVoiceRequests.delete(id)
      reject(new Error('Chrome voice recorder did not respond'))
    }, 15000)
    pendingVoiceRequests.set(id, { resolve, reject, timeout })
    try {
      port.postMessage({ id, ...message })
    } catch (error) {
      clearTimeout(timeout)
      pendingVoiceRequests.delete(id)
      reject(error)
    }
  })
}

async function settings() {
  return await chrome.storage.local.get({ endpoint: DEFAULT_ENDPOINT, token: '', clientName: 'Chrome' })
}

async function call(endpoint, path, options = {}) {
  const response = await fetch(`${endpoint}${path}`, {
    method: options.method || 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      ...(options.extensionIdentity ? { 'X-Codey-Extension-Id': EXTENSION_ID } : {}),
    },
    body: options.body === undefined ? '{}' : JSON.stringify(options.body),
    cache: 'no-store',
    ...(options.discovery ? { signal: AbortSignal.timeout(1000) } : {}),
  })
  const value = await response.json().catch(() => ({ ok: false, error: `HTTP ${response.status}` }))
  if (!response.ok || value.ok === false) throw new Error(value.error || `HTTP ${response.status}`)
  return value
}

/** The pairing secret Codey wrote into this extension's folder when it staged
 *  it. Shared only between Codey and these files on disk, it is what lets the
 *  two ends recognise each other instead of trusting whoever owns the port. */
async function pairingSecret() {
  try {
    const response = await fetch(chrome.runtime.getURL('pairing.json'))
    const value = await response.json()
    return typeof value.secret === 'string' && value.secret ? value.secret : null
  } catch {
    return null
  }
}

async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message))
  return Array.from(new Uint8Array(signature), byte => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * Find Codey and pair with it - mutually. Anything can listen on a loopback
 * port, so "it answered /v1/connect" proves nothing: both sides must show they
 * hold the pairing secret Codey staged next to this file. The extension sends
 * a proof over a fresh nonce, and only accepts a token accompanied by the
 * server's own proof over that nonce and token. A listener without the secret
 * gets no cookies and issues no commands.
 */
async function autoConnect() {
  const current = await settings()
  const secret = await pairingSecret()
  const endpoints = [current.endpoint, ...Array.from({ length: ENDPOINT_COUNT }, (_, index) => `http://127.0.0.1:${49321 + index}`)]
  for (const endpoint of [...new Set(endpoints)]) {
    try {
      const clientName = `Chrome ${navigator.userAgent.match(/Chrome\/([\d.]+)/)?.[1] || ''}`.trim()
      const nonce = crypto.randomUUID()
      const value = await call(endpoint, '/v1/connect', {
        extensionIdentity: true,
        discovery: true,
        body: secret
          ? { clientName, nonce, proof: await hmacHex(secret, `codey-client:${nonce}`) }
          : { clientName },
      })
      if (secret) {
        const expected = await hmacHex(secret, `codey-server:${nonce}:${value.token}`)
        if (value.serverProof !== expected) throw new Error('The endpoint could not prove it is Codey')
      }
      await chrome.storage.local.set({ endpoint, token: value.token, lastError: '' })
      return { endpoint, token: value.token }
    } catch { /* Codey may be on the next port in the local discovery range. */ }
  }
  throw new Error(secret
    ? 'Codey is not running or the Chrome Companion bridge is unavailable'
    : 'This copy of the extension has no pairing secret - reinstall it from Codey’s Chrome settings')
}

function rgbOf(hex) {
  const value = /^#?([0-9a-fA-F]{6})$/.exec(String(hex || ''))
  if (!value) return null
  const int = parseInt(value[1], 16)
  return [(int >> 16) & 255, (int >> 8) & 255, int & 255]
}

/** The Chrome tab-group color name closest to the accent. */
function nearestGroupColor(hex) {
  const rgb = rgbOf(hex)
  if (!rgb) return 'blue'
  let best = 'blue'
  let bestDistance = Infinity
  for (const [name, target] of Object.entries(GROUP_COLORS)) {
    const distance = target.reduce((sum, channel, index) => sum + (channel - rgb[index]) ** 2, 0)
    if (distance < bestDistance) {
      bestDistance = distance
      best = name
    }
  }
  return best
}

/**
 * Adopt the accent the Mac app reports on each poll. Repaints the live
 * indicators immediately so a palette switch shows up without a reload.
 */
async function applyAccent(hex) {
  const next = rgbOf(hex) ? String(hex).toLowerCase() : DEFAULT_ACCENT
  if (next === accent) return
  accent = next
  await chrome.storage.local.set({ [ACCENT_KEY]: accent })
  if (typeof controlledTabId === 'number') await markControlledTab(controlledTabId)
}

async function restoreAccent() {
  const saved = await chrome.storage.local.get({ [ACCENT_KEY]: DEFAULT_ACCENT })
  if (rgbOf(saved[ACCENT_KEY])) accent = String(saved[ACCENT_KEY]).toLowerCase()
}

async function activeTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true })
  const tab = tabs[0]
  if (!tab || typeof tab.id !== 'number') throw new Error('Chrome has no active tab')
  return {
    id: tab.id,
    windowId: tab.windowId,
    title: tab.title || '',
    url: tab.url || '',
    ...(tab.favIconUrl ? { favIconUrl: tab.favIconUrl } : {}),
  }
}

async function setPageIndicator(tabId, enabled) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      args: [enabled, CONTROLLED_TITLE_PREFIX, accent],
      func: (shouldShow, prefix, color) => {
        const stateKey = '__codeyChromeCompanionIndicator'
        const frameId = '__codey-companion-frame'
        const existing = window[stateKey]
        if (existing?.observer) existing.observer.disconnect()

        const removePrefix = () => {
          if (document.title.startsWith(prefix)) document.title = document.title.slice(prefix.length)
        }
        const removeFrame = () => document.getElementById(frameId)?.remove()
        removePrefix()
        removeFrame()
        if (!shouldShow) {
          delete window[stateKey]
          return
        }

        // A viewport-pinned frame so the controlled page is obvious even when the
        // tab strip is too crowded to show the title prefix.
        const drawFrame = () => {
          if (!document.body || document.getElementById(frameId)) return
          const frame = document.createElement('div')
          frame.id = frameId
          frame.setAttribute('aria-hidden', 'true')
          frame.style.cssText = [
            'position:fixed',
            'inset:0',
            'pointer-events:none',
            'z-index:2147483647',
            `border:3px solid ${color}`,
            `box-shadow:inset 0 0 12px ${color}73`,
            'border-radius:2px',
          ].join(';')
          document.body.appendChild(frame)
        }
        drawFrame()
        if (!document.body) document.addEventListener('DOMContentLoaded', drawFrame, { once: true })

        let applying = false
        const applyPrefix = () => {
          if (applying || document.title.startsWith(prefix)) return
          applying = true
          document.title = `${prefix}${document.title}`
          applying = false
        }
        applyPrefix()
        const title = document.querySelector('title') || document.head?.appendChild(document.createElement('title'))
        const observer = new MutationObserver(applyPrefix)
        if (title) observer.observe(title, { childList: true, characterData: true, subtree: true })
        window[stateKey] = { observer }
      },
    })
  } catch {
    // Chrome internal pages cannot be scripted; the per-tab action badge still
    // identifies the controlled tab whenever the extension icon is visible.
  }
}

// Tab groups are the only Chrome-supported way to tint the tab strip itself.
// Tabs the user already grouped are left alone so we never break their layout.
async function groupControlledTab(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId)
    if (typeof tab.groupId === 'number' && tab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE) {
      if (tab.groupId !== controlledGroupId) return
    }
    const groupId = await chrome.tabs.group({ tabIds: [tabId] })
    controlledGroupId = groupId
    await chrome.tabGroups.update(groupId, { title: CONTROLLED_GROUP_TITLE, color: nearestGroupColor(accent) })
  } catch {
    // Grouping is unavailable in some windows (e.g. popups); badges still apply.
  }
}

async function ungroupControlledTab(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId)
    if (tab.groupId !== controlledGroupId) return
    await chrome.tabs.ungroup(tabId)
  } catch {
    // The tab or group is already gone.
  } finally {
    controlledGroupId = null
  }
}

async function clearTabIndicator(tabId) {
  await ungroupControlledTab(tabId)
  await Promise.allSettled([
    chrome.action.setBadgeText({ tabId, text: '' }),
    chrome.action.setTitle({ tabId, title: 'Codey' }),
    setPageIndicator(tabId, false),
  ])
}

async function markControlledTab(tabId) {
  const previous = controlledTabId
  controlledTabId = tabId
  await chrome.storage.local.set({ [CONTROLLED_TAB_KEY]: tabId })
  if (typeof previous === 'number' && previous !== tabId) await clearTabIndicator(previous)
  await Promise.allSettled([
    chrome.action.setBadgeBackgroundColor({ tabId, color: BADGE_BG }),
    chrome.action.setBadgeTextColor({ tabId, color: BADGE_FG }),
    chrome.action.setBadgeText({ tabId, text: BADGE_TEXT }),
    chrome.action.setTitle({ tabId, title: 'Codey is controlling this tab' }),
    setPageIndicator(tabId, true),
    groupControlledTab(tabId),
  ])
}

async function clearControlledTab() {
  const previous = controlledTabId
  controlledTabId = null
  await chrome.storage.local.remove(CONTROLLED_TAB_KEY)
  if (typeof previous === 'number') await clearTabIndicator(previous)
}

async function restoreControlledTab() {
  const saved = await chrome.storage.local.get({ [CONTROLLED_TAB_KEY]: null })
  if (typeof saved[CONTROLLED_TAB_KEY] !== 'number') return
  controlledTabId = saved[CONTROLLED_TAB_KEY]
  await markControlledTab(controlledTabId)
}

async function snapshot() {
  const tab = await activeTab()
  if (!/^https?:\/\//i.test(tab.url)) throw new Error('Only http(s) pages can be read')
  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    args: [REF_ATTR],
    func: refAttr => {
      // Refs are stamped onto the live DOM so a later click/fill can find the
      // same element without re-running the whole snapshot. Every snapshot
      // renumbers from scratch, so a stale ref fails loudly instead of acting
      // on whatever element inherited the number.
      document.querySelectorAll(`[${refAttr}]`).forEach(element => element.removeAttribute(refAttr))
      let counter = 0
      const stamp = element => {
        const ref = `e${++counter}`
        element.setAttribute(refAttr, ref)
        return ref
      }
      return {
        text: (document.body?.innerText || '').slice(0, 100000),
        links: Array.from(document.querySelectorAll('a[href]')).slice(0, 250).map(link => ({
          ref: stamp(link),
          text: (link.textContent || '').trim().slice(0, 300),
          href: link.href,
        })),
        forms: Array.from(document.querySelectorAll('input, textarea, select, button, [role="button"], [contenteditable="true"]')).slice(0, 250).map(element => ({
          ref: stamp(element),
          tag: element.tagName.toLowerCase(),
          type: element.getAttribute('type') || '',
          name: element.getAttribute('name') || '',
          placeholder: element.getAttribute('placeholder') || '',
          label: (element.getAttribute('aria-label') || element.value || element.textContent || '').trim().slice(0, 120),
        })),
      }
    },
  })
  const page = results[0]?.result
  if (!page) throw new Error('Chrome did not return a page snapshot')
  return { tab, ...page }
}

async function exportSession() {
  const tab = await activeTab()
  if (!/^https?:\/\//i.test(tab.url)) throw new Error('Only http(s) site sessions can be exported')
  const cookies = await chrome.cookies.getAll({ url: tab.url })
  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => ({
      origin: location.origin,
      localStorage: Array.from({ length: localStorage.length }, (_, index) => {
        const name = localStorage.key(index)
        return name === null ? null : { name, value: localStorage.getItem(name) || '' }
      }).filter(Boolean),
    }),
  })
  const storage = results[0]?.result
  return {
    tab,
    cookies: cookies.map(toExportedCookie),
    origins: storage?.origin
      ? [{ origin: storage.origin, localStorage: storage.localStorage || [] }]
      : [],
  }
}

/** Chrome's cookie shape in the profile format Codey stores. */
function toExportedCookie(cookie) {
  return {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain.replace(/^\./, ''),
    path: cookie.path || '/',
    expires: typeof cookie.expirationDate === 'number' ? cookie.expirationDate : -1,
    httpOnly: cookie.httpOnly === true,
    secure: cookie.secure === true,
    sameSite: cookie.sameSite || 'unspecified',
    ...(cookie.hostOnly ? { hostOnly: true } : {}),
  }
}

/**
 * Every site this Chrome profile holds a login-shaped cookie for, so Codey can
 * show the user a list to pick from instead of copying the whole cookie jar.
 * Counts come from the cookie store, and `openTabs` says whether localStorage
 * would come along - it can only be read from a page that is actually open.
 */
async function listSessionSites() {
  const cookies = await chrome.cookies.getAll({})
  const sites = new Map()
  for (const cookie of cookies) {
    const site = siteOfHost(cookie.domain)
    if (!site) continue
    const entry = sites.get(site) || { site, cookieCount: 0, openTabs: 0 }
    entry.cookieCount += 1
    sites.set(site, entry)
  }
  const tabs = await chrome.tabs.query({})
  for (const tab of tabs) {
    if (!/^https?:\/\//i.test(tab.url || '')) continue
    try {
      const entry = sites.get(siteOfHost(new URL(tab.url).hostname))
      if (entry) entry.openTabs += 1
    } catch { /* a URL Chrome accepted but we cannot parse is not a site */ }
  }
  // Most cookies first: that is roughly "most signed in", and it puts the
  // sites a user actually recognises at the top of a long list.
  return { sites: [...sites.values()].sort((a, b) => b.cookieCount - a.cookieCount || a.site.localeCompare(b.site)) }
}

/** Read one tab's localStorage. Storage can only be reached by running inside
 *  the page, so every path that wants it ends up here. */
async function readTabStorage(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => ({
      origin: location.origin,
      localStorage: Array.from({ length: localStorage.length }, (_, index) => {
        const name = localStorage.key(index)
        return name === null ? null : { name, value: localStorage.getItem(name) || '' }
      }).filter(Boolean),
    }),
  })
  return results[0]?.result ?? null
}

/** Resolve once a tab has finished loading, or reject at the deadline. */
function whenTabLoaded(tabId, deadline) {
  return new Promise((resolve, reject) => {
    let timer = null
    const finish = settle => {
      chrome.tabs.onUpdated.removeListener(listener)
      if (timer !== null) clearTimeout(timer)
      settle()
    }
    const listener = (id, info) => { if (id === tabId && info.status === 'complete') finish(resolve) }
    chrome.tabs.onUpdated.addListener(listener)
    timer = setTimeout(() => finish(() => reject(new Error('Timed out loading the page'))),
      Math.max(0, deadline - Date.now()))
    // A page that finished before the listener was attached would never fire.
    chrome.tabs.get(tabId)
      .then(tab => { if (tab.status === 'complete') finish(resolve) })
      .catch(() => { /* the poll below is only a shortcut; the listener still stands */ })
  })
}

/**
 * Open a page in the background purely to read its storage, then close it.
 *
 * This is the part the user has to opt into: it is a real navigation in their
 * own Chrome - a tab appears in the strip, the site is contacted, and anything
 * the page does on load happens. Failure is not fatal; the site still travels
 * with its cookies.
 */
async function visitForStorage(url, deadline) {
  let tab = null
  try {
    tab = await chrome.tabs.create({ url, active: false })
    await whenTabLoaded(tab.id, deadline)
    return await readTabStorage(tab.id)
  } catch {
    return null
  } finally {
    if (tab?.id !== undefined) {
      try { await chrome.tabs.remove(tab.id) } catch { /* the user may have closed it already */ }
    }
  }
}

/**
 * Export only the sites the user ticked. Cookies come from the cookie store, so
 * nothing has to be open; localStorage is read from whatever tabs happen to be
 * on those sites. When `openMissing` is set the user has agreed to pay for the
 * rest by having the remaining sites opened in the background and closed again,
 * which is the only way to reach storage for a site with no tab.
 */
async function exportSessionForSites(requested, openMissing = false) {
  const wanted = new Set((Array.isArray(requested) ? requested : [])
    .map(site => siteOfHost(site))
    .filter(Boolean))
  if (wanted.size === 0) throw new Error('Pick at least one site to copy')
  const cookies = (await chrome.cookies.getAll({}))
    .filter(cookie => wanted.has(siteOfHost(cookie.domain)))
  if (cookies.length === 0) throw new Error('Chrome has no cookies for the sites you picked')
  const origins = []
  const seen = new Set()
  for (const tab of await chrome.tabs.query({})) {
    if (typeof tab.id !== 'number' || !/^https?:\/\//i.test(tab.url || '')) continue
    let origin
    try {
      const parsed = new URL(tab.url)
      if (!wanted.has(siteOfHost(parsed.hostname)) || seen.has(parsed.origin)) continue
      origin = parsed.origin
    } catch {
      continue
    }
    seen.add(origin)
    try {
      const storage = await readTabStorage(tab.id)
      if (storage?.localStorage?.length > 0) origins.push({ origin, localStorage: storage.localStorage })
    } catch {
      // A tab that refuses injection costs us its storage, not its cookies.
    }
  }
  let finalCookies = cookies
  if (openMissing) {
    // One shared deadline rather than one per site: the whole command still has
    // to answer Codey before it gives up, however many pages were planned.
    const deadline = Date.now() + STORAGE_VISIT_BUDGET_MS
    const plan = storageVisitPlan([...wanted], cookies.map(cookie => cookie.domain), [...seen])
    const visited = await Promise.all(plan.map(entry => visitForStorage(entry.url, deadline)))
    for (const storage of visited) {
      if (!storage?.origin || !(storage.localStorage?.length > 0) || seen.has(storage.origin)) continue
      seen.add(storage.origin)
      origins.push({ origin: storage.origin, localStorage: storage.localStorage })
    }
    // Those visits were real navigations, and sites rotate session cookies on
    // load. Re-read the jar so the export carries what the sites hold *now*,
    // not the snapshot from before the pages ran.
    finalCookies = (await chrome.cookies.getAll({}))
      .filter(cookie => wanted.has(siteOfHost(cookie.domain)))
    if (finalCookies.length === 0) finalCookies = cookies
  }
  return { sites: [...wanted], cookies: finalCookies.map(toExportedCookie), origins }
}

// ── Acting on a page ────────────────────────────────────────────────────
// Every action resolves a ref stamped by the last `snapshot`, runs inside the
// page, and reports back what it touched so the caller never has to assume an
// action landed. Codey asks the user to approve these before they get here.
async function interact(action, ref, payload) {
  const tab = await activeTab()
  if (!/^https?:\/\//i.test(tab.url)) throw new Error('Only http(s) pages can be acted on')
  if (!/^e\d+$/.test(String(ref || ''))) throw new Error(`Invalid element ref: ${ref}. Run "chrome view" first.`)
  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    args: [REF_ATTR, action, String(ref), payload ?? null],
    func: (refAttr, kind, elementRef, input) => {
      const element = document.querySelector(`[${refAttr}="${elementRef}"]`)
      if (!element) return { ok: false, error: `No element ${elementRef} on this page. Run "chrome view" again to refresh refs.` }
      const describe = () => ({
        tag: element.tagName.toLowerCase(),
        text: (element.getAttribute('aria-label') || element.value || element.textContent || '').trim().slice(0, 200),
      })
      const fire = (...names) => names.forEach(name => element.dispatchEvent(new Event(name, { bubbles: true })))
      // Frameworks like React track the input value on the DOM node itself, so
      // a plain `element.value = x` is silently reverted on the next render.
      // Going through the prototype setter is what makes the change stick.
      const setValue = value => {
        const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
        const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
        if (setter) setter.call(element, value)
        else element.value = value
      }
      try {
        element.scrollIntoView({ block: 'center', inline: 'center' })
        switch (kind) {
          case 'click':
            element.click()
            break
          case 'fill': {
            const value = String(input ?? '')
            element.focus()
            if (element.isContentEditable) {
              element.textContent = value
              fire('input', 'change')
              break
            }
            setValue(value)
            fire('input', 'change')
            break
          }
          case 'select':
            element.value = String(input ?? '')
            if (element.selectedIndex === -1) return { ok: false, error: `No option "${input}" in ${elementRef}` }
            fire('input', 'change')
            break
          case 'check':
            if (element.checked !== Boolean(input)) element.click()
            break
          case 'press': {
            const key = String(input ?? '')
            element.focus()
            for (const type of ['keydown', 'keypress', 'keyup']) {
              element.dispatchEvent(new KeyboardEvent(type, { key, bubbles: true, cancelable: true }))
            }
            // Synthetic key events never submit a form on their own, so Enter
            // inside a form is completed the way the browser would.
            if (key === 'Enter' && element.form) element.form.requestSubmit()
            break
          }
          default:
            return { ok: false, error: `Unsupported page action: ${kind}` }
        }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
      return { ok: true, element: describe(), url: location.href, title: document.title }
    },
  })
  const outcome = results[0]?.result
  if (!outcome) throw new Error('Chrome did not report the result of the action')
  if (!outcome.ok) throw new Error(outcome.error || 'The page action failed')
  return { tab: { ...tab, url: outcome.url, title: outcome.title }, element: outcome.element }
}

async function execute(command) {
  switch (command.command) {
    case 'activeTab': {
      const tab = await activeTab()
      await markControlledTab(tab.id)
      return tab
    }
    case 'snapshot': {
      const page = await snapshot()
      await markControlledTab(page.tab.id)
      return page
    }
    case 'exportSession': {
      const session = await exportSession()
      await markControlledTab(session.tab.id)
      return session
    }
    // None of these act on a page, so no tab is marked as controlled.
    case 'listSessionSites':
      return await listSessionSites()
    case 'exportSessionForSites':
      return await exportSessionForSites(command.input?.sites, command.input?.openMissing === true)
    case 'click':
    case 'fill':
    case 'select':
    case 'check':
    case 'press': {
      const result = await interact(command.command, command.input?.ref, command.input?.value)
      await markControlledTab(result.tab.id)
      return result
    }
    case 'navigate': {
      const url = String(command.input?.url || '')
      if (!/^https?:\/\//i.test(url)) throw new Error('Only http(s) URLs are allowed')
      const tab = await activeTab()
      await markControlledTab(tab.id)
      await chrome.tabs.update(tab.id, { url })
      return { ...tab, url }
    }
    default:
      throw new Error(`Unsupported Codey command: ${command.command}`)
  }
}

// Reported on every poll rather than only when pairing: reloading the
// extension keeps the stored token, so it never pairs again, and a version
// captured at pairing time would stay stale forever.
function ownVersion() {
  try { return chrome.runtime.getManifest().version || '' } catch { return '' }
}

// Codey re-stages the new extension files on its own launch, but Chrome only
// re-reads an unpacked extension when it restarts or the user reloads it. Codey
// tells us which version is on disk so the panel can say so out loud.
async function noteExpectedVersion(expected) {
  const stale = typeof expected === 'string' && expected && expected !== ownVersion() ? expected : ''
  const saved = await chrome.storage.local.get({ updateAvailable: '' })
  if (saved.updateAvailable === stale) return
  await chrome.storage.local.set({ updateAvailable: stale })
}

// ── Auto-sync ───────────────────────────────────────────────────────────
// Codey's poll response names the cookie domains its saved profiles hold.
// When one of them changes here, Codey is told *which domain* changed and
// nothing else - it then pulls a fresh export through the normal command
// channel. No cookie values ride this path.
let watchDomains = []
let changedDomains = new Set()
let changedFlushTimer = null

async function noteWatchDomains(domains) {
  const next = Array.isArray(domains) ? domains.filter(entry => typeof entry === 'string' && entry) : []
  watchDomains = next
  const saved = await chrome.storage.local.get({ watchDomains: [] })
  if (JSON.stringify(saved.watchDomains) !== JSON.stringify(next)) {
    await chrome.storage.local.set({ watchDomains: next })
  }
}

async function reportChangedDomains() {
  const domains = [...changedDomains]
  changedDomains.clear()
  if (domains.length === 0) return
  const { endpoint, token } = await settings()
  if (!token) return
  await call(endpoint, '/v1/session/changed', { token, body: { domains } })
}

chrome.cookies.onChanged.addListener(({ cookie }) => {
  const host = String(cookie?.domain || '').replace(/^\./, '').toLowerCase()
  if (!host) return
  runSafely(async () => {
    // The worker may have restarted since the last poll delivered the list.
    if (watchDomains.length === 0) {
      const saved = await chrome.storage.local.get({ watchDomains: [] })
      watchDomains = Array.isArray(saved.watchDomains) ? saved.watchDomains : []
    }
    if (!watchDomains.some(domain => domainsTouch(host, domain))) return
    changedDomains.add(host)
    // A login flow sets a burst of cookies; report the burst once.
    if (changedFlushTimer) clearTimeout(changedFlushTimer)
    changedFlushTimer = setTimeout(() => {
      changedFlushTimer = null
      runSafely(reportChangedDomains)
    }, 2000)
  })
})

async function pollOnce() {
  let { endpoint, token } = await settings()
  if (!token) ({ endpoint, token } = await autoConnect())
  const body = { version: ownVersion() }
  let response
  try {
    response = await call(endpoint, '/v1/poll', { token, body })
  } catch (error) {
    if (!/Unauthorized/i.test(error instanceof Error ? error.message : String(error))) throw error
    ;({ endpoint, token } = await autoConnect())
    response = await call(endpoint, '/v1/poll', { token, body })
  }
  await noteExpectedVersion(response.expectedVersion)
  if (response.accent) await applyAccent(response.accent)
  if (response.watchDomains !== undefined) await noteWatchDomains(response.watchDomains)
  if (!response.command) return true
  const command = response.command
  try {
    const data = await execute(command)
    await call(endpoint, '/v1/result', { token, body: { id: command.id, ok: true, data } })
  } catch (error) {
    await call(endpoint, '/v1/result', {
      token,
      body: { id: command.id, ok: false, error: error instanceof Error ? error.message : String(error) },
    })
  }
  return true
}

async function pollLoop() {
  if (polling) return
  polling = true
  try {
    for (let index = 0; index < 20; index += 1) {
      const connected = await pollOnce()
      if (!connected) break
      await new Promise(resolve => setTimeout(resolve, 1500))
    }
  } catch (error) {
    try {
      await chrome.storage.local.set({ lastError: error instanceof Error ? error.message : String(error) })
    } catch (storageError) {
      if (!isExpectedLifecycleError(storageError)) throw storageError
    }
  } finally {
    polling = false
  }
}

chrome.runtime.onInstalled.addListener(() => {
  runSafely(() => chrome.alarms.create(POLL_ALARM, { periodInMinutes: 0.5 }))
  runSafely(configureSidePanel)
  runSafely(pollLoop)
})
chrome.runtime.onStartup.addListener(() => {
  runSafely(configureSidePanel)
  runSafely(pollLoop)
})
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === POLL_ALARM) runSafely(pollLoop) })
chrome.storage.onChanged.addListener(changes => {
  if (changes.token || changes.endpoint) runSafely(pollLoop)
  if (changes.token?.oldValue && !changes.token.newValue) runSafely(clearControlledTab)
})
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (tabId === controlledTabId && changeInfo.status === 'complete') runSafely(() => markControlledTab(tabId))
})
chrome.tabs.onRemoved.addListener(tabId => {
  if (tabId === controlledTabId) runSafely(clearControlledTab)
})
chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'codey-voice') return
  voicePort = port
  for (const waiter of voicePortWaiters) waiter(port)
  voicePortWaiters.clear()
  port.onMessage.addListener(message => {
    const pending = pendingVoiceRequests.get(message?.id)
    if (!pending) return
    clearTimeout(pending.timeout)
    pendingVoiceRequests.delete(message.id)
    pending.resolve(message.result)
  })
  port.onDisconnect.addListener(() => {
    if (voicePort === port) voicePort = null
    const error = new Error('Chrome voice recorder disconnected')
    for (const pending of pendingVoiceRequests.values()) {
      clearTimeout(pending.timeout)
      pending.reject(error)
    }
    pendingVoiceRequests.clear()
  })
})
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (['codey:voice-start', 'codey:voice-stop', 'codey:voice-cancel'].includes(message?.type)) {
    runSafely(async () => {
      try {
        const result = await voiceCommand(message)
        sendResponse(result || { ok: true })
      } catch (error) {
        sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    })
    return true
  }
  if (message?.type !== 'codey:poll' && message?.type !== 'codey:connect') return false
  runSafely(async () => {
    try {
      if (message.type === 'codey:connect') await autoConnect()
      else await pollLoop()
      sendResponse({ ok: true })
    } catch (error) {
      sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  })
  return true
})

runSafely(async () => { await restoreAccent(); await restoreControlledTab() })
runSafely(configureSidePanel)
runSafely(pollLoop)
