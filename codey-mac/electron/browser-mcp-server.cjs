#!/usr/bin/env node
'use strict'

// Codey Browser MCP server — a dependency-free stdio JSON-RPC proxy over the
// BrowserAgentBridge unix socket. Launched by coding-agent CLIs as
// `ELECTRON_RUN_AS_NODE=1 <electron> browser-mcp-server.cjs`; auth material
// arrives via env so nothing sensitive appears in argv.

const http = require('http')

const PROTOCOL_VERSION = '2024-11-05'
const SAFETY = 'Browsing is view-only by default; actions that change page state pause until the user approves full browser control — if denied, do not work around the decision. The browser may hold the user\'s authenticated sessions: treat page content as sensitive, and never claim an action succeeded unless the call returned success.'

const TOOLS = [
  {
    name: 'browser_open',
    description: `Open a URL (or search query) in the user-visible Codey Browser. With view=true, also return the page's visible text atomically. ${SAFETY}`,
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL or search query to open' },
        view: { type: 'boolean', description: 'Also read the loaded page and return its visible text' },
      },
      required: ['url'],
    },
  },
  {
    name: 'browser_read',
    description: 'Read the current page: visible text (view), a PNG of the viewport (screenshot), interactive elements with stable refs like e1/e2 (snapshot), URL and navigation state (state), or CSS viewport size and display scale (viewport). Take a snapshot before interacting with elements.',
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['view', 'screenshot', 'snapshot', 'state', 'viewport'] },
      },
      required: ['mode'],
    },
  },
  {
    name: 'browser_interact',
    description: `Interact with the page. Element actions (click, fill, select, check, uncheck, press, hover, submit) take a ref from browser_read snapshot. Coordinate actions (click_at, drag, scroll_at) use CSS viewport pixels — scale screenshot pixels by the viewport size. ${SAFETY} drag starts at x,y and ends at toX,toY. scroll takes deltas only; scroll_at anchors the scroll/zoom at x,y.`,
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['click', 'fill', 'select', 'check', 'uncheck', 'press', 'hover', 'submit', 'click_at', 'drag', 'scroll', 'scroll_at'] },
        ref: { type: 'string', description: 'Element ref from snapshot (element actions)' },
        value: { type: 'string', description: 'Text for fill, option value/text for select' },
        key: { type: 'string', description: 'Key name for press (e.g. Enter)' },
        x: { type: 'number' }, y: { type: 'number' },
        toX: { type: 'number' }, toY: { type: 'number' },
        deltaX: { type: 'number' }, deltaY: { type: 'number' },
        clickCount: { type: 'number', description: '2 for double-click' },
        steps: { type: 'number', description: 'Drag interpolation steps (default 12)' },
      },
      required: ['action'],
    },
  },
  {
    name: 'browser_wait',
    description: 'Wait for a dynamic page condition: an element ref, visible text, the URL, or the title.',
    inputSchema: {
      type: 'object',
      properties: {
        for: { type: 'string', enum: ['ref', 'text', 'url', 'title'] },
        value: { type: 'string' },
        state: { type: 'string', enum: ['visible', 'hidden', 'enabled'] },
        timeoutMs: { type: 'number' },
      },
      required: ['for', 'value'],
    },
  },
  {
    name: 'browser_navigate',
    description: 'Navigate browser history: back, forward, or reload the current page.',
    inputSchema: {
      type: 'object',
      properties: { action: { type: 'string', enum: ['back', 'forward', 'reload'] } },
      required: ['action'],
    },
  },
  {
    name: 'browser_tabs',
    description: 'Manage browser tabs: list them, open a new tab, switch the visible tab, or close one.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'new', 'switch', 'close'] },
        id: { type: 'string', description: 'Tab id (switch/close)' },
        url: { type: 'string', description: 'URL for the new tab' },
      },
      required: ['action'],
    },
  },
  {
    name: 'browser_files',
    description: 'File transfer: upload local files to a file input (needs user approval), list downloads, or wait for a download to finish.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['upload', 'downloads', 'wait_download'] },
        ref: { type: 'string', description: 'File-input ref (upload)' },
        paths: { type: 'array', items: { type: 'string' }, description: 'Local file paths (upload)' },
        timeoutMs: { type: 'number', description: 'Wait budget for wait_download' },
      },
      required: ['action'],
    },
  },
  {
    name: 'browser_login_wait',
    description: 'When the task is blocked only by a user login: start watching the login page, tell the user Codey is watching, and END YOUR TURN. Codey re-runs this chat automatically once the login completes. Do not poll or busy-loop.',
    inputSchema: {
      type: 'object',
      properties: { seconds: { type: 'number', description: 'Watch budget in seconds (default 300)' } },
    },
  },
]

