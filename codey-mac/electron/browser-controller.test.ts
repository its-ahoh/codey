import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { describe, expect, it, vi } from 'vitest'
import { BROWSER_PARTITION, BrowserController, isSafeBrowserNavigationUrl, normalizeBrowserUrl } from './browser-controller'

describe('normalizeBrowserUrl', () => {
  it('adds HTTPS to ordinary hosts', () => {
    expect(normalizeBrowserUrl('example.com/docs')).toBe('https://example.com/docs')
  })

  it('uses HTTP for local development hosts', () => {
    expect(normalizeBrowserUrl('localhost:5173')).toBe('http://localhost:5173/')
    expect(normalizeBrowserUrl('127.0.0.1:3000/path')).toBe('http://127.0.0.1:3000/path')
  })

  it('turns natural-language input into a search', () => {
    const nonLatinQuery = '\u5c0f\u7ea2\u4e66'
    expect(normalizeBrowserUrl('electron browser sessions')).toBe(
      'https://www.google.com/search?q=electron%20browser%20sessions',
    )
    expect(normalizeBrowserUrl('weather')).toBe('https://www.google.com/search?q=weather')
    expect(normalizeBrowserUrl(nonLatinQuery)).toBe(
      `https://www.google.com/search?q=${encodeURIComponent(nonLatinQuery)}`,
    )
  })

  it('blocks local and executable URL schemes', () => {
    expect(() => normalizeBrowserUrl('file:///tmp/secret')).toThrow('Only HTTP and HTTPS')
    expect(() => normalizeBrowserUrl('javascript:alert(1)')).toThrow('Only HTTP and HTTPS')
  })

  it('uses a persistent Electron partition', () => {
    expect(BROWSER_PARTITION).toBe('persist:codey-browser')
  })

  it('keeps mutation-like URLs behind full-control permission', () => {
    expect(isSafeBrowserNavigationUrl('https://example.com/docs/getting-started')).toBe(true)
    expect(isSafeBrowserNavigationUrl('https://example.com/profile/edit')).toBe(true)
    expect(isSafeBrowserNavigationUrl('https://example.com/logout')).toBe(false)
    expect(isSafeBrowserNavigationUrl('https://example.com/post?action=follow&id=1')).toBe(false)
    expect(isSafeBrowserNavigationUrl('javascript:alert(1)')).toBe(false)
  })
})

