/**
 * Signing an agent CLI in from inside Codey.
 *
 * Codey runs the command the user would type (`claude auth login`,
 * `codex login`) and nothing else: no login protocol of its own, and it never
 * reads, stores or moves a token. The browser page opens exactly as it does
 * from a terminal.
 *
 * Same shell as agent-update.ts (`$SHELL -i -c`), so PATH matches the install
 * probe. It runs in a PTY because a login may prompt, or print a link or a
 * code when it cannot open the browser.
 */
import { AGENT_AUTH } from '@codey/core'
import type { PtyLike, PtySpawn } from './terminal-sessions'
import { tailOutput } from './agent-update'
import type { SpawnLike } from './agent-detect'

export type LoginPhase = 'starting' | 'waiting' | 'succeeded' | 'failed' | 'cancelled'

export interface LoginProgress {
  agent: string
  phase: LoginPhase
  /** The command that was run, so a failure can name it. */
  command: string
  /** A sign-in page the CLI printed, for an "Open page" link. */
  url?: string
  /** Tail of the output; only on `failed`. */
  output?: string
}

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*(\u0007|\u001b\\)/g

/** The first https link in terminal output, with colour codes removed. */
export function firstUrl(text: string): string | undefined {
  return text.replace(ANSI, '').match(/https:\/\/[^\s"'<>]+/)?.[0]
}

/** The login command for an agent, or undefined when it has none of its own. */
export function loginCommandFor(agent: string): string | undefined {
  return (AGENT_AUTH as Record<string, { loginCommand: string } | undefined>)[agent]?.loginCommand
}

interface Run { pty: PtyLike; promise: Promise<LoginProgress>; cancelled: boolean }

export class AgentLoginRunner {
  private readonly runs = new Map<string, Run>()

  constructor(private readonly deps: {
    spawn: PtySpawn
    shell: () => string
    /** Process env plus this agent's env settings (CLAUDE_CONFIG_DIR, CODEX_HOME). */
    env: (agent: string) => NodeJS.ProcessEnv
    cwd: () => string
    /** Re-run the status command: true = signed in. */
    checkSignedIn: (agent: string) => Promise<boolean | null>
    emit: (progress: LoginProgress) => void
    timeoutMs?: number
  }) {}

  isRunning(agent: string): boolean {
    return this.runs.has(agent)
  }

  /** At most one login per agent: a second request joins the first. */
  login(agent: string): Promise<LoginProgress> {
    const existing = this.runs.get(agent)
    if (existing) return existing.promise

    const command = loginCommandFor(agent)
    const report = (p: LoginProgress) => { this.deps.emit(p); return p }
    if (!command) {
      return Promise.resolve(report({ agent, phase: 'failed', command: '', output: `${agent} has no sign-in command Codey can run.` }))
    }

    let pty: PtyLike
    try {
      const env = Object.fromEntries(
        Object.entries({ ...this.deps.env(agent), TERM: 'xterm-256color' })
          .filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
      )
      pty = this.deps.spawn(this.deps.shell(), ['-i', '-c', command], { name: 'xterm-256color', cols: 100, rows: 30, cwd: this.deps.cwd(), env })
    } catch (err) {
      return Promise.resolve(report({ agent, phase: 'failed', command, output: (err as Error).message }))
    }

    const run: Run = { pty, cancelled: false, promise: undefined as unknown as Promise<LoginProgress> }
    const timeoutMs = this.deps.timeoutMs ?? 300_000
    report({ agent, phase: 'starting', command })

    run.promise = new Promise<LoginProgress>(resolve => {
      let buf = ''
      let url: string | undefined
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        try { pty.kill() } catch { /* already gone */ }
      }, timeoutMs)

      pty.onData(data => {
        buf = (buf + data).slice(-20_000)
        if (!url) {
          url = firstUrl(buf)
          if (url) report({ agent, phase: 'waiting', command, url })
        }
      })
      pty.onExit(async () => {
        clearTimeout(timer)
        this.runs.delete(agent)
        if (run.cancelled) return resolve(report({ agent, phase: 'cancelled', command }))
        // The exit code is not the answer: a login can exit 0 after being
        // declined in the browser. The CLI's own status is.
        const signedIn = timedOut ? false : await this.deps.checkSignedIn(agent).catch(() => null)
        if (signedIn) return resolve(report({ agent, phase: 'succeeded', command }))
        const text = buf.replace(ANSI, '')
        const output = tailOutput(timedOut ? `${text}\nTimed out after ${Math.round(timeoutMs / 1000)}s.` : text, 1200)
        resolve(report({ agent, phase: 'failed', command, output }))
      })
    })
    this.runs.set(agent, run)
    return run.promise
  }

  cancel(agent: string): void {
    const run = this.runs.get(agent)
    if (!run) return
    run.cancelled = true
    try { run.pty.kill() } catch { /* already gone */ }
  }

  /** App is quitting: no login may outlive it. */
  cancelAll(): void {
    for (const agent of [...this.runs.keys()]) this.cancel(agent)
  }
}

export type AuthStatus = 'signed-in' | 'signed-out' | 'api-key' | 'unknown'

/**
 * What Settings shows for one agent. Runs the CLI's status command in the
 * login shell. Only the yes/no is kept: the output holds the account email.
 */
export async function readAuthStatus(agent: string, opts: {
  spawn: SpawnLike
  shell: string
  env: NodeJS.ProcessEnv
  /** The agent's default model is bound to an API key. */
  modelHasApiKey?: boolean
  timeoutMs?: number
}): Promise<AuthStatus> {
  const spec = (AGENT_AUTH as Record<string, typeof AGENT_AUTH['codex']>)[agent]
  if (!spec) return 'unknown'
  if (opts.modelHasApiKey || !spec.usesOwnLogin(opts.env)) return 'api-key'

  const command = `${spec.loginCommand.split(' ')[0]} ${spec.statusCommand.join(' ')}`
  const result = await new Promise<{ stdout: string; stderr: string; code: number | null } | null>(resolve => {
    let buf = ''
    let err = ''
    let done = false
    const finish = (v: { stdout: string; stderr: string; code: number | null } | null) => { if (!done) { done = true; clearTimeout(timer); resolve(v) } }
    const p = opts.spawn(opts.shell, ['-i', '-c', command], { stdio: ['ignore', 'pipe', 'pipe'], env: opts.env })
    const timer = setTimeout(() => { try { p.kill() } catch { /* already gone */ } finish(null) }, opts.timeoutMs ?? 15_000)
    p.stdout?.on('data', (d: Buffer) => { buf += d.toString() })
    // codex prints its status line on stderr.
    p.stderr?.on('data', (d: Buffer) => { err += d.toString() })
    p.on('close', (code: number) => finish({ stdout: buf, stderr: err, code }))
    p.on('error', () => finish(null))
  })
  if (!result) return 'unknown'
  // An interactive shell may print its own lines first; the JSON starts at the first brace.
  const brace = result.stdout.indexOf('{')
  const signedIn = spec.parseStatus(brace >= 0 ? result.stdout.slice(brace) : result.stdout, result.code)
    ?? spec.parseStatus(result.stdout, result.code)
    ?? spec.parseStatus(result.stderr, result.code)
  return signedIn === true ? 'signed-in' : signedIn === false ? 'signed-out' : 'unknown'
}
