import * as fs from 'fs'
import * as http from 'http'
import * as os from 'os'
import * as path from 'path'
import { randomBytes } from 'crypto'
import type { BrowserController, BrowserLoginStatus } from './browser-controller'
import type { BrowserControlRequest } from './browser-control-permission'

type BridgeController = Pick<
  BrowserController,
  'navigate' | 'getPageContext' | 'capturePage' | 'getViewport' | 'snapshotInteractive' | 'follow' | 'click' | 'fill'
  | 'clickAt' | 'drag' | 'select' | 'check' | 'press' | 'hover' | 'scroll' | 'scrollAt'
  | 'waitFor' | 'upload' | 'listDownloads' | 'waitForDownload' | 'submit'
  | 'getLoginStatus'
  | 'getState' | 'back' | 'forward' | 'reload' | 'listTabs' | 'newTab' | 'switchTab' | 'closeTab'
>

export interface BrowserAgentBridgeInfo {
  socketPath: string
  token: string
}

export interface BrowserLoginWaitEvent {
  id: string
  chatId: string
  status: 'watching' | 'changed' | 'expired'
  startedAt: number
  expiresAt: number
  url: string
  title: string
  reason?: string
}

interface LoginWatch {
  event: BrowserLoginWaitEvent
  baseline: BrowserLoginStatus
  timer: NodeJS.Timeout | null
  candidateKey: string | null
  stableChecks: number
  polling: boolean
}

function json(res: http.ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return await new Promise((resolve, reject) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', chunk => {
      body += chunk
      if (body.length > 64 * 1024) reject(new Error('Request is too large'))
    })
    req.on('end', () => {
      if (!body) return resolve({})
      try { resolve(JSON.parse(body)) }
      catch { reject(new Error('Invalid JSON')) }
    })
    req.on('error', reject)
  })
}

/** Private local bridge used by coding-agent shell tools. */
export class BrowserAgentBridge {
  private server: http.Server | null = null
  private info: BrowserAgentBridgeInfo | null = null
  private operationTail: Promise<void> = Promise.resolve()
  private loginWatches = new Map<string, LoginWatch>()
  private loginWatchSequence = 0

  constructor(
    private readonly controller: BridgeController,
    private readonly onAgentOpen: (url: string) => void,
    private readonly requestControl: (request: BrowserControlRequest) => Promise<boolean> = async () => false,
    private readonly onLoginWait: (event: BrowserLoginWaitEvent) => void = () => {},
    private readonly loginPollIntervalMs = 2000,
  ) {}

