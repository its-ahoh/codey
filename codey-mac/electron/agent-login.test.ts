import { describe, expect, it, vi } from 'vitest'
import { AgentLoginRunner, firstUrl, type LoginProgress } from './agent-login'
import type { PtyLike } from './terminal-sessions'

function fakePty() {
  let onData: (d: string) => void = () => {}
  let onExit: (e: { exitCode: number }) => void = () => {}
  const pty: PtyLike & { emit(d: string): void; exit(code: number): void; killed: boolean } = {
    pid: 1,
    killed: false,
    write: vi.fn(),
    resize: vi.fn(),
    kill() { this.killed = true; onExit({ exitCode: 1 }) },
    onData(l) { onData = l },
    onExit(l) { onExit = l },
    emit(d) { onData(d) },
    exit(code) { onExit({ exitCode: code }) },
  }
  return pty
}

function runner(over: Partial<ConstructorParameters<typeof AgentLoginRunner>[0]> = {}) {
  const ptys: ReturnType<typeof fakePty>[] = []
  const events: LoginProgress[] = []
  const spawn = vi.fn(() => { const p = fakePty(); ptys.push(p); return p })
  const r = new AgentLoginRunner({
    spawn,
    shell: () => '/bin/zsh',
    env: () => ({ PATH: '/bin' }),
    cwd: () => '/tmp',
    checkSignedIn: async () => true,
    emit: e => events.push(e),
    ...over,
  })
  return { r, ptys, events, spawn }
}

describe('firstUrl', () => {
  it('finds an https link in terminal output, without colour codes', () => {
    expect(firstUrl('Open \u001b[4mhttps://claude.ai/oauth/authorize?code=1\u001b[0m to sign in')).toBe('https://claude.ai/oauth/authorize?code=1')
    expect(firstUrl('nothing here')).toBeUndefined()
  })
})

describe('AgentLoginRunner', () => {
  it('runs the CLI login in the login shell and succeeds when status agrees', async () => {
    const { r, ptys, events, spawn } = runner()
    const done = r.login('claude-code')
    expect(spawn).toHaveBeenCalledWith('/bin/zsh', ['-i', '-c', 'claude auth login'], expect.objectContaining({ cwd: '/tmp' }))
    ptys[0].exit(0)
    const result = await done
    expect(result.phase).toBe('succeeded')
    expect(events.map(e => e.phase)).toEqual(['starting', 'succeeded'])
  })

  it('reports the sign-in page when the CLI prints one', async () => {
    const { r, ptys, events } = runner()
    const done = r.login('codex')
    ptys[0].emit('Visit https://auth.openai.com/oauth?x=1 to continue\r\n')
    ptys[0].exit(0)
    await done
    expect(events.find(e => e.phase === 'waiting')?.url).toBe('https://auth.openai.com/oauth?x=1')
  })

  it('fails when the CLI exits clean but is still signed out', async () => {
    const { r, ptys } = runner({ checkSignedIn: async () => false })
    const done = r.login('codex')
    ptys[0].emit('Login cancelled\r\n')
    ptys[0].exit(0)
    const result = await done
    expect(result.phase).toBe('failed')
    expect(result.output).toContain('Login cancelled')
    expect(result.command).toBe('codex login')
  })

  it('succeeds on a non-zero exit when status says signed in', async () => {
    const { r, ptys } = runner({ checkSignedIn: async () => true })
    const done = r.login('codex')
    ptys[0].exit(1)
    expect((await done).phase).toBe('succeeded')
  })

  it('joins a second request for the same agent to the first run', async () => {
    const { r, ptys, spawn } = runner()
    const a = r.login('claude-code')
    const b = r.login('claude-code')
    expect(spawn).toHaveBeenCalledTimes(1)
    ptys[0].exit(0)
    expect((await a).phase).toBe('succeeded')
    expect((await b).phase).toBe('succeeded')
  })

  it('runs different agents side by side', () => {
    const { r, spawn } = runner()
    void r.login('claude-code')
    void r.login('codex')
    expect(spawn).toHaveBeenCalledTimes(2)
  })

  it('cancel kills the process and reports cancelled', async () => {
    const { r, ptys } = runner()
    const done = r.login('claude-code')
    r.cancel('claude-code')
    expect(ptys[0].killed).toBe(true)
    expect((await done).phase).toBe('cancelled')
  })

  it('times out, kills the process and fails', async () => {
    vi.useFakeTimers()
    try {
      const { r, ptys } = runner({ timeoutMs: 1000, checkSignedIn: async () => false })
      const done = r.login('claude-code')
      await vi.advanceTimersByTimeAsync(1001)
      const result = await done
      expect(ptys[0].killed).toBe(true)
      expect(result.phase).toBe('failed')
      expect(result.output).toContain('Timed out')
    } finally {
      vi.useRealTimers()
    }
  })

  it('fails for an agent with no login command', async () => {
    const { r, spawn } = runner()
    const result = await r.login('pi')
    expect(result.phase).toBe('failed')
    expect(spawn).not.toHaveBeenCalled()
  })

  it('fails with the command it tried when the shell cannot start', async () => {
    const { r } = runner({ spawn: () => { throw new Error('spawn ENOENT') } })
    const result = await r.login('codex')
    expect(result.phase).toBe('failed')
    expect(result.command).toBe('codex login')
    expect(result.output).toContain('spawn ENOENT')
  })
})
import { EventEmitter } from 'events'
import { readAuthStatus } from './agent-login'

