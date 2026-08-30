const DEFAULT_ENDPOINT = 'http://127.0.0.1:49321'
const ENDPOINT_COUNT = 10
const EXTENSION_ID = 'nkfblackdfiplaekehijkgimhmlhlfib'
const POLL_ALARM = 'codey-companion-poll'
const CONTROLLED_TAB_KEY = 'controlledTabId'
const CONTROLLED_TITLE_PREFIX = '● Codey · '
const OFFSCREEN_DOCUMENT = 'offscreen.html'
let polling = false
let controlledTabId = null
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

async function autoConnect() {
  const current = await settings()
  const endpoints = [current.endpoint, ...Array.from({ length: ENDPOINT_COUNT }, (_, index) => `http://127.0.0.1:${49321 + index}`)]
  for (const endpoint of [...new Set(endpoints)]) {
    try {
      const value = await call(endpoint, '/v1/connect', {
        extensionIdentity: true,
        discovery: true,
        body: { clientName: `Chrome ${navigator.userAgent.match(/Chrome\/([\d.]+)/)?.[1] || ''}`.trim() },
      })
      await chrome.storage.local.set({ endpoint, token: value.token, lastError: '' })
      return { endpoint, token: value.token }
    } catch { /* Codey may be on the next port in the local discovery range. */ }
  }
  throw new Error('Codey is not running or the Chrome Companion bridge is unavailable')
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
      args: [enabled, CONTROLLED_TITLE_PREFIX],
      func: (shouldShow, prefix) => {
        const stateKey = '__codeyChromeCompanionIndicator'
        const existing = window[stateKey]
        if (existing?.observer) existing.observer.disconnect()

        const removePrefix = () => {
          if (document.title.startsWith(prefix)) document.title = document.title.slice(prefix.length)
        }
        removePrefix()
        if (!shouldShow) {
          delete window[stateKey]
          return
        }

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

async function clearTabIndicator(tabId) {
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
    chrome.action.setBadgeBackgroundColor({ tabId, color: '#3377D5' }),
    chrome.action.setBadgeTextColor({ tabId, color: '#FFFFFF' }),
    chrome.action.setBadgeText({ tabId, text: 'ON' }),
    chrome.action.setTitle({ tabId, title: 'Codey is controlling this tab' }),
    setPageIndicator(tabId, true),
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
    func: () => ({
      text: (document.body?.innerText || '').slice(0, 100000),
      links: Array.from(document.querySelectorAll('a[href]')).slice(0, 250).map(link => ({
        text: (link.textContent || '').trim().slice(0, 300),
        href: link.href,
      })),
      forms: Array.from(document.querySelectorAll('input, textarea, select, button')).slice(0, 250).map(element => ({
        tag: element.tagName.toLowerCase(),
        type: element.getAttribute('type') || '',
        name: element.getAttribute('name') || '',
        placeholder: element.getAttribute('placeholder') || '',
      })),
    }),
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
    cookies: cookies.map(cookie => ({
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain.replace(/^\./, ''),
      path: cookie.path || '/',
      expires: typeof cookie.expirationDate === 'number' ? cookie.expirationDate : -1,
      httpOnly: cookie.httpOnly === true,
      secure: cookie.secure === true,
      sameSite: cookie.sameSite || 'unspecified',
      ...(cookie.hostOnly ? { hostOnly: true } : {}),
    })),
    origins: storage?.origin
      ? [{ origin: storage.origin, localStorage: storage.localStorage || [] }]
      : [],
  }
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

async function pollOnce() {
  let { endpoint, token } = await settings()
  if (!token) ({ endpoint, token } = await autoConnect())
  let response
  try {
    response = await call(endpoint, '/v1/poll', { token })
  } catch (error) {
    if (!/Unauthorized/i.test(error instanceof Error ? error.message : String(error))) throw error
    ;({ endpoint, token } = await autoConnect())
    response = await call(endpoint, '/v1/poll', { token })
  }
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

runSafely(restoreControlledTab)
runSafely(configureSidePanel)
runSafely(pollLoop)