describe('BrowserController agent controls', () => {
  function setup(executeResult: unknown = true) {
    let debuggerAttached = false
    const contents = {
      isDestroyed: vi.fn(() => false),
      getURL: vi.fn(() => 'https://example.com/form'),
      getTitle: vi.fn(() => 'Example Dashboard'),
      executeJavaScript: vi.fn(async (_script: string) => executeResult),
      sendInputEvent: vi.fn(),
      debugger: {
        isAttached: vi.fn(() => debuggerAttached),
        attach: vi.fn(() => { debuggerAttached = true }),
        detach: vi.fn(() => { debuggerAttached = false }),
        sendCommand: vi.fn(async (command: string) => command === 'DOM.getDocument'
          ? { root: { nodeId: 1 } }
          : command === 'DOM.querySelector' ? { nodeId: 2 } : {}),
      },
    }
    const controller = new BrowserController(() => null, vi.fn())
    ;(controller as any).view = { webContents: contents }
    return { controller, contents }
  }

  it('performs a trusted click at the snapshotted element center', async () => {
    const { controller, contents } = setup({ x: 120, y: 80 })
    await expect(controller.click('e2')).resolves.toMatchObject({ ok: true, message: 'Clicked e2' })
    expect(contents.sendInputEvent.mock.calls.map(call => call[0].type)).toEqual([
      'mouseMove', 'mouseDown', 'mouseUp',
    ])
    expect(contents.sendInputEvent).toHaveBeenLastCalledWith(expect.objectContaining({ x: 120, y: 80 }))
  })

  it('follows a safe page link directly without dispatching its click handler', async () => {
    const target = { url: 'https://example.com/docs', newTab: false }
    const contents = {
      isDestroyed: vi.fn(() => false),
      getURL: vi.fn(() => 'https://example.com/start'),
      executeJavaScript: vi.fn(async (_script: string) => target),
      loadURL: vi.fn(async () => {}),
    }
    const controller = new BrowserController(() => null, vi.fn())
    ;(controller as any).view = { webContents: contents }

    await expect(controller.follow('e3')).resolves.toMatchObject({
      ok: true,
      url: target.url,
      message: `Opened link: ${target.url}`,
    })
    expect(contents.loadURL).toHaveBeenCalledWith(target.url)
    const script = contents.executeJavaScript.mock.calls[0][0]
    expect(script).toContain("el.closest('a[href]')")
    expect(script).toContain('logout')
    expect('sendInputEvent' in contents).toBe(false)
  })

  it('leaves non-links and mutation-like links for the full-control click path', async () => {
    const contents = {
      isDestroyed: vi.fn(() => false),
      getURL: vi.fn(() => 'https://example.com/settings'),
      executeJavaScript: vi.fn(async () => null),
      loadURL: vi.fn(),
    }
    const controller = new BrowserController(() => null, vi.fn())
    ;(controller as any).view = { webContents: contents }

    await expect(controller.follow('e4')).resolves.toBeNull()
    expect(contents.loadURL).not.toHaveBeenCalled()
  })

  it('reads only privacy-preserving login signals for a specific tab', async () => {
    const result = {
      url: 'https://example.com/login', title: 'Sign in', authLikely: true,
      loggedInLikely: false, statusKey: 'opaque-hash',
    }
    const contents = {
      isDestroyed: vi.fn(() => false),
      getURL: vi.fn(() => result.url),
      getTitle: vi.fn(() => result.title),
      isLoading: vi.fn(() => false),
      executeJavaScript: vi.fn(async (_script: string) => result),
    }
    const controller = new BrowserController(() => null, vi.fn())
    ;(controller as any).tabs = [{ id: 'login-tab', view: { webContents: contents } }]

    await expect(controller.getLoginStatus('login-tab')).resolves.toEqual({
      tabId: 'login-tab', loading: false, ...result,
    })
    const script = contents.executeJavaScript.mock.calls[0][0]
    expect(script).not.toContain('document.cookie')
    expect(script).not.toContain('localStorage')
    expect(script).not.toContain('sessionStorage')
  })

  it('safely embeds field values and dispatches the page-side fill script', async () => {
    const { controller, contents } = setup(true)
    await controller.fill('e4', `Jack's "post"`)
    const script = contents.executeJavaScript.mock.calls[0][0]
    expect(script).toContain(`Jack's \\"post\\"`)
    expect(script).toContain("dispatchEvent(new InputEvent('input'")
  })

  it('supports coordinate clicks and drag gestures for maps and canvases', async () => {
    const { controller, contents } = setup(true)
    await controller.clickAt(20.4, 30.6, 2)
    expect(contents.sendInputEvent.mock.calls.map(call => call[0].type)).toEqual([
      'mouseMove', 'mouseDown', 'mouseUp', 'mouseDown', 'mouseUp',
    ])
    expect(contents.sendInputEvent).toHaveBeenLastCalledWith(expect.objectContaining({ x: 20, y: 31, clickCount: 2 }))

    contents.sendInputEvent.mockClear()
    await controller.drag(10, 20, 110, 120, 4)
    expect(contents.sendInputEvent.mock.calls.map(call => call[0].type)).toEqual([
      'mouseMove', 'mouseDown', 'mouseMove', 'mouseMove', 'mouseMove', 'mouseMove', 'mouseUp',
    ])
    expect(contents.sendInputEvent).toHaveBeenLastCalledWith(expect.objectContaining({ x: 110, y: 120 }))
  })

  it('waits for dynamic page conditions without requiring control permission', async () => {
    const { controller, contents } = setup(true)
    await expect(controller.waitFor({ kind: 'text', value: 'Ready', timeoutMs: 1000 })).resolves.toMatchObject({
      ok: true,
      message: expect.stringMatching(/^Wait condition matched after \d+ms$/),
    })
    expect(contents.executeJavaScript.mock.calls[0][0]).toContain('Ready')
  })

  it('continues waiting when navigation replaces the page execution context', async () => {
    const { controller, contents } = setup(true)
    contents.executeJavaScript.mockRejectedValueOnce(new Error('Execution context was destroyed'))
    await expect(controller.waitFor({ kind: 'text', value: 'Loaded', timeoutMs: 1000 })).resolves.toMatchObject({ ok: true })
    expect(contents.executeJavaScript).toHaveBeenCalledTimes(2)
  })

  it('waits for a document title without injecting page code', async () => {
    const { controller, contents } = setup(true)
    await expect(controller.waitFor({ kind: 'title', value: 'Dashboard', timeoutMs: 1000 })).resolves.toMatchObject({ ok: true })
    expect(contents.getTitle).toHaveBeenCalled()
    expect(contents.executeJavaScript).not.toHaveBeenCalled()
  })

  it('attaches local files to a snapshotted file input through the isolated debugger protocol', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-browser-upload-'))
    const file = path.join(dir, 'post.txt')
    fs.writeFileSync(file, 'hello')
    try {
      const { controller, contents } = setup(true)
      await expect(controller.upload('e7', [file])).resolves.toMatchObject({ ok: true, message: 'Attached 1 file to e7' })
      expect(contents.debugger.attach).toHaveBeenCalledWith('1.3')
      expect(contents.debugger.sendCommand).toHaveBeenCalledWith('DOM.setFileInputFiles', {
        nodeId: 2,
        files: [file],
      })
      expect(contents.debugger.detach).toHaveBeenCalled()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects forged element references before executing page code', async () => {
    const { controller, contents } = setup(true)
    await expect(controller.fill(`e1\"]); alert(1);//`, 'x')).rejects.toThrow('Invalid element reference')
    expect(contents.executeJavaScript).not.toHaveBeenCalled()
  })

  it('lists, switches, and closes browser tabs without losing the remaining page', () => {
    const makeView = (url: string, title: string) => ({
      webContents: {
        getURL: vi.fn(() => url),
        getTitle: vi.fn(() => title),
        isDestroyed: vi.fn(() => false),
        close: vi.fn(),
        canGoBack: vi.fn(() => false),
        canGoForward: vi.fn(() => false),
        isLoading: vi.fn(() => false),
      },
    })
    const first = makeView('https://example.com/', 'First')
    const second = makeView('https://example.com/auth', 'Sign in')
    const controller = new BrowserController(() => null, vi.fn())
    ;(controller as any).tabs = [{ id: 't1', view: first }, { id: 't2', view: second }]
    ;(controller as any).view = first

    expect(controller.listTabs()).toEqual([
      { id: 't1', title: 'First', url: 'https://example.com/', active: true },
      { id: 't2', title: 'Sign in', url: 'https://example.com/auth', active: false },
    ])
    expect(controller.switchTab('t2').url).toBe('https://example.com/auth')
    expect(controller.closeTab('t2').url).toBe('https://example.com/')
    expect(second.webContents.close).toHaveBeenCalledWith({ waitForBeforeUnload: false })
    expect(controller.listTabs()).toHaveLength(1)
  })

  it('allows OAuth as a native sandboxed popup that retains its opener', () => {
    let openHandler: ((details: { url: string; disposition: string; features: string }) => any) | undefined
    const openerContents = {
      on: vi.fn(),
      setWindowOpenHandler: vi.fn((handler: (details: { url: string; disposition: string; features: string }) => any) => { openHandler = handler }),
    }
    const opener = { webContents: openerContents }
    const parent = { isDestroyed: vi.fn(() => false) }
    const controller = new BrowserController(() => parent as any, vi.fn())
    ;(controller as any).tabs = [{ id: 't1', view: opener }]
    ;(controller as any).view = opener
    ;(controller as any).bindEvents(openerContents)

    const response = openHandler!({
      url: 'https://accounts.google.com/o/oauth2/auth',
      disposition: 'new-window',
      features: 'width=520,height=640',
    })
    expect(response.action).toBe('allow')
    expect(response.outlivesOpener).toBe(false)
    expect(response.createWindow).toBeUndefined()
    expect(response.overrideBrowserWindowOptions).toMatchObject({
      parent,
      autoHideMenuBar: true,
      webPreferences: {
        partition: BROWSER_PARTITION,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    })
  })

  it('detaches without closing child contents during native app shutdown', () => {
    const close = vi.fn()
    const view = { webContents: { isDestroyed: vi.fn(() => false), close } }
    const removeChildView = vi.fn()
    const win = {
      isDestroyed: vi.fn(() => false),
      contentView: { removeChildView },
    }
    const controller = new BrowserController(() => win as any, vi.fn())
    ;(controller as any).tabs = [{ id: 't1', view }]
    ;(controller as any).view = view
    ;(controller as any).attachedTo = win

    controller.destroy({ closeContents: false })

    expect(removeChildView).toHaveBeenCalledWith(view)
    expect(close).not.toHaveBeenCalled()
  })

  it('clears persistent browsing data and closes open tabs during a session reset', async () => {
    const clearStorageData = vi.fn(async () => {})
    const clearCache = vi.fn(async () => {})
    const clearAuthCache = vi.fn(async () => {})
    const close = vi.fn()
    const onState = vi.fn()
    const controller = new BrowserController(
      () => null,
      onState,
      vi.fn(),
      undefined,
      () => ({ clearStorageData, clearCache, clearAuthCache } as any),
    )
    ;(controller as any).tabs = [{
      id: 't1',
      view: { webContents: { isDestroyed: vi.fn(() => false), close } },
    }]
    ;(controller as any).view = (controller as any).tabs[0].view

    await expect(controller.resetSession()).resolves.toMatchObject({ url: '', title: 'New tab' })
    expect(close).toHaveBeenCalledWith({ waitForBeforeUnload: false })
    expect(clearStorageData).toHaveBeenCalled()
    expect(clearCache).toHaveBeenCalled()
    expect(clearAuthCache).toHaveBeenCalled()
    expect(controller.listTabs()).toEqual([])
    expect(onState).toHaveBeenCalledWith(expect.objectContaining({ url: '', title: 'New tab' }))
  })

  it('delegates Electron website permission checks and requests to the per-site gate', async () => {
    let checkHandler: ((...args: any[]) => boolean) | undefined
    let requestHandler: ((...args: any[]) => void) | undefined
    const browserSession = {
      setPermissionCheckHandler: vi.fn((handler: (...args: any[]) => boolean) => { checkHandler = handler }),
      setPermissionRequestHandler: vi.fn((handler: (...args: any[]) => void) => { requestHandler = handler }),
    }
    const manager = {
      check: vi.fn(() => true),
      request: vi.fn(async () => true),
    }
    const controller = new BrowserController(
      () => null,
      vi.fn(),
      vi.fn(),
      undefined,
      () => browserSession as any,
    )
    controller.setSitePermissionManager(manager as any)

    expect(checkHandler!(null, 'media', 'https://meet.example.com', { mediaType: 'audio' })).toBe(true)
    expect(manager.check).toHaveBeenCalledWith('media', 'https://meet.example.com', { mediaType: 'audio' })

    const callback = vi.fn()
    requestHandler!({ getURL: () => 'https://maps.example.com/' }, 'geolocation', callback, {
      requestingUrl: 'https://maps.example.com/request',
    })
    await vi.waitFor(() => expect(callback).toHaveBeenCalledWith(true))
    expect(manager.request).toHaveBeenCalledWith(
      'geolocation',
      'https://maps.example.com/request',
      { requestingUrl: 'https://maps.example.com/request' },
    )
  })
})
