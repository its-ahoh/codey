#!/usr/bin/env node
'use strict'

const http = require('http')
const fs = require('fs')
const os = require('os')
const path = require('path')

const socketPath = process.env.CODEY_BROWSER_SOCKET
const browserToken = process.env.CODEY_BROWSER_TOKEN
const chromeToken = process.env.CODEY_CHROME_COMPANION_TOKEN
const chatId = process.env.CODEY_BROWSER_CHAT_ID
const browserPluginEnabled = process.env.CODEY_BROWSER_PLUGIN_ENABLED === '1'
const chromeCompanionPluginEnabled = process.env.CODEY_CHROME_COMPANION_PLUGIN_ENABLED === '1'

// `--profile <name>` (or `-p <name>`) before the command selects the browser
// profile this command operates under. It is forwarded to the bridge as a
// header, and the bridge activates that profile before running the command —
// so every subsequent action happens under that profile's session.
let args = process.argv.slice(2)
let profile = ''
if ((args[0] === '--profile' || args[0] === '-p') && args.length > 1) {
  profile = args[1]
  args = args.slice(2)
}
const command = args[0]
const rest = args.slice(1)

function usage() {
  return [
    'Codey Browser agent tool',
    '  --profile <name>     Operate under a saved browser profile (activates it first)',
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
    '  state                 Read URL, navigation state and the active profile',
    '  back | forward        Navigate browser history',
    '  reload                Reload the current page',
    '  profile list               List saved profiles and the active one',
    '  profile save <name>        Snapshot the current session into a profile',
    '  profile import <path> [name]  Import a session file and activate it',
    '  profile activate <name>    Switch the live session to a profile',
    '  profile export <name> <path>  Write a profile to a shareable JSON file',
    '  profile delete <name>      Remove a profile',
    '  chrome status              Read Chrome Companion connection state',
    '  chrome tab                 Read the active real-Chrome tab',
    '  chrome view                Read the active real-Chrome page',
    '  chrome open <url>          Navigate the active real-Chrome tab',
  ].join('\n')
}

function authHeaders() {
  return {
    Authorization: `Bearer ${command === 'chrome' ? chromeToken : browserToken}`,
    ...(profile ? { 'X-Codey-Profile': profile } : {}),
  }
}

