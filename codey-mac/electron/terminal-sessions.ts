import { randomUUID } from 'crypto'
import * as fs from 'fs'

/** The slice of a node-pty process the manager uses, so tests can fake it. */
export interface PtyLike {
  pid: number
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(): void
  onData(listener: (data: string) => void): unknown
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): unknown
}

export type PtySpawn = (
  shell: string,
  args: string[],
  options: { name: string; cols: number; rows: number; cwd: string; env: Record<string, string> },
) => PtyLike

export interface TerminalSession {
  id: string
  chatId: string
  cwd: string
  process: PtyLike
  /** The most recent output, kept so a reopened panel can replay it. */
  output: string
  /** Every byte ever written, counted, so a reader can ask for "what came
   *  after offset N" even after the replay buffer dropped the start. */
  written: number
  alive: boolean
  /** True for a tab an agent opened through the Terminal plugin. */
  agent: boolean
}

export interface OpenedTerminal {
  sessionId: string
  chatId: string
  cwd: string
  pid: number
  output: string
  alive: boolean
}

export interface TerminalSessionEvents {
  data(event: { sessionId: string; chatId: string; data: string }): void
  exit(event: { sessionId: string; chatId: string; exitCode: number; signal?: number }): void
}

export const TERMINAL_REPLAY_LIMIT = 200_000

/**
 * Owns every Terminal panel shell. The panel (through IPC) and agents
 * (through the Terminal bridge) open, type into and close the same sessions,
 * so what an agent runs is exactly what the user sees.
 */
export class TerminalSessionManager {
  private readonly sessions = new Map<string, TerminalSession>()
  private readonly dataListeners = new Set<(session: TerminalSession, data: string) => void>()
  private readonly exitListeners = new Set<(session: TerminalSession) => void>()

  constructor(
    private readonly spawn: PtySpawn,
    private readonly events: TerminalSessionEvents,
    private readonly shell: () => string = () => process.env.SHELL || '/bin/zsh',
    private readonly baseEnv: () => NodeJS.ProcessEnv = () => process.env,
  ) {}

  get(sessionId: string): TerminalSession | undefined {
    return this.sessions.get(sessionId)
  }

  list(chatId: string): TerminalSession[] {
    return [...this.sessions.values()].filter(session => session.chatId === chatId)
  }

  ids(): string[] {
    return [...this.sessions.keys()]
  }

  async open(
    chatId: string,
    cwd: string,
    cols: number,
    rows: number,
    requestedId?: string,
    { agent = false }: { agent?: boolean } = {},
  ): Promise<OpenedTerminal> {
    if (!chatId || typeof chatId !== 'string') throw new Error('A chat is required to open a terminal')
    if (!cwd || typeof cwd !== 'string') throw new Error('A workspace directory is required to open a terminal')
    const stat = await fs.promises.stat(cwd)
    if (!stat.isDirectory()) throw new Error('Terminal working directory is not a directory')

    const sessionId = requestedId || randomUUID()
    const existing = this.sessions.get(sessionId)
    if (existing?.alive && existing.chatId === chatId && existing.cwd === cwd) {
      try { existing.process.resize(Math.max(2, cols), Math.max(1, rows)) } catch { /* resize is best effort */ }
      return { sessionId, chatId, cwd, pid: existing.process.pid, output: existing.output, alive: true }
    }
    if (existing) this.close(sessionId)

    const env = Object.fromEntries(
      Object.entries({ ...this.baseEnv(), TERM: 'xterm-256color', COLORTERM: 'truecolor' })
        .filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
    )
    const pty = this.spawn(this.shell(), ['-l'], {
      name: 'xterm-256color',
      cols: Math.max(2, cols),
      rows: Math.max(1, rows),
      cwd,
      env,
    })
    const session: TerminalSession = {
      id: sessionId, chatId, cwd, process: pty, output: '', written: 0, alive: true, agent,
    }
    this.sessions.set(sessionId, session)

    pty.onData(data => {
      if (this.sessions.get(sessionId) !== session) return
      session.output = (session.output + data).slice(-TERMINAL_REPLAY_LIMIT)
      session.written += data.length
      this.events.data({ sessionId, chatId, data })
      for (const listener of this.dataListeners) listener(session, data)
    })
    pty.onExit(({ exitCode, signal }) => {
      if (this.sessions.get(sessionId) !== session) return
      session.alive = false
      this.events.exit({ sessionId, chatId, exitCode, signal })
      for (const listener of this.exitListeners) listener(session)
    })

    return { sessionId, chatId, cwd, pid: pty.pid, output: '', alive: true }
  }

  write(sessionId: string, data: string): void {
    const session = this.sessions.get(sessionId)
    if (!session?.alive) throw new Error('Terminal session is not running')
    if (typeof data !== 'string' || data.length > 65_536) throw new Error('Invalid terminal input')
    session.process.write(data)
  }

  resize(sessionId: string, cols: number, rows: number): void {
    const session = this.sessions.get(sessionId)
    if (!session?.alive) return
    session.process.resize(Math.max(2, Math.min(500, cols)), Math.max(1, Math.min(300, rows)))
  }

  close(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    this.sessions.delete(sessionId)
    const wasAlive = session.alive
    session.alive = false
    try { session.process.kill() } catch { /* already exited */ }
    if (wasAlive) for (const listener of this.exitListeners) listener(session)
  }

  closeAll(): void {
    for (const sessionId of this.ids()) this.close(sessionId)
  }

  /** Output written after byte `offset`, as far as the replay buffer still
   *  holds it. `lost` is true when the start was already dropped. */
  outputSince(session: TerminalSession, offset: number): { text: string; lost: boolean } {
    const bufferStart = session.written - session.output.length
    if (offset >= session.written) return { text: '', lost: false }
    if (offset < bufferStart) return { text: session.output, lost: true }
    return { text: session.output.slice(offset - bufferStart), lost: false }
  }

  onData(listener: (session: TerminalSession, data: string) => void): () => void {
    this.dataListeners.add(listener)
    return () => { this.dataListeners.delete(listener) }
  }

  onExit(listener: (session: TerminalSession) => void): () => void {
    this.exitListeners.add(listener)
    return () => { this.exitListeners.delete(listener) }
  }
}
