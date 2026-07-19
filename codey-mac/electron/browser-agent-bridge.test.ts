import * as http from 'http'
import * as path from 'path'
import { execFile } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import { promisify } from 'util'
import { describe, expect, it, vi } from 'vitest'
import { BrowserAgentBridge, type BrowserAgentBridgeInfo, type BrowserLoginWaitEvent } from './browser-agent-bridge'

const execFileAsync = promisify(execFile)

function call(
  info: BrowserAgentBridgeInfo,
  method: string,
  route: string,
  body?: unknown,
  token = info.token,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body)
    const req = http.request({
      socketPath: info.socketPath,
      path: route,
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    }, res => {
      let raw = ''
      res.setEncoding('utf8')
      res.on('data', chunk => { raw += chunk })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw) }))
    })
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

describe('BrowserAgentBridge', () => {
  it('authenticates agent commands and controls the shared browser', async () => {
    const state = { url: 'https://example.com/', title: 'Example', loading: false, canGoBack: false, canGoForward: false, error: null }
    const page = {
      url: state.url, title: state.title, description: '', text: 'Hello from the page',
      performance: { domContentLoadedMs: 20, loadMs: 30, transferBytes: 100 },
    }
    let loginStatus = {
      tabId: 't1', url: 'https://example.com/login', title: 'Sign in', loading: false,
      authLikely: true, loggedInLikely: false, statusKey: 'login',
    }
    const controller = {
      navigate: vi.fn(async () => state),
      getPageContext: vi.fn(async () => page),
      getState: vi.fn(() => state),
      back: vi.fn(() => state),
      forward: vi.fn(() => state),
      reload: vi.fn(() => state),
      capturePage: vi.fn(async () => Buffer.from('fake-png')),
      getViewport: vi.fn(async () => ({ width: 800, height: 600, deviceScaleFactor: 2 })),
      snapshotInteractive: vi.fn(async () => ({
        url: state.url, title: state.title,
        viewport: { width: 800, height: 600, deviceScaleFactor: 2 },
        elements: [{ ref: 'e1', tag: 'button', role: '', label: 'Post', type: '', disabled: false }],
      })),
      follow: vi.fn(async ref => ref === 'e2'
        ? { ok: true as const, url: 'https://example.com/docs', message: 'Opened link' }
        : null),
      click: vi.fn(async ref => ({ ok: true as const, url: state.url, message: `Clicked ${ref}` })),
      clickAt: vi.fn(async () => ({ ok: true as const, url: state.url, message: 'Clicked coordinates' })),
      drag: vi.fn(async () => ({ ok: true as const, url: state.url, message: 'Dragged' })),
      fill: vi.fn(async ref => ({ ok: true as const, url: state.url, message: `Filled ${ref}` })),
      select: vi.fn(async ref => ({ ok: true as const, url: state.url, message: `Selected ${ref}` })),
      check: vi.fn(async ref => ({ ok: true as const, url: state.url, message: `Checked ${ref}` })),
      press: vi.fn(async key => ({ ok: true as const, url: state.url, message: `Pressed ${key}` })),
      hover: vi.fn(async ref => ({ ok: true as const, url: state.url, message: `Hovered ${ref}` })),
      scroll: vi.fn(async () => ({ ok: true as const, url: state.url, message: 'Scrolled' })),
      scrollAt: vi.fn(async () => ({ ok: true as const, url: state.url, message: 'Scrolled coordinates' })),
      waitFor: vi.fn(async () => ({ ok: true as const, url: state.url, message: 'Waited' })),
      getLoginStatus: vi.fn(async () => loginStatus),
      upload: vi.fn(async () => ({ ok: true as const, url: state.url, message: 'Uploaded' })),
      listDownloads: vi.fn(() => []),
      waitForDownload: vi.fn(async () => ({
        id: 'd1', name: 'report.pdf', path: '/tmp/report.pdf', url: state.url,
        status: 'completed' as const, receivedBytes: 10, totalBytes: 10, startedAt: 1, finishedAt: 2,
      })),
      listTabs: vi.fn(() => [{ id: 't1', title: state.title, url: state.url, active: true }]),
      newTab: vi.fn(async () => state),
      switchTab: vi.fn(() => state),
      closeTab: vi.fn(() => state),
      submit: vi.fn(async ref => ({ ok: true as const, url: state.url, message: `Submitted ${ref}` })),
    }
    const onOpen = vi.fn()
    const requestControl = vi.fn(async () => true)
    const loginEvents: BrowserLoginWaitEvent[] = []
    const bridge = new BrowserAgentBridge(controller, onOpen, requestControl, event => loginEvents.push(event), 5)
    const info = await bridge.start()
    try {
      const denied = await call(info, 'GET', '/state', undefined, 'wrong')
      expect(denied.status).toBe(401)

      const opened = await call(info, 'POST', '/open', { url: 'https://example.com' })
      expect(opened).toEqual({ status: 200, body: state })
      expect(controller.navigate).toHaveBeenCalledWith('https://example.com')
      expect(onOpen).toHaveBeenCalledWith('https://example.com')

      const openedAndViewed = await call(info, 'POST', '/open-view', { url: 'https://example.com/docs' })
      expect(openedAndViewed.status).toBe(200)
      expect(openedAndViewed.body.text).toBe('Hello from the page')
      expect(controller.navigate).toHaveBeenLastCalledWith('https://example.com/docs')

      const viewed = await call(info, 'GET', '/view')
      expect(viewed.status).toBe(200)
      expect(viewed.body.text).toBe('Hello from the page')

      const snapshot = await call(info, 'GET', '/snapshot')
      expect(snapshot.body.elements[0]).toMatchObject({ ref: 'e1', label: 'Post' })

      const clicked = await call(info, 'POST', '/click', { ref: 'e1' })
      expect(clicked.status).toBe(200)
      expect(controller.click).toHaveBeenCalledWith('e1')
      expect(requestControl).toHaveBeenCalledWith({ command: 'click', url: state.url })

      const controlCallsAfterButton = requestControl.mock.calls.length
      const followed = await call(info, 'POST', '/click', { ref: 'e2' })
      expect(followed.body).toMatchObject({ url: 'https://example.com/docs', message: 'Opened link' })
      expect(controller.follow).toHaveBeenCalledWith('e2')
      expect(controller.click).not.toHaveBeenCalledWith('e2')
      expect(requestControl).toHaveBeenCalledTimes(controlCallsAfterButton)

      const mapClick = await call(info, 'POST', '/click-at', { x: 120, y: 90, clickCount: 2 })
      expect(mapClick.status).toBe(200)
      expect(controller.clickAt).toHaveBeenCalledWith(120, 90, 2)

      const waited = await call(info, 'POST', '/wait', { kind: 'text', value: 'Ready', timeoutMs: 5000 })
      expect(waited.status).toBe(200)
      expect(controller.waitFor).toHaveBeenCalledWith({ kind: 'text', value: 'Ready', state: undefined, timeoutMs: 5000 })

      const loginWait = await call(info, 'POST', '/wait-login', { chatId: 'chat-123', timeoutMs: 10000 })
      expect(loginWait.body).toMatchObject({ chatId: 'chat-123', status: 'watching' })
      loginStatus = {
        ...loginStatus,
        url: 'https://example.com/home', title: 'Home', authLikely: false, loggedInLikely: true, statusKey: 'home',
      }
      await new Promise(resolve => setTimeout(resolve, 30))
      expect(loginEvents.map(event => event.status)).toEqual(['watching', 'changed'])
      expect(loginEvents[1]).toMatchObject({ chatId: 'chat-123', reason: 'signed-in', url: 'https://example.com/home' })

      const tabs = await call(info, 'GET', '/tabs')
      expect(tabs.body[0]).toMatchObject({ id: 't1', active: true })
      const newTab = await call(info, 'POST', '/tab/new', { url: 'https://example.com/auth' })
      expect(newTab.status).toBe(200)
      expect(controller.newTab).toHaveBeenCalledWith('https://example.com/auth')

      const viewOnlyControlCount = requestControl.mock.calls.length
      await call(info, 'POST', '/tab/close', { id: 't1' })
      await call(info, 'POST', '/hover', { ref: 'e1' })
      await call(info, 'POST', '/scroll', { deltaY: 400 })
      await call(info, 'POST', '/scroll-at', { x: 100, y: 100, deltaY: 200 })
      expect(controller.closeTab).toHaveBeenCalledWith('t1')
      expect(controller.hover).toHaveBeenCalledWith('e1')
      expect(requestControl).toHaveBeenCalledTimes(viewOnlyControlCount)

      const downloads = await call(info, 'GET', '/downloads')
      expect(downloads).toEqual({ status: 200, body: [] })

      requestControl.mockResolvedValueOnce(false)
      const deniedControl = await call(info, 'POST', '/fill', { ref: 'e1', value: 'Do not send' })
      expect(deniedControl).toEqual({
        status: 403,
        body: {
          code: 'browser_control_denied',
          error: 'The user did not approve full browser control',
        },
      })
      expect(controller.fill).not.toHaveBeenCalled()

      const cli = path.join(process.cwd(), 'electron', 'browser-agent-cli.cjs')
      const cliResult = await execFileAsync(process.execPath, [cli, 'view'], {
        env: {
          ...process.env,
          CODEY_BROWSER_SOCKET: info.socketPath,
          CODEY_BROWSER_TOKEN: info.token,
        },
      })
      expect(JSON.parse(cliResult.stdout).text).toBe('Hello from the page')

      const screenshotPath = path.join(os.tmpdir(), `codey-browser-test-${process.pid}.png`)
      try {
        const screenshotResult = await execFileAsync(process.execPath, [cli, 'screenshot', screenshotPath], {
          env: {
            ...process.env,
            CODEY_BROWSER_SOCKET: info.socketPath,
            CODEY_BROWSER_TOKEN: info.token,
          },
        })
        expect(JSON.parse(screenshotResult.stdout)).toMatchObject({
          path: screenshotPath,
          bytes: 8,
          viewport: { width: 800, height: 600, deviceScaleFactor: 2 },
        })
        expect(fs.readFileSync(screenshotPath).toString()).toBe('fake-png')
      } finally {
        try { fs.unlinkSync(screenshotPath) } catch { /* already removed */ }
      }
    } finally {
      await bridge.stop()
    }
  })

  it('expires a login watch without reporting a successful change', async () => {
    vi.useFakeTimers()
    const status = {
      tabId: 't1', url: 'https://example.com/login', title: 'Sign in', loading: false,
      authLikely: true, loggedInLikely: false, statusKey: 'login',
    }
    const events: BrowserLoginWaitEvent[] = []
    const bridge = new BrowserAgentBridge({
      getLoginStatus: vi.fn(async () => status),
      getState: vi.fn(() => ({ url: status.url })),
    } as any, vi.fn(), undefined, event => events.push(event), 1000)
    try {
      await (bridge as any).startLoginWait('chat-timeout', 10000)
      await vi.advanceTimersByTimeAsync(10000)
      expect(events.map(event => event.status)).toEqual(['watching', 'expired'])
      expect(events[1]).toMatchObject({ chatId: 'chat-timeout', reason: 'timeout' })
    } finally {
      await bridge.stop()
      vi.useRealTimers()
    }
  })
})
