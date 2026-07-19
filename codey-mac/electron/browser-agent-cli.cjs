#!/usr/bin/env node
'use strict'

const http = require('http')
const fs = require('fs')
const os = require('os')
const path = require('path')

const socketPath = process.env.CODEY_BROWSER_SOCKET
const token = process.env.CODEY_BROWSER_TOKEN
const chatId = process.env.CODEY_BROWSER_CHAT_ID
const command = process.argv[2]

function usage() {
  return [
    'Codey Browser agent tool',
    '  open <url or search>  Open a page and show the in-app browser',
    '  open-view <url>       Open a page and return its content atomically',
    '  view                  Read visible page text and performance timing',
    '  screenshot [path]     Save the current browser viewport as a PNG',
    '  viewport              Read CSS viewport size and display scale',
    '  snapshot              List interactive elements with stable refs',
    '  click <ref>            Click an element',
    '  click-at <x> <y> [n]   Click viewport coordinates (n supports double-click)',
    '  drag <x1> <y1> <x2> <y2> [steps]  Drag across a canvas or map',
    '  fill <ref> <text>      Replace a text field value',
    '  upload <ref> <path...> Attach local files to a file input',
    '  select <ref> <value>   Choose a select option by value or text',
    '  check|uncheck <ref>    Change a checkbox or radio button',
    '  press <key> [ref]      Press a key, optionally focused on an element',
    '  hover <ref>            Hover over an element',
    '  scroll <dy> [dx]       Scroll the page',
    '  scroll-at <x> <y> <dy> [dx]  Scroll or zoom at viewport coordinates',
    '  wait <ref|text|url|title> <value> [--state visible|hidden|enabled] [--timeout ms]',
    '  wait-login [seconds]   Watch login for up to 5 minutes, then resume this chat',
    '  downloads             List browser downloads and saved paths',
    '  wait-download [ms]    Wait for a download to finish',
    '  tabs                  List browser tabs',
    '  new-tab [url]         Open and switch to a new tab',
    '  switch-tab <id>       Switch the visible tab',
    '  close-tab <id>        Close a tab',
    '  submit <ref>           Submit the element\'s form',
    '  state                 Read URL and navigation state',
    '  back | forward        Navigate browser history',
    '  reload                Reload the current page',
  ].join('\n')
}

function requestBinary(method, route) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      socketPath,
      path: route,
      method,
      headers: { Authorization: `Bearer ${token}` },
      timeout: 300000,
    }, res => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => {
        const value = Buffer.concat(chunks)
        if ((res.statusCode || 500) >= 400) {
          try { return reject(new Error(JSON.parse(value.toString('utf8')).error || 'Browser screenshot failed')) }
          catch { return reject(new Error(`Browser screenshot failed (${res.statusCode})`)) }
        }
        resolve({ data: value, headers: res.headers })
      })
    })
    req.on('timeout', () => req.destroy(new Error('Codey Browser request timed out')))
    req.on('error', reject)
    req.end()
  })
}

function request(method, route, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body)
    const req = http.request({
      socketPath,
      path: route,
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
      // A first control command can wait here while the user reviews the
      // browser-control permission prompt in the Mac app.
      timeout: 300000,
    }, res => {
      let response = ''
      res.setEncoding('utf8')
      res.on('data', chunk => { response += chunk })
      res.on('end', () => {
        let value
        try { value = response ? JSON.parse(response) : {} }
        catch { return reject(new Error(`Invalid browser response: ${response.slice(0, 200)}`)) }
        if ((res.statusCode || 500) >= 400) return reject(new Error(value.error || `Browser request failed (${res.statusCode})`))
        resolve(value)
      })
    })
    req.on('timeout', () => req.destroy(new Error('Codey Browser request timed out')))
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

