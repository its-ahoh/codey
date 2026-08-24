import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { describe, expect, it, vi } from 'vitest'
import { BROWSER_PARTITION, BrowserController, isSafeBrowserNavigationUrl, normalizeBrowserUrl, sanitizeBounds } from './browser-controller'

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
      insertText: vi.fn(),
      debugger: {
        isAttached: vi.fn(() => debuggerAttached),
        attach: vi.fn(() => { debuggerAttached = true }),
        detach: vi.fn(() => { debuggerAttached = false }),
        sendCommand: vi.fn(async (command: string) => command === 'DOM.getDocument'
          ? { root: { nodeId: 1 } }
          : command === 'DOM.querySelector' ? { nodeId: 2 } : {}),
      },
    }
    const controller = new BrowserController(
      () => null,
      vi.fn(),
      undefined,
      undefined,
      undefined,
      { random: () => 0.5, sleep: async () => {} },
    )
    ;(controller as any).view = { webContents: contents }
    return { controller, contents }
  }

  it('approaches and clicks the snapshotted element center along a human path', async () => {
    const { controller, contents } = setup({ x: 120, y: 80 })
    await expect(controller.click('e2')).resolves.toMatchObject({ ok: true, message: 'Clicked e2' })
    const events = contents.sendInputEvent.mock.calls.map(call => call[0])
    const moves = events.filter(event => event.type === 'mouseMove')
    // A curved approach means many samples, not a single jump to the target.
    expect(moves.length).toBeGreaterThan(1)
    expect(moves[moves.length - 1]).toMatchObject({ x: 120, y: 80 })
    expect(events.slice(-2).map(event => event.type)).toEqual(['mouseDown', 'mouseUp'])
    expect(events.find(event => event.type === 'mouseDown')).toMatchObject({ x: 120, y: 80 })
    expect(contents.sendInputEvent).toHaveBeenLastCalledWith(expect.objectContaining({ x: 120, y: 80 }))
  })

  it('bows the pointer path off the straight line between endpoints', async () => {
    const contents = {
      isDestroyed: vi.fn(() => false),
      getURL: vi.fn(() => 'https://example.com/form'),
      getTitle: vi.fn(() => 'Example'),
      executeJavaScript: vi.fn(async () => ({ x: 200, y: 200 })),
      sendInputEvent: vi.fn(),
    }
    const controller = new BrowserController(
      () => null,
      vi.fn(),
      undefined,
      undefined,
      undefined,
      { random: () => 0.9, sleep: async () => {} },
    )
    ;(controller as any).view = { webContents: contents }
    await controller.click('e1')
    const moves = contents.sendInputEvent.mock.calls.map(call => call[0]).filter(event => event.type === 'mouseMove')
    const start = moves[0]
    const end = moves[moves.length - 1]
    const mid = moves[Math.floor(moves.length / 2)]
    const dx = end.x - start.x
    const dy = end.y - start.y
    // Perpendicular distance of the midpoint from the start→end line proves the arc.
    const deviation = Math.abs((mid.x - start.x) * dy - (mid.y - start.y) * dx) / (Math.hypot(dx, dy) || 1)
    expect(deviation).toBeGreaterThan(1)
    expect(end).toMatchObject({ x: 200, y: 200 })
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

  it('types into the focused field character by character with native keystrokes', async () => {
    const { controller, contents } = setup(true)
    await controller.fill('e4', `Jack's "post"`)
    const script = contents.executeJavaScript.mock.calls[0][0]
    expect(script).toContain('range.selectNodeContents(el)')
    expect(script).toContain('el.select()')
    // The text is never embedded in the executed page script.
    expect(script).not.toContain(`Jack's`)
    expect(contents.insertText).not.toHaveBeenCalled()
    // Each character arrives as a full keydown/char/keyup keystroke.
    expect(contents.sendInputEvent.mock.calls.slice(0, 3).map(call => call[0].type)).toEqual([
      'keyDown', 'char', 'keyUp',
    ])
    const typed = contents.sendInputEvent.mock.calls
      .filter(call => call[0].type === 'char')
      .map(call => call[0].keyCode)
      .join('')
    expect(typed).toBe(`Jack's "post"`)
  })

  it('sends a character event for the space key', async () => {
    const { controller, contents } = setup(true)
    await controller.press('Space', 'e4')
    expect(contents.sendInputEvent.mock.calls.map(call => call[0])).toEqual([
      { type: 'keyDown', keyCode: 'Space', modifiers: [] },
      { type: 'char', keyCode: ' ', modifiers: [] },
      { type: 'keyUp', keyCode: 'Space', modifiers: [] },
    ])
  })

  it('clears a field through native editing when fill receives empty text', async () => {
    const { controller, contents } = setup(true)
    await controller.fill('e4', '')
    expect(contents.insertText).not.toHaveBeenCalled()
    expect(contents.sendInputEvent.mock.calls.map(call => call[0])).toEqual([
      { type: 'keyDown', keyCode: 'Backspace' },
      { type: 'keyUp', keyCode: 'Backspace' },
    ])
  })

  it('supports coordinate clicks and drag gestures for maps and canvases', async () => {
    const { controller, contents } = setup(true)
    await controller.clickAt(20.4, 30.6, 2)
    const clickEvents = contents.sendInputEvent.mock.calls.map(call => call[0])
    expect(clickEvents.filter(event => event.type === 'mouseMove').length).toBeGreaterThan(1)
    expect(clickEvents.slice(-4).map(event => event.type)).toEqual(['mouseDown', 'mouseUp', 'mouseDown', 'mouseUp'])
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

describe('sanitizeBounds', () => {
  const win = { getContentBounds: () => ({ x: 0, y: 0, width: 1600, height: 1000 }) } as any

  it('passes CSS px through unchanged at 100%', () => {
    expect(sanitizeBounds({ x: 400, y: 60, width: 800, height: 600 }, win))
      .toEqual({ x: 400, y: 60, width: 800, height: 600 })
  })

  it('scales renderer CSS px by the window zoom factor', () => {
    expect(sanitizeBounds({ x: 400, y: 60, width: 800, height: 600 }, win, 1.25))
      .toEqual({ x: 500, y: 75, width: 1000, height: 750 })
  })

  it('keeps the scaled view inside the window', () => {
    expect(sanitizeBounds({ x: 400, y: 60, width: 1200, height: 900 }, win, 1.6))
      .toEqual({ x: 640, y: 96, width: 960, height: 904 })
  })

  it('ignores a nonsense zoom factor', () => {
    expect(sanitizeBounds({ x: 10, y: 10, width: 100, height: 100 }, win, 0))
      .toEqual({ x: 10, y: 10, width: 100, height: 100 })
  })
})

describe('BrowserController profiles', () => {
  function makeFixture(dir: string, overrides: {
    tabs?: Array<{ id: string; view: { webContents: any } }>
    session?: any
    options?: any
  } = {}) {
    const cookiesGet = vi.fn(async () => [
      { name: 'sid', value: 'abc', domain: 'example.com', path: '/', secure: true, httpOnly: true, sameSite: 'lax', hostOnly: false },
    ])
    const cookiesSet = vi.fn(async () => {})
    const cookiesRemove = vi.fn(async () => {})
    const session = overrides.session ?? { cookies: { get: cookiesGet, set: cookiesSet, remove: cookiesRemove } }
    const contents = {
      isDestroyed: vi.fn(() => false),
      getURL: vi.fn(() => 'https://example.com/dashboard'),
      getTitle: vi.fn(() => 'Dashboard'),
      executeJavaScript: vi.fn(async (_script: string) => ({
        origin: 'https://example.com',
        entries: [{ name: 'token', value: 't0k3n' }],
      })),
      close: vi.fn(),
      once: vi.fn(),
      loadURL: vi.fn(async () => {}),
    }
    const tabs = overrides.tabs ?? [{ id: 't1', view: { webContents: contents } }]
    const controller = new BrowserController(
      () => null,
      vi.fn(),
      vi.fn(),
      undefined,
      () => session as any,
      { getProfilesDir: () => dir, ...(overrides.options ?? {}) },
    )
    ;(controller as any).tabs = tabs
    ;(controller as any).view = tabs[0]?.view ?? null
    return { controller, session, contents, cookiesGet, cookiesSet, cookiesRemove }
  }

  it('saves the live session into a named profile file', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-ctl-profiles-'))
    try {
      const { controller, contents } = makeFixture(dir)
      const profile = await controller.saveProfile('work')
      expect(profile.name).toBe('work')
      expect(profile.sourceUrl).toBe('https://example.com/dashboard')
      expect(profile.cookies).toEqual([expect.objectContaining({ name: 'sid', value: 'abc', domain: 'example.com', expires: -1 })])
      expect(profile.origins).toEqual([{ origin: 'https://example.com', localStorage: [{ name: 'token', value: 't0k3n' }] }])
      // The capture script only reads localStorage — never page text or fields.
      const script = contents.executeJavaScript.mock.calls[0][0]
      expect(script).toContain('localStorage')
      expect(script).not.toContain('innerText')
      const stored = JSON.parse(fs.readFileSync(path.join(dir, 'work.json'), 'utf8'))
      expect(stored.name).toBe('work')
      expect(controller.listProfiles()[0]).toMatchObject({ name: 'work', cookieCount: 1, originCount: 1, active: false })
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects unsafe profile names', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-ctl-profiles-'))
    try {
      const { controller } = makeFixture(dir)
      await expect(controller.saveProfile('../evil')).rejects.toThrow(/Profile names/)
      await expect(controller.activateProfile('.hidden')).rejects.toThrow(/Profile names/)
      await expect(controller.deleteProfile('a/b')).rejects.toThrow(/Profile names/)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('imports Playwright storageState JSON and activates it by default', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-ctl-profiles-'))
    try {
      // The profile's only origin (github.com) is not open in any tab, so a
      // hidden view applies its localStorage — stub it because the test
      // environment has no real Electron views.
      const hidden = {
        webContents: {
          isDestroyed: vi.fn(() => false),
          getURL: vi.fn(() => 'about:blank'),
          executeJavaScript: vi.fn(async (_script: string) => true),
          once: vi.fn((event: string, cb: () => void) => { if (event === 'did-finish-load') cb() }),
          loadURL: vi.fn(async () => {}),
          close: vi.fn(),
        },
      }
      const { controller, cookiesSet, cookiesRemove } = makeFixture(dir, {
        options: { createHiddenView: () => hidden },
      })
      const json = JSON.stringify({
        cookies: [
          { name: 'gh', value: 'tok', domain: 'github.com', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' },
        ],
        origins: [{ origin: 'https://github.com', localStorage: [{ name: 'gh-token', value: 'xyz' }] }],
      })
      const profile = await controller.importProfile('gh', { json }, true)
      expect(profile.name).toBe('gh')
      // Activating removed the live cookies and applied the profile's.
      expect(cookiesRemove).toHaveBeenCalledWith('https://example.com/', 'sid')
      expect(cookiesSet).toHaveBeenCalledWith(expect.objectContaining({
        url: 'https://github.com/',
        name: 'gh',
        domain: 'github.com',
        secure: true,
        httpOnly: true,
        sameSite: 'lax',
      }))
      expect(controller.activeProfileName()).toBe('gh')
      expect(controller.listProfiles().find(profile => profile.name === 'gh')?.active).toBe(true)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('import with activate:false stores without switching identity', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-ctl-profiles-'))
    try {
      const { controller, cookiesSet } = makeFixture(dir)
      await controller.importProfile('work', { json: '{"cookies":[]}' }, false)
      expect(controller.activeProfileName()).toBeNull()
      expect(cookiesSet).not.toHaveBeenCalled()
      expect(controller.listProfiles()).toHaveLength(1)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('applies localStorage through an already-open tab when available', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-ctl-profiles-'))
    try {
      // The fixture's tab is already on https://example.com, so applying that
      // origin's storage goes through the open tab, never a hidden view.
      const createHiddenView = vi.fn()
      const { controller, contents } = makeFixture(dir, { options: { createHiddenView } })
      await controller.importProfile('work', { json: JSON.stringify({
        cookies: [],
        origins: [{ origin: 'https://example.com', localStorage: [{ name: 'token', value: 'new' }] }],
      }) }, true)
      const setCalls = contents.executeJavaScript.mock.calls.map(call => call[0])
      const applyScript = setCalls.find(script => script.includes('localStorage.setItem'))
      expect(applyScript).toContain('"name":"token"')
      // No hidden view was needed because the tab was already on the origin.
      expect(createHiddenView).not.toHaveBeenCalled()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('uses a hidden view to apply localStorage of origins that are not open', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-ctl-profiles-'))
    try {
      const hidden = {
        webContents: {
          isDestroyed: vi.fn(() => false),
          getURL: vi.fn(() => 'about:blank'),
          executeJavaScript: vi.fn(async (_script: string) => true),
          once: vi.fn((event: string, cb: () => void) => { if (event === 'did-finish-load') cb() }),
          loadURL: vi.fn(async () => {}),
          close: vi.fn(),
        },
      }
      const { controller } = makeFixture(dir, {
        tabs: [{ id: 't1', view: { webContents: { ...hidden.webContents } } }],
        options: { createHiddenView: () => hidden },
      })
      await controller.importProfile('work', { json: JSON.stringify({
        cookies: [],
        origins: [{ origin: 'https://github.com', localStorage: [{ name: 'gh', value: 'tok' }] }],
      }) }, true)
      expect(hidden.webContents.loadURL).toHaveBeenCalledWith('https://github.com/')
      expect(hidden.webContents.close).toHaveBeenCalled()
      const applyScript = hidden.webContents.executeJavaScript.mock.calls[0][0]
      expect(applyScript).toContain('localStorage.setItem')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('activate is a no-op when the profile is already active, and delete clears it', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-ctl-profiles-'))
    try {
      const { controller, cookiesSet, cookiesRemove } = makeFixture(dir)
      await controller.importProfile('work', { json: '{"cookies":[]}' }, true)
      expect(controller.activeProfileName()).toBe('work')
      cookiesRemove.mockClear()
      cookiesSet.mockClear()
      const summary = await controller.activateProfile('work')
      expect(summary.active).toBe(true)
      expect(cookiesRemove).not.toHaveBeenCalled()
      await controller.deleteProfile('work')
      expect(controller.activeProfileName()).toBeNull()
      expect(controller.listProfiles()).toEqual([])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('exportProfile writes the profile to an arbitrary path', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-ctl-profiles-'))
    try {
      const { controller } = makeFixture(dir)
      await controller.importProfile('work', { json: '{"cookies":[]}' }, false)
      const out = path.join(dir, '..', 'exported-work.json')
      const result = await controller.exportProfile('work', out)
      expect(result.path).toBe(path.resolve(out))
      expect(JSON.parse(fs.readFileSync(out, 'utf8')).name).toBe('work')
      fs.rmSync(out, { force: true })
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
