import * as fs from 'fs'
import * as path from 'path'

/** What an agent is about to do in a terminal, shown in the approval prompt. */
export interface TerminalControlRequest {
  chatId: string
  sessionId?: string
  /** `run`, `send` or `close`. */
  command: string
  /** The command line or keys about to be typed, for the user to read. */
  preview: string
}

export interface TerminalControlPermissionState {
  /** True once the user chose "Always allow". */
  always: boolean
  /** The request waiting at the front of the queue, if any. */
  pending: TerminalControlRequest | null
}

interface Waiter {
  request: TerminalControlRequest
  resolve: (approved: boolean) => void
}

const PREVIEW_LIMIT = 400

/**
 * The user's say over agents typing into a terminal. Unlike the browser gate,
 * each request is answered on its own: "Allow once" lets exactly the command
 * shown through, because the next one may be something quite different.
 * "Always allow" is remembered across launches until revoked.
 */
export class TerminalControlPermissionGate {
  private always = false
  private queue: Waiter[] = []

  constructor(
    private readonly filePath: string,
    private readonly onChange: (state: TerminalControlPermissionState) => void,
  ) {
    this.always = this.readApproval()
  }

  getState(): TerminalControlPermissionState {
    const head = this.queue[0]?.request
    return { always: this.always, pending: head ? { ...head } : null }
  }

  async request(request: TerminalControlRequest): Promise<boolean> {
    if (this.always) return true
    const preview = request.preview.length > PREVIEW_LIMIT
      ? `${request.preview.slice(0, PREVIEW_LIMIT)}...`
      : request.preview
    return await new Promise<boolean>(resolve => {
      this.queue.push({ request: { ...request, preview }, resolve })
      if (this.queue.length === 1) this.emit()
    })
  }

  /** `once` lets the shown request through; `always` lets it and every
   *  queued and future request through. */
  approve(scope: 'once' | 'always'): TerminalControlPermissionState {
    if (scope === 'always') {
      this.always = true
      this.persist()
      this.finish(this.queue.splice(0), true)
    } else {
      this.finish(this.queue.splice(0, 1), true)
    }
    return this.getState()
  }

  deny(): TerminalControlPermissionState {
    this.finish(this.queue.splice(0, 1), false)
    return this.getState()
  }

  revoke(): TerminalControlPermissionState {
    this.always = false
    this.persist()
    this.emit()
    return this.getState()
  }

  dispose(): void {
    this.finish(this.queue.splice(0), false)
  }

  private finish(done: Waiter[], approved: boolean): void {
    if (done.length === 0) return
    this.emit()
    for (const waiter of done) waiter.resolve(approved)
  }

  private emit(): void {
    this.onChange(this.getState())
  }

  private readApproval(): boolean {
    try {
      return JSON.parse(fs.readFileSync(this.filePath, 'utf8'))?.always === true
    } catch {
      return false
    }
  }

  private persist(): void {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
      fs.writeFileSync(this.filePath, JSON.stringify({ always: this.always }, null, 2), { encoding: 'utf8', mode: 0o600 })
      fs.chmodSync(this.filePath, 0o600)
    } catch {
      // Still applies for this session; a later launch falls back to asking.
    }
  }
}