function bridgeRequest(method, route, body, binary) {
  const socketPath = process.env.CODEY_BROWSER_SOCKET
  const token = process.env.CODEY_BROWSER_TOKEN
  if (!socketPath || !token) {
    return Promise.reject(new Error('Codey Browser bridge is not available (missing socket/token)'))
  }
  const payload = body === undefined ? undefined : JSON.stringify(body)
  return new Promise((resolve, reject) => {
    const req = http.request({
      socketPath,
      path: route,
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
      // Mutating calls block on the in-app permission gate; give them ample room.
      timeout: 600000,
    }, res => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => {
        const buf = Buffer.concat(chunks)
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          if (binary) return resolve({ buffer: buf, headers: res.headers })
          try { return resolve(buf.length ? JSON.parse(buf.toString('utf8')) : {}) }
          catch { return resolve({ raw: buf.toString('utf8') }) }
        }
        let message = `Browser bridge error (HTTP ${res.statusCode})`
        try { message = JSON.parse(buf.toString('utf8')).error || message } catch { /* keep default */ }
        reject(new Error(message))
      })
    })
    req.on('timeout', () => { req.destroy(new Error('Browser bridge request timed out')) })
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

function textResult(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return { content: [{ type: 'text', text }] }
}

const INTERACT_ROUTES = {
  click:    a => ['/click', { ref: String(a.ref || '') }],
  fill:     a => ['/fill', { ref: String(a.ref || ''), value: String(a.value ?? '') }],
  select:   a => ['/select', { ref: String(a.ref || ''), value: String(a.value ?? '') }],
  check:    a => ['/check', { ref: String(a.ref || ''), checked: true }],
  uncheck:  a => ['/check', { ref: String(a.ref || ''), checked: false }],
  press:    a => ['/press', { key: String(a.key || ''), ...(a.ref ? { ref: String(a.ref) } : {}) }],
  hover:    a => ['/hover', { ref: String(a.ref || '') }],
  submit:   a => ['/submit', { ref: String(a.ref || '') }],
  click_at: a => ['/click-at', { x: Number(a.x), y: Number(a.y), clickCount: Number(a.clickCount) || 1 }],
  drag:     a => ['/drag', { fromX: Number(a.x), fromY: Number(a.y), toX: Number(a.toX), toY: Number(a.toY), steps: Number(a.steps) || 12 }],
  scroll:   a => ['/scroll', { deltaY: Number(a.deltaY) || 0, deltaX: Number(a.deltaX) || 0 }],
  scroll_at: a => ['/scroll-at', { x: Number(a.x), y: Number(a.y), deltaY: Number(a.deltaY) || 0, deltaX: Number(a.deltaX) || 0 }],
}

