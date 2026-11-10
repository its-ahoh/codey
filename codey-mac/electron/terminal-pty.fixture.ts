import type { PtyLike, PtySpawn } from './terminal-sessions'

/**
 * A pretend shell for tests. It echoes what is typed and, on Enter, answers
 * with whatever `respond` returns for the typed line. `busy` stands in for
 * "a program holds the terminal" so tests can drive the prompt detection.
 */
export class FakePty implements PtyLike {
  static count = 0
  pid = 1000 + ++FakePty.count
  written: string[] = []
  busy = false
  /** Free for a test's pretend program to remember what it is doing. */
  mode = ''
  killed = false
  private line = ''
  private dataListeners: Array<(data: string) => void> = []
  private exitListeners: Array<(event: { exitCode: number }) => void> = []

  constructor(private readonly respond: (line: string, pty: FakePty) => void = () => {}) {}

  onData(listener: (data: string) => void) { this.dataListeners.push(listener) }
  onExit(listener: (event: { exitCode: number }) => void) { this.exitListeners.push(listener) }
  resize() {}
  kill() { this.killed = true }

  emit(data: string) { for (const listener of this.dataListeners) listener(data) }
  exit(code = 0) { for (const listener of this.exitListeners) listener({ exitCode: code }) }

  write(data: string) {
    this.written.push(data)
    for (const ch of data) {
      if (ch === '\r') {
        const line = this.line
        this.line = ''
        this.emit('\r\n')
        this.respond(line, this)
      } else if (ch === '\x03') {
        this.busy = false
        this.emit('^C\r\n$ ')
      } else {
        this.line += ch
        this.emit(ch)
      }
    }
  }
}

export function fakeSpawn(respond?: (line: string, pty: FakePty) => void, startup = '$ ') {
  const spawned: FakePty[] = []
  const spawn: PtySpawn = () => {
    const pty = new FakePty(respond)
    spawned.push(pty)
    if (startup) setTimeout(() => pty.emit(startup), 5)
    return pty
  }
  return { spawn, spawned }
}