function fakeChild(stdout: string, code: number, stderr = '') {
  const p: any = new EventEmitter()
  p.stdout = new EventEmitter()
  p.stderr = new EventEmitter()
  p.kill = vi.fn()
  queueMicrotask(() => { p.stdout.emit('data', Buffer.from(stdout)); p.stderr.emit('data', Buffer.from(stderr)); p.emit('close', code) })
  return p
}

describe('readAuthStatus', () => {
  const base = { shell: '/bin/zsh', env: { PATH: '/bin' } as NodeJS.ProcessEnv }

  it('asks the CLI through the login shell', async () => {
    const spawn = vi.fn(() => fakeChild('Logged in using ChatGPT\n', 0))
    expect(await readAuthStatus('codex', { ...base, spawn })).toBe('signed-in')
    expect(spawn).toHaveBeenCalledWith('/bin/zsh', ['-i', '-c', 'codex login status'], expect.anything())
  })
  it('reads the codex line from stderr, where codex really prints it', async () => {
    const spawn = vi.fn(() => fakeChild('', 1, 'Not logged in\n'))
    expect(await readAuthStatus('codex', { ...base, spawn })).toBe('signed-out')
  })
  it('reads signed out', async () => {
    const spawn = vi.fn(() => fakeChild('{"loggedIn": false}', 1))
    expect(await readAuthStatus('claude-code', { ...base, spawn })).toBe('signed-out')
  })
  it('ignores shell noise printed before the JSON', async () => {
    const spawn = vi.fn(() => fakeChild('nvm: loaded\n{\n  "loggedIn": true\n}\n', 0))
    expect(await readAuthStatus('claude-code', { ...base, spawn })).toBe('signed-in')
  })
  it('says api-key without running anything when a key is set', async () => {
    const spawn = vi.fn()
    expect(await readAuthStatus('codex', { ...base, spawn, env: { OPENAI_API_KEY: 'k' } })).toBe('api-key')
    expect(await readAuthStatus('codex', { ...base, spawn, modelHasApiKey: true })).toBe('api-key')
    expect(spawn).not.toHaveBeenCalled()
  })
  it('is unknown for an agent with no spec, or output it cannot read', async () => {
    expect(await readAuthStatus('pi', { ...base, spawn: vi.fn() })).toBe('unknown')
    expect(await readAuthStatus('codex', { ...base, spawn: vi.fn(() => fakeChild('zsh: command not found: codex', 127)) })).toBe('unknown')
  })
})