async function main() {
  if (!socketPath || !token) throw new Error('Codey Browser is not available in this agent session')
  let value
  switch (command) {
    case 'open': {
      const url = process.argv.slice(3).join(' ').trim()
      if (!url) throw new Error(`Missing URL\n${usage()}`)
      value = await request('POST', '/open', { url })
      break
    }
    case 'open-view': {
      const url = process.argv.slice(3).join(' ').trim()
      if (!url) throw new Error(`Missing URL\n${usage()}`)
      value = await request('POST', '/open-view', { url })
      break
    }
    case 'view': value = await request('GET', '/view'); break
    case 'viewport': value = await request('GET', '/viewport'); break
    case 'snapshot': value = await request('GET', '/snapshot'); break
    case 'screenshot': {
      const screenshot = await requestBinary('GET', '/screenshot')
      const png = screenshot.data
      const output = process.argv[3]
        ? path.resolve(process.argv[3])
        : path.join(os.tmpdir(), `codey-browser-${Date.now()}.png`)
      fs.writeFileSync(output, png, { mode: 0o600 })
      value = {
        path: output,
        bytes: png.length,
        viewport: {
          width: Number(screenshot.headers['x-codey-viewport-width'] || 0),
          height: Number(screenshot.headers['x-codey-viewport-height'] || 0),
          deviceScaleFactor: Number(screenshot.headers['x-codey-device-scale-factor'] || 1),
        },
      }
      break
    }
    case 'state': value = await request('GET', '/state'); break
    case 'downloads': value = await request('GET', '/downloads'); break
    case 'wait-download': value = await request('POST', '/wait-download', { timeoutMs: Number(process.argv[3] || 60000) }); break
    case 'tabs': value = await request('GET', '/tabs'); break
    case 'new-tab': value = await request('POST', '/tab/new', { url: process.argv.slice(3).join(' ') || 'about:blank' }); break
    case 'switch-tab': value = await request('POST', '/tab/switch', { id: process.argv[3] }); break
    case 'close-tab': value = await request('POST', '/tab/close', { id: process.argv[3] }); break
    case 'back': value = await request('POST', '/back'); break
    case 'forward': value = await request('POST', '/forward'); break
    case 'reload': value = await request('POST', '/reload'); break
    case 'click': value = await request('POST', '/click', { ref: process.argv[3] }); break
    case 'click-at': value = await request('POST', '/click-at', {
      x: Number(process.argv[3]), y: Number(process.argv[4]), clickCount: Number(process.argv[5] || 1),
    }); break
    case 'drag': value = await request('POST', '/drag', {
      fromX: Number(process.argv[3]), fromY: Number(process.argv[4]),
      toX: Number(process.argv[5]), toY: Number(process.argv[6]), steps: Number(process.argv[7] || 12),
    }); break
    case 'fill': value = await request('POST', '/fill', { ref: process.argv[3], value: process.argv.slice(4).join(' ') }); break
    case 'upload': value = await request('POST', '/upload', { ref: process.argv[3], files: process.argv.slice(4) }); break
    case 'select': value = await request('POST', '/select', { ref: process.argv[3], value: process.argv.slice(4).join(' ') }); break
    case 'check': value = await request('POST', '/check', { ref: process.argv[3], checked: true }); break
    case 'uncheck': value = await request('POST', '/check', { ref: process.argv[3], checked: false }); break
    case 'press': value = await request('POST', '/press', { key: process.argv[3], ref: process.argv[4] }); break
    case 'hover': value = await request('POST', '/hover', { ref: process.argv[3] }); break
    case 'scroll': value = await request('POST', '/scroll', { deltaY: Number(process.argv[3]), deltaX: Number(process.argv[4] || 0) }); break
    case 'scroll-at': value = await request('POST', '/scroll-at', {
      x: Number(process.argv[3]), y: Number(process.argv[4]),
      deltaY: Number(process.argv[5]), deltaX: Number(process.argv[6] || 0),
    }); break
    case 'wait': {
      const kind = process.argv[3]
      const args = process.argv.slice(4)
      let timeoutMs
      let state
      const timeoutIndex = args.indexOf('--timeout')
      if (timeoutIndex >= 0) {
        timeoutMs = Number(args[timeoutIndex + 1])
        args.splice(timeoutIndex, 2)
      }
      const stateIndex = args.indexOf('--state')
      if (stateIndex >= 0) {
        state = args[stateIndex + 1]
        args.splice(stateIndex, 2)
      }
      value = await request('POST', '/wait', { kind, value: args.join(' '), state, timeoutMs })
      break
    }
    case 'wait-login': {
      if (!chatId) throw new Error('Login waiting is only available from a Codey chat')
      const seconds = process.argv[3] === undefined ? 300 : Number(process.argv[3])
      if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('wait-login timeout must be a positive number of seconds')
      value = await request('POST', '/wait-login', { chatId, timeoutMs: Math.round(seconds * 1000) })
      break
    }
    case 'submit': value = await request('POST', '/submit', { ref: process.argv[3] }); break
    case 'help':
    case '--help':
    case '-h':
    case undefined:
      process.stdout.write(`${usage()}\n`)
      return
    default: throw new Error(`Unknown command: ${command}\n${usage()}`)
  }
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

main().catch(error => {
  process.stderr.write(`codey-browser: ${error.message || error}\n`)
  process.exitCode = 1
})
