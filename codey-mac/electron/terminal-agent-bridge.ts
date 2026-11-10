import * as fs from 'fs'
import * as http from 'http'
import * as os from 'os'
import * as path from 'path'
import { randomBytes } from 'crypto'
import type { TerminalSession, TerminalSessionManager } from './terminal-sessions'
import type { TerminalControlRequest } from './terminal-control-permission'

export interface TerminalAgentBridgeInfo {
  socketPath: string
  token: string
}

export interface TerminalBridgeHost {
  /** True when the shell itself holds the terminal (the user would see a
   *  prompt), false while a program runs in it, null when it cannot tell. */
  atPrompt(session: TerminalSession): Promise<boolean | null>
  /** The program in the foreground, for `sessions`. */
  title(session: TerminalSession): Promise<string>
  /** Show this session in the chat's Terminal panel. */
  reveal(event: { chatId: string; sessionId: string; cwd: string }): void
  requestControl(request: TerminalControlRequest): Promise<boolean>
}

export type SettleState = 'done' | 'running' | 'matched' | 'timeout' | 'exited'

export interface SettleTimings {
  /** How often the session is checked. */
  pollMs: number
  /** Quiet time before "back at the prompt" counts as finished. */
  doneQuietMs: number
  /** Minimum time after typing before "back at the prompt" can count, so the
   *  shell has a chance to start the command first. */
  minDoneMs: number
  /** Quiet time before a program that still holds the terminal is reported
   *  as `running` (a server, a watcher, a prompt waiting for input). */
  runningQuietMs: number
  /** Quiet time that counts as "a fresh shell finished starting up". */
  startupQuietMs: number
  startupMaxMs: number
}

export const DEFAULT_TIMINGS: SettleTimings = {
  pollMs: 120,
  doneQuietMs: 300,
  minDoneMs: 400,
  runningQuietMs: 5_000,
  startupQuietMs: 300,
  startupMaxMs: 3_000,
}

const DEFAULT_TIMEOUT_MS = 30_000
const MAX_TIMEOUT_MS = 240_000
const OUTPUT_LIMIT = 20_000
const AGENT_COLS = 120
const AGENT_ROWS = 32

/** Named keys `send --keys` understands, as the bytes a terminal sends. */
export const TERMINAL_KEYS: Record<string, string> = {
  enter: '\r',
  tab: '\t',
  esc: '\x1b',
  space: ' ',
  backspace: '\x7f',
  up: '\x1b[A',
  down: '\x1b[B',
  right: '\x1b[C',
  left: '\x1b[D',
  'ctrl-c': '\x03',
  'ctrl-d': '\x04',
  'ctrl-z': '\x1a',
  'ctrl-l': '\x0c',
}

/**
 * Turn raw terminal bytes into the text a person would read: colors, cursor
 * moves and title updates removed, carriage-return overwrites (progress bars)
 * collapsed to their final state, backspaces applied.
 */
/* eslint-disable no-control-regex -- terminal output is made of control characters */
export function cleanTerminalText(raw: string): string {
  const stripped = raw
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1bP[\s\S]*?\x1b\\/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[()][0-9A-Za-z]/g, '')
    .replace(/\x1b[@-Z\\-_=>78]/g, '')
  const lines = stripped.replace(/\r+\n/g, '\n').split('\n').map(line => {
    const segments = line.split('\r')
    let text = segments.filter(segment => segment.length > 0).pop() ?? ''
    if (text.includes('\b')) {
      const chars: string[] = []
      for (const ch of text) {
        if (ch === '\b') chars.pop()
        else chars.push(ch)
      }
      text = chars.join('')
    }
    return text.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').replace(/\s+$/, '')
  })
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '').replace(/\n+$/, '')
}
/* eslint-enable no-control-regex */

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
      if (body.length > 128 * 1024) reject(new Error('Request is too large'))
    })
    req.on('end', () => {
      if (!body) return resolve({})
      try { resolve(JSON.parse(body)) }
      catch { reject(new Error('Invalid JSON')) }
    })
    req.on('error', reject)
  })
}

