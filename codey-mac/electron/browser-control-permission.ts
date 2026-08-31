import * as fs from 'fs'
import * as path from 'path'

/** Which browser a request is about. Codey's own sandboxed browser and the
 *  user's real Chrome carry very different stakes - Chrome holds their live
 *  logins - so they are approved separately and never imply each other. */
export type BrowserControlSurface = 'browser' | 'chrome'

/** How far a command reaches.
 *  - `write` adds or changes something (click, fill, upload, submit).
 *  - `full` also destroys or replaces state that cannot be typed back in
 *    (deleting a saved profile, swapping the live session's cookies). */
export type BrowserControlLevel = 'write' | 'full'

/** What the user has granted for one surface, `none` meaning view-only. */
export type BrowserControlGrant = 'none' | BrowserControlLevel

const GRANT_RANK: Record<BrowserControlGrant, number> = { none: 0, write: 1, full: 2 }

/** Commands that reach past "add or change" and so need `full`. Everything
 *  else that mutates is `write`; reads are never gated at all. */
const FULL_ACCESS_COMMANDS = new Set(['delete-profile', 'activate-profile'])

export function levelForCommand(command: string): BrowserControlLevel {
  return FULL_ACCESS_COMMANDS.has(command) ? 'full' : 'write'
}

export interface BrowserControlRequest {
  command: string
  url: string
  surface: BrowserControlSurface
  level: BrowserControlLevel
}

export interface BrowserControlPermissionState {
  granted: Record<BrowserControlSurface, BrowserControlGrant>
  pending: BrowserControlRequest | null
}

/** Persistent, user-approved gate for mutating browser agent commands. */
export class BrowserControlPermissionGate {
  private granted: Record<BrowserControlSurface, BrowserControlGrant> = { browser: 'none', chrome: 'none' }
  private pending: BrowserControlRequest | null = null
  private waiters: Array<(approved: boolean) => void> = []

  constructor(
    private readonly filePath: string,
    private readonly onChange: (state: BrowserControlPermissionState) => void,
  ) {
    this.granted = this.readApproval()
  }

  getState(): BrowserControlPermissionState {
    return { granted: { ...this.granted }, pending: this.pending ? { ...this.pending } : null }
  }

  async request(request: BrowserControlRequest): Promise<boolean> {
    if (GRANT_RANK[this.granted[request.surface]] >= GRANT_RANK[request.level]) return true
    if (!this.pending) {
      this.pending = { ...request }
      this.emit()
    }
    return await new Promise<boolean>(resolve => this.waiters.push(resolve))
  }

  /** Grant `level` on the pending request's surface and let it through.
   *  Approving `write` for a command that needs `full` would not actually
   *  unblock it, so the grant is raised to whatever the request asked for. */
  approve(level: BrowserControlLevel): BrowserControlPermissionState {
    const pending = this.pending
    if (!pending) return this.getState()
    const effective = GRANT_RANK[level] >= GRANT_RANK[pending.level] ? level : pending.level
    if (GRANT_RANK[effective] > GRANT_RANK[this.granted[pending.surface]]) {
      this.granted[pending.surface] = effective
      this.persist()
    }
    this.finishPending(true)
    return this.getState()
  }

  deny(): BrowserControlPermissionState {
    this.finishPending(false)
    return this.getState()
  }

  revoke(surface?: BrowserControlSurface): BrowserControlPermissionState {
    for (const key of surface ? [surface] : (['browser', 'chrome'] as BrowserControlSurface[])) {
      this.granted[key] = 'none'
    }
    this.persist()
    this.finishPending(false)
    return this.getState()
  }

  dispose(): void {
    this.finishPending(false)
  }

  private finishPending(approved: boolean): void {
    const waiters = this.waiters.splice(0)
    this.pending = null
    this.emit()
    for (const resolve of waiters) resolve(approved)
  }

  private emit(): void {
    this.onChange(this.getState())
  }

  private readApproval(): Record<BrowserControlSurface, BrowserControlGrant> {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'))
      // The old format was a single blanket boolean covering the embedded
      // browser; real Chrome had no gate of its own yet. Carrying it over as
      // Chrome access would grant something the user was never asked about.
      if (parsed?.agentControlApproved === true && !parsed?.agentControl) {
        return { browser: 'full', chrome: 'none' }
      }
      const stored = parsed?.agentControl
      const read = (value: unknown): BrowserControlGrant =>
        value === 'write' || value === 'full' ? value : 'none'
      return { browser: read(stored?.browser), chrome: read(stored?.chrome) }
    } catch {
      return { browser: 'none', chrome: 'none' }
    }
  }

  private persist(): void {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
      fs.writeFileSync(this.filePath, JSON.stringify({ agentControl: this.granted }, null, 2), {
        encoding: 'utf8',
        mode: 0o600,
      })
      fs.chmodSync(this.filePath, 0o600)
    } catch {
      // Permission still applies for the current app session; a future launch
      // will safely fall back to view-only if persistence was unavailable.
    }
  }
}