  async start(): Promise<BrowserAgentBridgeInfo> {
    if (this.info) return this.info

    const token = randomBytes(32).toString('hex')
    const socketPath = path.join(os.tmpdir(), `cyb-${process.pid}-${randomBytes(5).toString('hex')}.sock`)
    const server = http.createServer((req, res) => { void this.handle(req, res, token) })
    this.server = server

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error)
      server.once('error', onError)
      server.listen(socketPath, () => {
        server.removeListener('error', onError)
        resolve()
      })
    })
    try { fs.chmodSync(socketPath, 0o600) } catch { /* best-effort socket permissions */ }
    this.info = { socketPath, token }
    return this.info
  }

  async stop(): Promise<void> {
    const server = this.server
    const socketPath = this.info?.socketPath
    this.server = null
    this.info = null
    for (const watch of this.loginWatches.values()) {
      if (watch.timer) clearTimeout(watch.timer)
    }
    this.loginWatches.clear()
    if (server) {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
    if (socketPath) {
      try { fs.unlinkSync(socketPath) } catch { /* already removed */ }
    }
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse, token: string): Promise<void> {
    if (req.headers.authorization !== `Bearer ${token}`) {
      json(res, 401, { error: 'Unauthorized' })
      return
    }

    const route = (req.url || '/').split('?')[0]
    try {
      if (req.method === 'POST' && route === '/open') {
        const body = await readJson(req)
        const url = typeof body.url === 'string' ? body.url : ''
        if (!url.trim()) throw new Error('A URL or search query is required')
        json(res, 200, await this.exclusive(async () => {
          this.onAgentOpen(url)
          return await this.controller.navigate(url)
        }))
        return
      }
      if (req.method === 'POST' && route === '/open-view') {
        const body = await readJson(req)
        const url = typeof body.url === 'string' ? body.url : ''
        if (!url.trim()) throw new Error('A URL or search query is required')
        json(res, 200, await this.exclusive(async () => {
          this.onAgentOpen(url)
          await this.controller.navigate(url)
          return await this.controller.getPageContext()
        }))
        return
      }
      if (req.method === 'GET' && route === '/view') {
        json(res, 200, await this.exclusive(() => this.controller.getPageContext()))
        return
      }
      if (req.method === 'GET' && route === '/screenshot') {
        const { png, viewport } = await this.exclusive(async () => ({
          png: await this.controller.capturePage(),
          viewport: await this.controller.getViewport(),
        }))
        res.writeHead(200, {
          'Content-Type': 'image/png',
          'Content-Length': png.length,
          'Cache-Control': 'no-store',
          'X-Codey-Viewport-Width': viewport.width,
          'X-Codey-Viewport-Height': viewport.height,
          'X-Codey-Device-Scale-Factor': viewport.deviceScaleFactor,
        })
        res.end(png)
        return
      }
      if (req.method === 'GET' && route === '/snapshot') {
        json(res, 200, await this.exclusive(() => this.controller.snapshotInteractive()))
        return
      }
      if (req.method === 'GET' && route === '/viewport') {
        json(res, 200, await this.exclusive(() => this.controller.getViewport()))
        return
      }
      if (req.method === 'GET' && route === '/state') {
        json(res, 200, this.controller.getState())
        return
      }
      if (req.method === 'POST' && route === '/wait-login') {
        const body = await readJson(req)
        const chatId = typeof body.chatId === 'string' ? body.chatId.trim() : ''
        if (!chatId) throw new Error('Login waiting is only available from a Codey chat')
        const current = this.controller.getState()
        this.onAgentOpen(current.url)
        json(res, 200, await this.startLoginWait(chatId, Number(body.timeoutMs) || 300000))
        return
      }
      if (req.method === 'GET' && route === '/downloads') {
        json(res, 200, this.controller.listDownloads())
        return
      }
      if (req.method === 'GET' && route === '/tabs') {
        json(res, 200, this.controller.listTabs())
        return
      }
      if (req.method === 'POST' && route === '/tab/new') {
        const body = await readJson(req)
        const url = String(body.url || 'about:blank')
        json(res, 200, await this.exclusive(async () => {
          this.onAgentOpen(url)
          return await this.controller.newTab(url)
        }))
        return
      }
      if (req.method === 'POST' && route === '/tab/switch') {
        const body = await readJson(req)
        json(res, 200, await this.exclusive(() => {
          const state = this.controller.switchTab(String(body.id || ''))
          this.onAgentOpen(state.url)
          return state
        }))
        return
      }
      if (req.method === 'POST' && route === '/tab/close') {
        const body = await readJson(req)
        json(res, 200, await this.exclusive(() => this.controller.closeTab(String(body.id || ''))))
        return
      }
      if (req.method === 'POST' && route === '/wait-download') {
        const body = await readJson(req)
        json(res, 200, await this.controller.waitForDownload(Number(body.timeoutMs) || 60000))
        return
      }
      if (req.method === 'POST' && route === '/back') {
        json(res, 200, await this.exclusive(() => this.controller.back()))
        return
      }
      if (req.method === 'POST' && route === '/forward') {
        json(res, 200, await this.exclusive(() => this.controller.forward()))
        return
      }
      if (req.method === 'POST' && route === '/reload') {
        json(res, 200, await this.exclusive(() => this.controller.reload()))
        return
      }
      if (req.method === 'POST' && route === '/click') {
        const body = await readJson(req)
        const ref = String(body.ref || '')
        const followed = await this.exclusive(() => this.controller.follow(ref))
        json(res, 200, followed ?? await this.controlled('click', () => this.controller.click(ref)))
        return
      }
      if (req.method === 'POST' && route === '/click-at') {
        const body = await readJson(req)
        json(res, 200, await this.controlled('click-at', () => this.controller.clickAt(
          Number(body.x), Number(body.y), Number(body.clickCount) || 1,
        )))
        return
      }
      if (req.method === 'POST' && route === '/drag') {
        const body = await readJson(req)
        json(res, 200, await this.controlled('drag', () => this.controller.drag(
          Number(body.fromX), Number(body.fromY), Number(body.toX), Number(body.toY), Number(body.steps) || 12,
        )))
        return
      }
      if (req.method === 'POST' && route === '/fill') {
        const body = await readJson(req)
        json(res, 200, await this.controlled('fill', () => this.controller.fill(String(body.ref || ''), String(body.value ?? ''))))
        return
      }
      if (req.method === 'POST' && route === '/upload') {
        const body = await readJson(req)
        const files = Array.isArray(body.files) ? body.files.map(file => String(file)) : []
        json(res, 200, await this.controlled('upload', () => this.controller.upload(String(body.ref || ''), files)))
        return
      }
      if (req.method === 'POST' && route === '/select') {
        const body = await readJson(req)
        json(res, 200, await this.controlled('select', () => this.controller.select(String(body.ref || ''), String(body.value ?? ''))))
        return
      }
      if (req.method === 'POST' && route === '/check') {
        const body = await readJson(req)
        json(res, 200, await this.controlled('check', () => this.controller.check(String(body.ref || ''), body.checked !== false)))
        return
      }
      if (req.method === 'POST' && route === '/press') {
        const body = await readJson(req)
        const ref = typeof body.ref === 'string' && body.ref ? body.ref : undefined
        json(res, 200, await this.controlled('press', () => this.controller.press(String(body.key || ''), ref)))
        return
      }
      if (req.method === 'POST' && route === '/hover') {
        const body = await readJson(req)
        json(res, 200, await this.exclusive(() => this.controller.hover(String(body.ref || ''))))
        return
      }
      if (req.method === 'POST' && route === '/scroll') {
        const body = await readJson(req)
        json(res, 200, await this.exclusive(() => this.controller.scroll(Number(body.deltaY) || 0, Number(body.deltaX) || 0)))
        return
      }
      if (req.method === 'POST' && route === '/scroll-at') {
        const body = await readJson(req)
        json(res, 200, await this.exclusive(() => this.controller.scrollAt(
          Number(body.x), Number(body.y), Number(body.deltaY) || 0, Number(body.deltaX) || 0,
        )))
        return
      }
      if (req.method === 'POST' && route === '/wait') {
        const body = await readJson(req)
        json(res, 200, await this.controller.waitFor({
          kind: String(body.kind || '') as 'ref' | 'text' | 'url' | 'title',
          value: String(body.value || ''),
          state: body.state ? String(body.state) as 'visible' | 'hidden' | 'enabled' : undefined,
          timeoutMs: Number(body.timeoutMs) || undefined,
        }))
        return
      }
      if (req.method === 'POST' && route === '/submit') {
        const body = await readJson(req)
        json(res, 200, await this.controlled('submit', () => this.controller.submit(String(body.ref || ''))))
        return
      }
      json(res, 404, { error: 'Unknown browser command' })
    } catch (error) {
      const denied = error instanceof BrowserControlDeniedError
      json(res, denied ? 403 : 400, {
        error: error instanceof Error ? error.message : String(error),
        ...(denied ? { code: 'browser_control_denied' } : {}),
      })
    }
  }

  private async exclusive<T>(operation: () => Promise<T> | T): Promise<T> {
    const result = this.operationTail.then(operation, operation)
    this.operationTail = result.then(() => undefined, () => undefined)
    return await result
  }

  private async controlled<T>(command: string, operation: () => Promise<T> | T): Promise<T> {
    const approved = await this.requestControl({ command, url: this.controller.getState().url })
    if (!approved) throw new BrowserControlDeniedError()
    return await this.exclusive(operation)
  }

  private async startLoginWait(chatId: string, requestedTimeoutMs: number): Promise<BrowserLoginWaitEvent> {
    const timeoutMs = Math.max(10000, Math.min(15 * 60 * 1000, Math.round(requestedTimeoutMs)))
    const baseline = await this.exclusive(() => this.controller.getLoginStatus())
    if (baseline.loggedInLikely && !baseline.authLikely) {
      throw new Error('The current page already appears to be signed in; retry the website step now')
    }

    const existing = this.loginWatches.get(chatId)
    if (existing?.timer) clearTimeout(existing.timer)

    const startedAt = Date.now()
    const event: BrowserLoginWaitEvent = {
      id: `login-${process.pid}-${++this.loginWatchSequence}`,
      chatId,
      status: 'watching',
      startedAt,
      expiresAt: startedAt + timeoutMs,
      url: baseline.url,
      title: baseline.title,
    }
    const watch: LoginWatch = {
      event,
      baseline,
      timer: null,
      candidateKey: null,
      stableChecks: 0,
      polling: false,
    }
    this.loginWatches.set(chatId, watch)
    this.emitLoginWait(event)
    this.scheduleLoginPoll(watch)
    return event
  }

  private scheduleLoginPoll(watch: LoginWatch): void {
    const remaining = watch.event.expiresAt - Date.now()
    if (remaining <= 0) {
      this.finishLoginWait(watch, 'expired', watch.baseline, 'timeout')
      return
    }
    watch.timer = setTimeout(() => { void this.pollLoginWait(watch) }, Math.min(this.loginPollIntervalMs, remaining))
  }

  private async pollLoginWait(watch: LoginWatch): Promise<void> {
    if (this.loginWatches.get(watch.event.chatId) !== watch || watch.polling) return
    if (Date.now() >= watch.event.expiresAt) {
      this.finishLoginWait(watch, 'expired', watch.baseline, 'timeout')
      return
    }
    watch.polling = true
    try {
      const current = await this.exclusive(() => this.controller.getLoginStatus(watch.baseline.tabId))
      const changed = !current.loading && (
        current.loggedInLikely
        || (watch.baseline.authLikely && !current.authLikely)
        || (!watch.baseline.authLikely && current.statusKey !== watch.baseline.statusKey)
      )
      if (!changed) {
        watch.candidateKey = null
        watch.stableChecks = 0
      } else if (watch.candidateKey === current.statusKey) {
        watch.stableChecks += 1
      } else {
        watch.candidateKey = current.statusKey
        watch.stableChecks = 1
      }
      // A redirect can briefly render an empty document between identity
      // provider and destination. Requiring the same settled state twice
      // avoids resuming the chat in the middle of that transition.
      if (watch.stableChecks >= 2) {
        this.finishLoginWait(watch, 'changed', current, current.loggedInLikely ? 'signed-in' : 'status-changed')
        return
      }
    } catch (error) {
      this.finishLoginWait(
        watch,
        'expired',
        watch.baseline,
        error instanceof Error ? error.message : 'The login page is no longer available',
      )
      return
    } finally {
      watch.polling = false
    }
    this.scheduleLoginPoll(watch)
  }

  private finishLoginWait(
    watch: LoginWatch,
    status: 'changed' | 'expired',
    page: BrowserLoginStatus,
    reason: string,
  ): void {
    if (this.loginWatches.get(watch.event.chatId) !== watch) return
    if (watch.timer) clearTimeout(watch.timer)
    this.loginWatches.delete(watch.event.chatId)
    this.emitLoginWait({
      ...watch.event,
      status,
      url: page.url,
      title: page.title,
      reason,
    })
  }

  private emitLoginWait(event: BrowserLoginWaitEvent): void {
    try { this.onLoginWait({ ...event }) } catch { /* observer errors must not stop the bridge */ }
  }
}

class BrowserControlDeniedError extends Error {
  constructor() {
    super('The user did not approve full browser control')
  }
}
