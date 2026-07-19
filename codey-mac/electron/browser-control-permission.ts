import * as fs from 'fs'
import * as path from 'path'

export interface BrowserControlRequest {
  command: string
  url: string
}

export interface BrowserControlPermissionState {
  approved: boolean
  pending: BrowserControlRequest | null
}

/** Persistent, user-approved gate for mutating browser agent commands. */
export class BrowserControlPermissionGate {
  private approved = false
  private pending: BrowserControlRequest | null = null
  private waiters: Array<(approved: boolean) => void> = []

  constructor(
    private readonly filePath: string,
    private readonly onChange: (state: BrowserControlPermissionState) => void,
  ) {
    this.approved = this.readApproval()
  }

  getState(): BrowserControlPermissionState {
    return { approved: this.approved, pending: this.pending ? { ...this.pending } : null }
  }

  async request(request: BrowserControlRequest): Promise<boolean> {
    if (this.approved) return true
    if (!this.pending) {
      this.pending = { ...request }
      this.emit()
    }
    return await new Promise<boolean>(resolve => this.waiters.push(resolve))
  }

  approve(): BrowserControlPermissionState {
    this.approved = true
    this.persist()
    this.finishPending(true)
    return this.getState()
  }

  deny(): BrowserControlPermissionState {
    this.finishPending(false)
    return this.getState()
  }

  revoke(): BrowserControlPermissionState {
    this.approved = false
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

  private readApproval(): boolean {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'))
      return parsed?.agentControlApproved === true
    } catch {
      return false
    }
  }

  private persist(): void {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
      fs.writeFileSync(this.filePath, JSON.stringify({ agentControlApproved: this.approved }, null, 2), {
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