class BridgeError extends Error {
  constructor(message: string, readonly status = 400) { super(message) }
}

const str = (value: unknown): string => (typeof value === 'string' ? value : '')

function timeoutFrom(value: unknown): number {
  const ms = typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : DEFAULT_TIMEOUT_MS
  return Math.min(MAX_TIMEOUT_MS, Math.round(ms))
}

function patternFrom(value: unknown): RegExp | undefined {
  const source = str(value)
  if (!source) return undefined
  try { return new RegExp(source, 'im') }
  catch (error) { throw new BridgeError(`Invalid --wait-for pattern: ${(error as Error).message}`) }
}

/**
 * Private local bridge that lets a coding agent's shell tool drive the Terminal
 * panel. Each request names the chat it comes from; an agent only ever sees and
 * types into that chat's terminals.
 */
export class TerminalAgentBridge {
  private server: http.Server | null = null
  private info: TerminalAgentBridgeInfo | null = null
  /** The tab an agent last used in each chat, reused by commands that do not
   *  name one. */
  private readonly current = new Map<string, string>()

  constructor(
    private readonly sessions: TerminalSessionManager,
    private readonly host: TerminalBridgeHost,
    private readonly timings: SettleTimings = DEFAULT_TIMINGS,
  ) {}

  async start(): Promise<TerminalAgentBridgeInfo> {
    if (this.info) return this.info
    const token = randomBytes(32).toString('hex')
    const socketPath = path.join(os.tmpdir(), `cyt-${process.pid}-${randomBytes(5).toString('hex')}.sock`)
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
    if (server) await new Promise<void>(resolve => server.close(() => resolve()))
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
      if (req.method !== 'POST') throw new BridgeError('Not found', 404)
      const body = await readJson(req)
      const chatId = str(body.chatId)
      if (!chatId) throw new BridgeError('The Terminal is only available from a Codey chat')
      switch (route) {
        case '/sessions': return json(res, 200, await this.listSessions(chatId))
        case '/open': return json(res, 200, await this.open(chatId, str(body.cwd)))
        case '/run': return json(res, 200, await this.run(chatId, body))
        case '/send': return json(res, 200, await this.send(chatId, body))
        case '/read': return json(res, 200, this.read(chatId, body))
        case '/wait': return json(res, 200, await this.wait(chatId, body))
        case '/close': return json(res, 200, await this.close(chatId, body))
        default: throw new BridgeError('Not found', 404)
      }
    } catch (error) {
      const status = error instanceof BridgeError ? error.status : 500
      json(res, status, { error: error instanceof Error ? error.message : String(error) })
    }
  }

  private async listSessions(chatId: string) {
    const current = this.current.get(chatId)
    return {
      sessions: await Promise.all(this.sessions.list(chatId).map(async session => ({
        id: session.id,
        cwd: session.cwd,
        alive: session.alive,
        agent: session.agent,
        current: session.id === current,
        title: await this.host.title(session),
      }))),
    }
  }

  private async open(chatId: string, cwd: string) {
    if (!cwd) throw new BridgeError('A working directory is required to open a terminal')
    const opened = await this.sessions.open(chatId, cwd, AGENT_COLS, AGENT_ROWS, undefined, { agent: true })
    const session = this.sessions.get(opened.sessionId)!
    this.current.set(chatId, session.id)
    this.host.reveal({ chatId, sessionId: session.id, cwd })
    // Let the login shell print its prompt before anything is typed, so the
    // first command's output does not start mid-startup.
    await this.settle(session, 0, {
      timeoutMs: this.timings.startupMaxMs, startup: true,
    })
    return { sessionId: session.id, cwd, opened: true }
  }

  /** The session a command targets: the one it names (which must belong to
   *  this chat), else the agent's current tab, else the only live tab. */
  private target(chatId: string, sessionId: string): TerminalSession | undefined {
    if (sessionId) {
      const named = this.sessions.get(sessionId)
      if (!named || named.chatId !== chatId) throw new BridgeError(`No terminal ${sessionId} in this chat`, 404)
      return named
    }
    const current = this.sessions.get(this.current.get(chatId) ?? '')
    if (current?.alive && current.chatId === chatId) return current
    const live = this.sessions.list(chatId).filter(session => session.alive)
    const agents = live.filter(session => session.agent)
    if (agents.length > 0) return agents[agents.length - 1]
    if (live.length === 1) return live[0]
    if (live.length > 1) {
      throw new BridgeError('This chat has several terminals - pass --session <id> (see "sessions")')
    }
    return undefined
  }

  private requireTarget(chatId: string, sessionId: string): TerminalSession {
    const session = this.target(chatId, sessionId)
    if (!session) throw new BridgeError('This chat has no terminal yet - use "run" or "open" first')
    return session
  }

  private async approve(request: TerminalControlRequest): Promise<void> {
    if (!await this.host.requestControl(request)) {
      throw new BridgeError('The user did not allow this terminal action', 403)
    }
  }

  private async run(chatId: string, body: Record<string, unknown>) {
    const command = str(body.command)
    if (!command.trim()) throw new BridgeError('A command is required')
    if (/[\r\n]/.test(command)) throw new BridgeError('Run one command line at a time (no newlines)')
    const pattern = patternFrom(body.waitFor)
    const timeoutMs = timeoutFrom(body.timeoutMs)
    let session = this.target(chatId, str(body.sessionId))
    if (session && !session.alive) throw new BridgeError(`Terminal ${session.id} has exited - open a new one`)
    if (!session) {
      // Opening is free; it also puts the tab on screen, so the user reads
      // the approval prompt right where the command will run.
      const opened = await this.open(chatId, str(body.cwd))
      session = this.sessions.get(opened.sessionId)!
    } else {
      this.host.reveal({ chatId, sessionId: session.id, cwd: session.cwd })
    }
    await this.approve({ chatId, sessionId: session.id, command: 'run', preview: command })
    return await this.typeAndSettle(session, `${command}\r`, { pattern, timeoutMs })
  }

  private async send(chatId: string, body: Record<string, unknown>) {
    const text = str(body.text)
    const keys = Array.isArray(body.keys) ? body.keys.map(key => String(key).trim().toLowerCase()).filter(Boolean) : []
    const unknown = keys.filter(key => !(key in TERMINAL_KEYS))
    if (unknown.length) throw new BridgeError(`Unknown key: ${unknown.join(', ')}. Known: ${Object.keys(TERMINAL_KEYS).join(', ')}`)
    if (!text && keys.length === 0) throw new BridgeError('Nothing to send - give text and/or --keys')
    const session = this.requireTarget(chatId, str(body.sessionId))
    if (!session.alive) throw new BridgeError(`Terminal ${session.id} has exited - open a new one`)
    const preview = [text ? JSON.stringify(text) : '', keys.length ? `keys: ${keys.join(', ')}` : ''].filter(Boolean).join(' + ')
    this.host.reveal({ chatId, sessionId: session.id, cwd: session.cwd })
    await this.approve({ chatId, sessionId: session.id, command: 'send', preview })
    const data = text + keys.map(key => TERMINAL_KEYS[key]).join('')
    return await this.typeAndSettle(session, data, {
      pattern: patternFrom(body.waitFor),
      timeoutMs: timeoutFrom(body.timeoutMs),
    })
  }

  private read(chatId: string, body: Record<string, unknown>) {
    const session = this.requireTarget(chatId, str(body.sessionId))
    const lines = typeof body.lines === 'number' && body.lines > 0 ? Math.min(5000, Math.floor(body.lines)) : 200
    const all = cleanTerminalText(session.output).split('\n')
    return {
      sessionId: session.id,
      alive: session.alive,
      output: all.slice(-lines).join('\n'),
      truncated: all.length > lines,
    }
  }

  private async wait(chatId: string, body: Record<string, unknown>) {
    const session = this.requireTarget(chatId, str(body.sessionId))
    const pattern = patternFrom(body.waitFor)
    const result = await this.settle(session, session.written, { pattern, timeoutMs: timeoutFrom(body.timeoutMs) })
    return this.result(session, result.offset, result.state)
  }

  private async close(chatId: string, body: Record<string, unknown>) {
    const session = this.requireTarget(chatId, str(body.sessionId))
    await this.approve({ chatId, sessionId: session.id, command: 'close', preview: `close terminal ${session.id}` })
    this.sessions.close(session.id)
    if (this.current.get(chatId) === session.id) this.current.delete(chatId)
    return { sessionId: session.id, closed: true }
  }

  private async typeAndSettle(
    session: TerminalSession,
    data: string,
    options: { pattern?: RegExp; timeoutMs: number },
  ) {
    this.current.set(session.chatId, session.id)
    this.host.reveal({ chatId: session.chatId, sessionId: session.id, cwd: session.cwd })
    const offset = session.written
    this.sessions.write(session.id, data)
    // Only text ending in Enter produces an echoed line to skip; bare keys
    // like ctrl-c do not.
    const result = await this.settle(session, offset, { ...options, skipEcho: data.endsWith('\r') })
    return this.result(session, offset, result.state)
  }

  private result(session: TerminalSession, offset: number, state: SettleState) {
    const since = this.sessions.outputSince(session, offset)
    let output = cleanTerminalText(since.text)
    let truncated = since.lost
    if (output.length > OUTPUT_LIMIT) {
      output = output.slice(-OUTPUT_LIMIT)
      truncated = true
    }
    return { sessionId: session.id, state, output, truncated }
  }

  /**
   * Watch a session until something worth reporting happens: the pattern
   * shows up in new output, the shell is back at its prompt, a program has
   * held the terminal quietly for a while, the shell exits, or time runs out.
   */
  private async settle(
    session: TerminalSession,
    offset: number,
    { pattern, timeoutMs, startup = false, skipEcho = false }: {
      pattern?: RegExp; timeoutMs: number; startup?: boolean; skipEcho?: boolean
    },
  ): Promise<{ state: SettleState; offset: number }> {
    const t = this.timings
    const started = Date.now()
    let lastWritten = session.written
    let lastChange = started
    for (;;) {
      await new Promise(resolve => setTimeout(resolve, t.pollMs))
      const now = Date.now()
      if (session.written !== lastWritten) {
        lastWritten = session.written
        lastChange = now
      }
      if (!session.alive) return { state: 'exited', offset }
      if (pattern) {
        let text = this.sessions.outputSince(session, offset).text
        // The shell echoes what was typed, and a pattern must not match the
        // command line itself (`--wait-for ready -- echo ready` would return
        // before anything ran). Look only past the line break Enter produced.
        if (skipEcho) {
          const lineBreak = text.indexOf('\n')
          text = lineBreak < 0 ? '' : text.slice(lineBreak + 1)
        }
        if (pattern.test(cleanTerminalText(text))) return { state: 'matched', offset }
      }
      const quiet = now - lastChange
      if (startup) {
        if (session.written > 0 && quiet >= t.startupQuietMs) return { state: 'done', offset }
      } else if (quiet >= t.doneQuietMs && now - started >= t.minDoneMs) {
        const prompt = await this.host.atPrompt(session)
        if (prompt !== false) {
          // Back at the prompt: the command finished. A pattern that never
          // showed up cannot show up any more.
          return { state: 'done', offset }
        }
        if (!pattern && quiet >= t.runningQuietMs) return { state: 'running', offset }
      }
      if (now - started >= timeoutMs) return { state: 'timeout', offset }
    }
  }
}
