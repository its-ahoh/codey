import * as http from 'http'
import * as os from 'os'
import * as path from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanTerminalText, TerminalAgentBridge, type SettleTimings, type TerminalAgentBridgeInfo } from './terminal-agent-bridge'
import { TerminalSessionManager } from './terminal-sessions'
import { FakePty, fakeSpawn } from './terminal-pty.fixture'
import type { TerminalControlRequest } from './terminal-control-permission'

const execFileAsync = promisify(execFile)
const CWD = os.tmpdir()

const FAST: SettleTimings = {
  pollMs: 10, doneQuietMs: 40, minDoneMs: 40, runningQuietMs: 200, startupQuietMs: 20, startupMaxMs: 500,
}

/** A tiny pretend shell: `echo X` prints X, `serve` starts a server that
 *  becomes ready later, `ask` waits for a y/n answer, `quiet` hangs silently. */
function shell(line: string, pty: FakePty) {
  if (pty.busy && pty.mode === 'ask') {
    pty.busy = false
    pty.mode = ''
    pty.emit(line === 'y' ? 'ok\r\n$ ' : 'cancelled\r\n$ ')
    return
  }
  if (line.startsWith('echo ')) {
    pty.emit(`\x1b[32m${line.slice(5)}\x1b[0m\r\n$ `)
  } else if (line === 'serve') {
    pty.busy = true
    pty.emit('starting\r\n')
    setTimeout(() => pty.emit('ready on :3000\r\n'), 80)
  } else if (line === 'ask') {
    pty.busy = true
    pty.mode = 'ask'
    pty.emit('Continue? [y/n] ')
  } else if (line === 'quiet') {
    pty.busy = true
  } else {
    pty.emit('$ ')
  }
}

function call(info: TerminalAgentBridgeInfo, route: string, body: unknown, token = info.token): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body)
    const req = http.request({
      socketPath: info.socketPath, path: route, method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, res => {
      let raw = ''
      res.setEncoding('utf8')
      res.on('data', chunk => { raw += chunk })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw) }))
    })
    req.on('error', reject)
    req.write(payload)
    req.end()
  })
}

let manager: TerminalSessionManager
let spawned: FakePty[]
let bridge: TerminalAgentBridge
let info: TerminalAgentBridgeInfo
let approvals: TerminalControlRequest[]
let allow: boolean
let reveal: ReturnType<typeof vi.fn<(event: { chatId: string; sessionId: string; cwd: string }) => void>>

beforeEach(async () => {
  const fake = fakeSpawn(shell)
  spawned = fake.spawned
  manager = new TerminalSessionManager(fake.spawn, { data: () => {}, exit: () => {} })
  approvals = []
  allow = true
  reveal = vi.fn()
  bridge = new TerminalAgentBridge(manager, {
    atPrompt: async session => !(session.process as FakePty).busy,
    title: async session => ((session.process as FakePty).busy ? 'node' : 'zsh'),
    reveal,
    requestControl: async request => { approvals.push(request); return allow },
  }, FAST)
  info = await bridge.start()
})

afterEach(async () => {
  await bridge.stop()
  manager.closeAll()
})

const chat = { chatId: 'chat-1', cwd: CWD }

describe('cleanTerminalText', () => {
  it('removes colors and titles, applies overwrites and backspaces', () => {
    expect(cleanTerminalText('\x1b]0;title\x07\x1b[1;31mred\x1b[0m\r\n10%\r50%\r100%\r\nab\bc  \r\n')).toBe('red\n100%\nac')
  })
})

