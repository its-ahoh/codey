#!/usr/bin/env node
'use strict'

const http = require('http')

const socketPath = process.env.CODEY_TERMINAL_SOCKET
const token = process.env.CODEY_TERMINAL_TOKEN
const chatId = process.env.CODEY_TERMINAL_CHAT_ID
const cwd = process.env.CODEY_TERMINAL_CWD

function usage() {
  return [
    'Codey Terminal agent tool - drives the Terminal panel the user can see',
    '  sessions                     List this chat\'s terminals',
    '  open                         Open a new terminal tab in the chat\'s folder',
    '  run [options] -- <command>   Type a command + Enter, return its output',
    '  send [options] [text]        Type text and/or keys into a terminal',
    '  read [--lines N]             Read the terminal screen (default 200 lines)',
    '  wait [options]               Wait for new output',
    '  close                        Close a terminal tab',
    '',
    'Options:',
    '  --session <id>     Target a specific terminal (default: your current one)',
    '  --wait-for <regex> Return as soon as new output matches (case-insensitive; ^ and $ match per line)',
    '  --for <regex>      Same as --wait-for',
    '  --timeout <sec>    Give up waiting after this long (default 30, max 240)',
    '  --keys <list>      Keys for send, comma-separated: enter, tab, esc, space,',
    '                     backspace, up, down, left, right, ctrl-c, ctrl-d, ctrl-z, ctrl-l',
  ].join('\n')
}

function parse(argv) {
  const options = {}
  const positional = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--') {
      options.rest = argv.slice(i + 1)
      break
    }
    if (arg === '--session' || arg === '--wait-for' || arg === '--for' || arg === '--timeout'
      || arg === '--keys' || arg === '--lines') {
      if (i + 1 >= argv.length) throw new Error(`${arg} needs a value\n${usage()}`)
      options[arg.slice(2)] = argv[++i]
      continue
    }
    positional.push(arg)
  }
  return { options, positional }
}

function seconds(value) {
  if (value === undefined) return undefined
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) throw new Error('--timeout must be a positive number of seconds')
  return Math.round(n * 1000)
}

function request(route, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ chatId, cwd, ...body })
    const req = http.request({
      socketPath,
      path: route,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
      // The first typing command can wait here while the user reads the
      // approval prompt, and `run` can then wait up to 4 minutes for output.
      timeout: 600000,
    }, res => {
      let response = ''
      res.setEncoding('utf8')
      res.on('data', chunk => { response += chunk })
      res.on('end', () => {
        let value
        try { value = response ? JSON.parse(response) : {} }
        catch { return reject(new Error(`Invalid terminal response: ${response.slice(0, 200)}`)) }
        if ((res.statusCode || 500) >= 400) return reject(new Error(value.error || `Terminal request failed (${res.statusCode})`))
        resolve(value)
      })
    })
    req.on('timeout', () => req.destroy(new Error('Codey Terminal request timed out')))
    req.on('error', reject)
    req.write(payload)
    req.end()
  })
}

async function main() {
  const [command, ...args] = process.argv.slice(2)
  if (command === undefined || command === 'help' || command === '--help' || command === '-h') {
    process.stdout.write(`${usage()}\n`)
    return
  }
  if (!socketPath || !token) throw new Error('Codey Terminal tools are not available in this agent session')
  if (!chatId) throw new Error('The Codey Terminal is only available from a Codey chat')
  const { options, positional } = parse(args)
  const session = options.session ? { sessionId: options.session } : {}
  const waitFor = options['wait-for'] ?? options.for
  const timeoutMs = seconds(options.timeout)
  let value
  switch (command) {
    case 'sessions': value = await request('/sessions', {}); break
    case 'open': value = await request('/open', {}); break
    case 'run': {
      const words = options.rest ?? positional
      const line = words.join(' ').trim()
      if (!line) throw new Error(`Missing command - put it after --\n${usage()}`)
      value = await request('/run', { ...session, command: line, waitFor, timeoutMs })
      break
    }
    case 'send': {
      const text = (options.rest ?? positional).join(' ')
      const keys = options.keys ? options.keys.split(',') : []
      value = await request('/send', { ...session, text, keys, waitFor, timeoutMs })
      break
    }
    case 'read': {
      const lines = options.lines === undefined ? undefined : Number(options.lines)
      value = await request('/read', { ...session, lines })
      break
    }
    case 'wait': value = await request('/wait', { ...session, waitFor, timeoutMs }); break
    case 'close': value = await request('/close', session); break
    default: throw new Error(`Unknown command: ${command}\n${usage()}`)
  }
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

main().catch(error => {
  process.stderr.write(`codey-terminal: ${error.message || error}\n`)
  process.exitCode = 1
})
