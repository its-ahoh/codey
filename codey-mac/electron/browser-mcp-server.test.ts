import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as http from 'http'
import * as os from 'os'
import * as path from 'path'
import { randomBytes } from 'crypto'

// The server is plain CJS so the packaged app can run it without a build step.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const mcp = require('./browser-mcp-server.cjs')

const TOKEN = 'test-token'
let server: http.Server
let socketPath: string
let received: Array<{ method: string; route: string; body: any }>

beforeEach(async () => {
  received = []
  socketPath = path.join(os.tmpdir(), `codey-mcp-test-${randomBytes(5).toString('hex')}.sock`)
  server = http.createServer((req, res) => {
    let raw = ''
    req.setEncoding('utf8')
    req.on('data', c => { raw += c })
    req.on('end', () => {
      const route = (req.url || '/').split('?')[0]
      if (req.headers.authorization !== `Bearer ${TOKEN}`) {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Unauthorized' }))
        return
      }
      received.push({ method: req.method || '', route, body: raw ? JSON.parse(raw) : {} })
      if (route === '/screenshot') {
        const png = Buffer.from('fake-png')
        res.writeHead(200, {
          'Content-Type': 'image/png',
          'X-Codey-Viewport-Width': '1200',
          'X-Codey-Viewport-Height': '800',
          'X-Codey-Device-Scale-Factor': '2',
        })
        res.end(png)
        return
      }
      if (route === '/hover') {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'element not found' }))
        return
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, route }))
    })
  })
  await new Promise<void>(resolve => server.listen(socketPath, resolve))
  process.env.CODEY_BROWSER_SOCKET = socketPath
  process.env.CODEY_BROWSER_TOKEN = TOKEN
  process.env.CODEY_BROWSER_CHAT_ID = 'chat-42'
})

afterEach(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
  delete process.env.CODEY_BROWSER_SOCKET
  delete process.env.CODEY_BROWSER_TOKEN
  delete process.env.CODEY_BROWSER_CHAT_ID
})

describe('protocol handshake', () => {
  it('answers initialize with tools capability', async () => {
    const res = await mcp.handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
    expect(res.result.protocolVersion).toBe('2024-11-05')
    expect(res.result.capabilities.tools).toBeDefined()
    expect(res.result.serverInfo.name).toBe('codey-browser')
  })

  it('lists exactly the 8 condensed tools', async () => {
    const res = await mcp.handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
    expect(res.result.tools.map((t: any) => t.name).sort()).toEqual([
      'browser_files', 'browser_interact', 'browser_login_wait', 'browser_navigate',
      'browser_open', 'browser_read', 'browser_tabs', 'browser_wait',
    ])
    for (const tool of res.result.tools) {
      expect(tool.description.length).toBeGreaterThan(10)
      expect(tool.inputSchema.type).toBe('object')
    }
  })

  it('returns null for notifications', async () => {
    const res = await mcp.handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' })
    expect(res).toBeNull()
  })
})

describe('tool routing', () => {
  const call = (name: string, args: any) =>
    mcp.handleMessage({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name, arguments: args } })

  it('browser_open routes to /open, and /open-view when view=true', async () => {
    await call('browser_open', { url: 'https://a.example' })
    await call('browser_open', { url: 'https://b.example', view: true })
    expect(received.map(r => r.route)).toEqual(['/open', '/open-view'])
    expect(received[0].body).toEqual({ url: 'https://a.example' })
  })

  it('browser_read modes route to their GET endpoints', async () => {
    await call('browser_read', { mode: 'view' })
    await call('browser_read', { mode: 'snapshot' })
    await call('browser_read', { mode: 'state' })
    await call('browser_read', { mode: 'viewport' })
    expect(received.map(r => r.route)).toEqual(['/view', '/snapshot', '/state', '/viewport'])
    expect(received.every(r => r.method === 'GET')).toBe(true)
  })

  it('browser_read screenshot returns inline image content plus viewport text', async () => {
    const res = await call('browser_read', { mode: 'screenshot' })
    const image = res.result.content.find((c: any) => c.type === 'image')
    expect(image.mimeType).toBe('image/png')
    expect(Buffer.from(image.data, 'base64').toString()).toBe('fake-png')
    const text = res.result.content.find((c: any) => c.type === 'text')
    expect(text.text).toContain('1200')
  })

  it('browser_interact maps actions to routes and payloads', async () => {
    await call('browser_interact', { action: 'click', ref: 'e1' })
    await call('browser_interact', { action: 'fill', ref: 'e2', value: 'hi' })
    await call('browser_interact', { action: 'uncheck', ref: 'e3' })
    await call('browser_interact', { action: 'click_at', x: 10, y: 20, clickCount: 2 })
    await call('browser_interact', { action: 'drag', x: 1, y: 2, toX: 3, toY: 4 })
    await call('browser_interact', { action: 'scroll', deltaY: 100 })
    expect(received.map(r => [r.route, r.body])).toEqual([
      ['/click', { ref: 'e1' }],
      ['/fill', { ref: 'e2', value: 'hi' }],
      ['/check', { ref: 'e3', checked: false }],
      ['/click-at', { x: 10, y: 20, clickCount: 2 }],
      ['/drag', { fromX: 1, fromY: 2, toX: 3, toY: 4, steps: 12 }],
      ['/scroll', { deltaY: 100, deltaX: 0 }],
    ])
  })

  it('browser_wait passes kind/value/state/timeout through', async () => {
    await call('browser_wait', { for: 'text', value: 'Done', state: 'visible', timeoutMs: 5000 })
    expect(received[0].route).toBe('/wait')
    expect(received[0].body).toEqual({ kind: 'text', value: 'Done', state: 'visible', timeoutMs: 5000 })
  })

  it('browser_navigate and browser_tabs route correctly', async () => {
    await call('browser_navigate', { action: 'back' })
    await call('browser_tabs', { action: 'list' })
    await call('browser_tabs', { action: 'switch', id: 't2' })
    expect(received.map(r => r.route)).toEqual(['/back', '/tabs', '/tab/switch'])
  })

  it('browser_files handles upload/downloads/wait_download', async () => {
    await call('browser_files', { action: 'upload', ref: 'e9', paths: ['/tmp/a.txt'] })
    await call('browser_files', { action: 'downloads' })
    expect(received.map(r => [r.route, r.body])).toEqual([
      ['/upload', { ref: 'e9', files: ['/tmp/a.txt'] }],
      ['/downloads', {}],
    ])
  })

  it('browser_login_wait posts chat id from env and tells the agent to end its turn', async () => {
    const res = await call('browser_login_wait', { seconds: 120 })
    expect(received[0].route).toBe('/wait-login')
    expect(received[0].body).toEqual({ chatId: 'chat-42', timeoutMs: 120000 })
    const text = res.result.content[0].text
    expect(text.toLowerCase()).toContain('end')
  })

  it('bridge errors become isError tool results, not protocol errors', async () => {
    // The fake server returns HTTP 400 for /hover (see setup above).
    const res = await call('browser_interact', { action: 'hover', ref: 'e1' })
    expect(res.result.isError).toBe(true)
    expect(res.result.content[0].text).toContain('element not found')
  })

  it('unknown tools return a JSON-RPC error', async () => {
    const res = await call('browser_nope', {})
    expect(res.error).toBeDefined()
  })
})