function requestBinary(method, route) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      socketPath,
      path: route,
      method,
      headers: authHeaders(),
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
        ...authHeaders(),
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
  if (!socketPath) throw new Error('Codey browser tools are not available in this agent session')
  const helpCommand = command === 'help' || command === '--help' || command === '-h' || command === undefined
  if (!helpCommand && command === 'chrome' && !chromeCompanionPluginEnabled) {
    throw new Error('The Chrome Companion plugin is not installed or enabled')
  }
  if (!helpCommand && command === 'chrome' && !chromeToken) throw new Error('Chrome Companion credentials are unavailable')
  if (!helpCommand && command !== 'chrome' && !browserPluginEnabled) {
    throw new Error('The Browser plugin is not installed or enabled')
  }
  if (!helpCommand && command !== 'chrome' && !browserToken) throw new Error('Browser credentials are unavailable')
  let value
  switch (command) {
    case 'open': {
      const url = rest.join(' ').trim()
      if (!url) throw new Error(`Missing URL\n${usage()}`)
      value = await request('POST', '/open', { url })
      break
    }
    case 'open-view': {
      const url = rest.join(' ').trim()
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
      const output = rest[0]
        ? path.resolve(rest[0])
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
    case 'wait-download': value = await request('POST', '/wait-download', { timeoutMs: Number(rest[0] || 60000) }); break
    case 'tabs': value = await request('GET', '/tabs'); break
    case 'new-tab': value = await request('POST', '/tab/new', { url: rest.join(' ') || 'about:blank' }); break
    case 'switch-tab': value = await request('POST', '/tab/switch', { id: rest[0] }); break
    case 'close-tab': value = await request('POST', '/tab/close', { id: rest[0] }); break
    case 'back': value = await request('POST', '/back'); break
    case 'forward': value = await request('POST', '/forward'); break
    case 'reload': value = await request('POST', '/reload'); break
    case 'click': value = await request('POST', '/click', { ref: rest[0] }); break
    case 'click-at': value = await request('POST', '/click-at', {
      x: Number(rest[0]), y: Number(rest[1]), clickCount: Number(rest[2] || 1),
    }); break
    case 'drag': value = await request('POST', '/drag', {
      fromX: Number(rest[0]), fromY: Number(rest[1]),
      toX: Number(rest[2]), toY: Number(rest[3]), steps: Number(rest[4] || 12),
    }); break
    case 'fill': value = await request('POST', '/fill', { ref: rest[0], value: rest.slice(1).join(' ') }); break
    case 'upload': value = await request('POST', '/upload', { ref: rest[0], files: rest.slice(1) }); break
    case 'select': value = await request('POST', '/select', { ref: rest[0], value: rest.slice(1).join(' ') }); break
    case 'check': value = await request('POST', '/check', { ref: rest[0], checked: true }); break
    case 'uncheck': value = await request('POST', '/check', { ref: rest[0], checked: false }); break
    case 'press': value = await request('POST', '/press', { key: rest[0], ref: rest[1] }); break
    case 'hover': value = await request('POST', '/hover', { ref: rest[0] }); break
    case 'scroll': value = await request('POST', '/scroll', { deltaY: Number(rest[0]), deltaX: Number(rest[1] || 0) }); break
    case 'scroll-at': value = await request('POST', '/scroll-at', {
      x: Number(rest[0]), y: Number(rest[1]),
      deltaY: Number(rest[2]), deltaX: Number(rest[3] || 0),
    }); break
    case 'wait': {
      const kind = rest[0]
      const waitArgs = rest.slice(1)
      let timeoutMs
      let state
      const timeoutIndex = waitArgs.indexOf('--timeout')
      if (timeoutIndex >= 0) {
        timeoutMs = Number(waitArgs[timeoutIndex + 1])
        waitArgs.splice(timeoutIndex, 2)
      }
      const stateIndex = waitArgs.indexOf('--state')
      if (stateIndex >= 0) {
        state = waitArgs[stateIndex + 1]
        waitArgs.splice(stateIndex, 2)
      }
      value = await request('POST', '/wait', { kind, value: waitArgs.join(' '), state, timeoutMs })
      break
    }
    case 'wait-login': {
      if (!chatId) throw new Error('Login waiting is only available from a Codey chat')
      const seconds = rest[0] === undefined ? 300 : Number(rest[0])
      if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('wait-login timeout must be a positive number of seconds')
      value = await request('POST', '/wait-login', { chatId, timeoutMs: Math.round(seconds * 1000) })
      break
    }
    case 'submit': value = await request('POST', '/submit', { ref: rest[0] }); break
    case 'profile': {
      const sub = rest[0]
      if (sub === 'list') {
        value = await request('GET', '/profiles')
      } else if (sub === 'save') {
        if (!rest[1]) throw new Error(`Missing profile name\n${usage()}`)
        value = await request('POST', '/profile/save', { name: rest[1] })
      } else if (sub === 'activate') {
        if (!rest[1]) throw new Error(`Missing profile name\n${usage()}`)
        value = await request('POST', '/profile/activate', { name: rest[1] })
      } else if (sub === 'delete') {
        if (!rest[1]) throw new Error(`Missing profile name\n${usage()}`)
        value = await request('POST', '/profile/delete', { name: rest[1] })
      } else if (sub === 'import') {
        if (!rest[1]) throw new Error(`Missing profile file path\n${usage()}`)
        value = await request('POST', '/profile/import', {
          ...(rest[2] ? { name: rest[2] } : {}),
          source: { path: rest[1] },
        })
      } else if (sub === 'export') {
        if (!rest[1] || !rest[2]) throw new Error(`profile export needs a profile name and an output path\n${usage()}`)
        value = await request('POST', '/profile/export', { name: rest[1], path: rest[2] })
      } else {
        throw new Error(`Unknown profile command: ${sub || ''}\n${usage()}`)
      }
      break
    }
    case 'chrome': {
      const sub = rest[0]
      if (sub === 'status') {
        value = await request('GET', '/chrome/status')
      } else if (sub === 'tab') {
        value = await request('GET', '/chrome/tab')
      } else if (sub === 'view') {
        value = await request('GET', '/chrome/view')
      } else if (sub === 'open') {
        const url = rest.slice(1).join(' ').trim()
        if (!url) throw new Error(`Missing Chrome URL\n${usage()}`)
        value = await request('POST', '/chrome/open', { url })
      } else {
        throw new Error(`Unknown Chrome command: ${sub || ''}\n${usage()}`)
      }
      break
    }
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