describe('TerminalAgentBridge', () => {
  it('rejects a wrong token and a request without a chat', async () => {
    expect((await call(info, '/sessions', chat, 'nope')).status).toBe(401)
    const missing = await call(info, '/sessions', { cwd: CWD })
    expect(missing.status).toBe(400)
    expect(missing.body.error).toContain('only available from a Codey chat')
  })

  it('first run opens an agent tab, shows it, asks, then returns the output', async () => {
    const res = await call(info, '/run', { ...chat, command: 'echo hello' })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ state: 'done', truncated: false })
    expect(res.body.output).toBe('echo hello\nhello\n$')
    expect(approvals).toEqual([{ chatId: 'chat-1', sessionId: res.body.sessionId, command: 'run', preview: 'echo hello' }])
    expect(reveal).toHaveBeenCalledWith({ chatId: 'chat-1', sessionId: res.body.sessionId, cwd: CWD })
    expect(manager.get(res.body.sessionId)?.agent).toBe(true)

    // The next command reuses the same tab.
    const again = await call(info, '/run', { ...chat, command: 'echo again' })
    expect(again.body.sessionId).toBe(res.body.sessionId)
    expect(spawned).toHaveLength(1)
  })

  it('a denied command is not typed', async () => {
    allow = false
    const res = await call(info, '/run', { ...chat, command: 'echo nope' })
    expect(res.status).toBe(403)
    expect(spawned[0].written).toEqual([])
  })

  it('waits for a pattern from a server that keeps running', async () => {
    const res = await call(info, '/run', { ...chat, command: 'serve', waitFor: 'ready on' })
    expect(res.body.state).toBe('matched')
    expect(res.body.output).toContain('ready on :3000')
    const sessions = await call(info, '/sessions', chat)
    expect(sessions.body.sessions).toEqual([expect.objectContaining({ id: res.body.sessionId, agent: true, current: true, title: 'node', alive: true })])
  })

  it('does not match the pattern against the echoed command line', async () => {
    const res = await call(info, '/run', { ...chat, command: 'echo done-marker', waitFor: 'never-printed|echo done' })
    // "echo done" appears only in the echo; the command's own output does not
    // match, so the run settles as finished rather than matched.
    expect(res.body.state).toBe('done')
    const matched = await call(info, '/run', { ...chat, command: 'echo done-marker', waitFor: '^done-marker$' })
    expect(matched.body.state).toBe('matched')
  })

  it('reports a program waiting for input as running, then answers it with send', async () => {
    const asked = await call(info, '/run', { ...chat, command: 'ask' })
    expect(asked.body.state).toBe('running')
    expect(asked.body.output).toContain('Continue? [y/n]')
    const answered = await call(info, '/send', { ...chat, text: 'y', keys: ['enter'] })
    expect(answered.body).toMatchObject({ state: 'done', sessionId: asked.body.sessionId })
    expect(answered.body.output).toContain('ok')
    expect(approvals.map(a => [a.command, a.preview])).toEqual([['run', 'ask'], ['send', '"y" + keys: enter']])
  })

  it('times out without stopping the program, and ctrl-c stops it', async () => {
    const res = await call(info, '/run', { ...chat, command: 'quiet', waitFor: 'never', timeoutMs: 150 })
    expect(res.body.state).toBe('timeout')
    const stopped = await call(info, '/send', { ...chat, keys: ['ctrl-c'] })
    expect(stopped.body.state).toBe('done')
    expect(spawned[0].written.at(-1)).toBe('\x03')
  })

  it('rejects unknown keys and multi-line commands', async () => {
    await call(info, '/open', chat)
    expect((await call(info, '/send', { ...chat, keys: ['hyper'] })).body.error).toContain('Unknown key: hyper')
    expect((await call(info, '/run', { ...chat, command: 'a\nb' })).body.error).toContain('one command line')
  })

  it('only sees this chat\'s terminals', async () => {
    const opened = await call(info, '/open', chat)
    const other = await call(info, '/read', { chatId: 'chat-2', cwd: CWD, sessionId: opened.body.sessionId })
    expect(other.status).toBe(404)
    expect((await call(info, '/read', { chatId: 'chat-2', cwd: CWD })).body.error).toContain('no terminal yet')
  })

  it('uses the user\'s only terminal when it has none of its own, and asks to choose among several', async () => {
    const mine = await manager.open('chat-1', CWD, 80, 24)
    ;(manager.get(mine.sessionId)!.process as FakePty).emit('user stuff\r\n$ ')
    const read = await call(info, '/read', chat)
    expect(read.body).toMatchObject({ sessionId: mine.sessionId, alive: true })
    expect(read.body.output).toContain('user stuff')
    await manager.open('chat-1', CWD, 80, 24)
    expect((await call(info, '/read', chat)).body.error).toContain('several terminals')
  })

  it('close asks first and ends the session', async () => {
    const opened = await call(info, '/open', chat)
    const closed = await call(info, '/close', chat)
    expect(closed.body).toEqual({ sessionId: opened.body.sessionId, closed: true })
    expect(approvals.at(-1)?.command).toBe('close')
    expect(manager.get(opened.body.sessionId)).toBeUndefined()
  })

  it('reports an exited shell', async () => {
    const opened = await call(info, '/open', chat)
    setTimeout(() => {
      const session = manager.get(opened.body.sessionId)!
      ;(session.process as FakePty).exit(0)
    }, 30)
    const waited = await call(info, '/wait', { ...chat, waitFor: 'x', timeoutMs: 2000 })
    expect(waited.body.state).toBe('exited')
  })

  it('works end to end through the CLI agents run', async () => {
    const cli = path.join(__dirname, 'terminal-agent-cli.cjs')
    const env = {
      ...process.env,
      CODEY_TERMINAL_SOCKET: info.socketPath,
      CODEY_TERMINAL_TOKEN: info.token,
      CODEY_TERMINAL_CHAT_ID: 'chat-1',
      CODEY_TERMINAL_CWD: CWD,
    }
    const { stdout } = await execFileAsync(process.execPath, [cli, 'run', '--', 'echo', 'from-cli'], { env })
    const result = JSON.parse(stdout)
    expect(result.state).toBe('done')
    expect(result.output).toContain('from-cli')
    const read = JSON.parse((await execFileAsync(process.execPath, [cli, 'read', '--lines', '1'], { env })).stdout)
    expect(read.output).toBe('$')
    await expect(execFileAsync(process.execPath, [cli, 'run', '--', 'echo', 'x'], {
      env: { ...env, CODEY_TERMINAL_CHAT_ID: '' },
    })).rejects.toMatchObject({ stderr: expect.stringContaining('only available from a Codey chat') })
  })
})