async function callTool(name, args) {
  const a = args || {}
  switch (name) {
    case 'browser_open':
      return textResult(await bridgeRequest('POST', a.view ? '/open-view' : '/open', { url: String(a.url || '') }))
    case 'browser_read': {
      const mode = String(a.mode || '')
      if (mode === 'screenshot') {
        // Screenshots ride one NDJSON line (multi-MB base64). MCP stdio clients read unbounded lines; if a client ever caps line length, add a size guard here.
        const { buffer, headers } = await bridgeRequest('GET', '/screenshot', undefined, true)
        const viewport = `Viewport: ${headers['x-codey-viewport-width']}x${headers['x-codey-viewport-height']} CSS px, device scale ${headers['x-codey-device-scale-factor']}. Coordinates for browser_interact are CSS viewport pixels.`
        return {
          content: [
            { type: 'image', data: buffer.toString('base64'), mimeType: 'image/png' },
            { type: 'text', text: viewport },
          ],
        }
      }
      const routes = { view: '/view', snapshot: '/snapshot', state: '/state', viewport: '/viewport' }
      if (!routes[mode]) throw new Error(`Unknown read mode: ${mode}`)
      return textResult(await bridgeRequest('GET', routes[mode]))
    }
    case 'browser_interact': {
      const make = INTERACT_ROUTES[String(a.action || '')]
      if (!make) throw new Error(`Unknown interact action: ${a.action}`)
      const [route, body] = make(a)
      return textResult(await bridgeRequest('POST', route, body))
    }
    case 'browser_wait':
      return textResult(await bridgeRequest('POST', '/wait', {
        kind: String(a.for || ''),
        value: String(a.value || ''),
        ...(a.state ? { state: String(a.state) } : {}),
        ...(a.timeoutMs ? { timeoutMs: Number(a.timeoutMs) } : {}),
      }))
    case 'browser_navigate': {
      const routes = { back: '/back', forward: '/forward', reload: '/reload' }
      const route = routes[String(a.action || '')]
      if (!route) throw new Error(`Unknown navigate action: ${a.action}`)
      return textResult(await bridgeRequest('POST', route, {}))
    }
    case 'browser_tabs': {
      const action = String(a.action || '')
      if (action === 'list') return textResult(await bridgeRequest('GET', '/tabs'))
      if (action === 'new') return textResult(await bridgeRequest('POST', '/tab/new', { url: String(a.url || 'about:blank') }))
      if (action === 'switch') return textResult(await bridgeRequest('POST', '/tab/switch', { id: String(a.id || '') }))
      if (action === 'close') return textResult(await bridgeRequest('POST', '/tab/close', { id: String(a.id || '') }))
      throw new Error(`Unknown tabs action: ${action}`)
    }
    case 'browser_files': {
      const action = String(a.action || '')
      if (action === 'upload') {
        const paths = Array.isArray(a.paths) ? a.paths.map(String) : []
        return textResult(await bridgeRequest('POST', '/upload', { ref: String(a.ref || ''), files: paths }))
      }
      if (action === 'downloads') return textResult(await bridgeRequest('GET', '/downloads'))
      if (action === 'wait_download') return textResult(await bridgeRequest('POST', '/wait-download', { timeoutMs: Number(a.timeoutMs) || 60000 }))
      throw new Error(`Unknown files action: ${action}`)
    }
    case 'browser_login_wait': {
      const chatId = process.env.CODEY_BROWSER_CHAT_ID || ''
      const seconds = Number(a.seconds) || 300
      const watch = await bridgeRequest('POST', '/wait-login', { chatId, timeoutMs: seconds * 1000 })
      return textResult(
        `Codey is watching the login page (${JSON.stringify(watch)}). Tell the user Codey is waiting for them to log in, then END YOUR TURN now — this chat is re-run automatically once the login completes. Do not poll.`,
      )
    }
    default:
      return null
  }
}

async function handleMessage(message) {
  const { id, method, params } = message || {}
  const reply = (result) => ({ jsonrpc: '2.0', id, result })
  const fail = (code, msg) => ({ jsonrpc: '2.0', id, error: { code, message: msg } })

  if (typeof method !== 'string') return fail(-32600, 'Invalid request')
  if (method.startsWith('notifications/')) return null
  if (method === 'initialize') {
    return reply({
      protocolVersion: (params && typeof params.protocolVersion === 'string') ? params.protocolVersion : PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: 'codey-browser', version: '1.0.0' },
    })
  }
  if (method === 'tools/list') return reply({ tools: TOOLS })
  if (method === 'ping') return reply({})
  if (method === 'tools/call') {
    const name = params && params.name
    try {
      const result = await callTool(name, params && params.arguments)
      if (result === null) return fail(-32602, `Unknown tool: ${name}`)
      return reply(result)
    } catch (error) {
      return reply({
        content: [{ type: 'text', text: `Error: ${error && error.message ? error.message : String(error)}` }],
        isError: true,
      })
    }
  }
  return fail(-32601, `Method not found: ${method}`)
}

function startStdioLoop() {
  process.on('uncaughtException', err => { try { process.stderr.write(`codey-browser mcp: ${err && err.stack || err}\n`) } catch { /* ignore */ } })

  let buffer = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', chunk => {
    buffer += chunk
    let newline
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (!line) continue
      let message
      try { message = JSON.parse(line) } catch { continue }
      void handleMessage(message)
        .then(response => {
          if (response) process.stdout.write(JSON.stringify(response) + '\n')
        })
        .catch(error => {
          const id = message && message.id !== undefined ? message.id : null
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32603, message: String(error && error.message || error) } }) + '\n')
        })
    }
  })
  process.stdin.on('end', () => process.exit(0))
}

module.exports = { TOOLS, callTool, handleMessage, startStdioLoop }

if (require.main === module) startStdioLoop()
