import * as fs from 'fs'
import * as path from 'path'

export type BrowserSitePermission = 'camera' | 'microphone' | 'geolocation' | 'notifications'
export type BrowserSitePermissionDecision = 'allow' | 'block'

export interface BrowserSitePermissionDetails {
  requestingUrl?: string
  securityOrigin?: string
  mediaType?: 'video' | 'audio' | 'unknown'
  mediaTypes?: Array<'video' | 'audio'>
}

export interface BrowserSitePermissionRequest {
  id: string
  origin: string
  hostname: string
  permissions: BrowserSitePermission[]
}

export interface BrowserSitePermissionState {
  pending: BrowserSitePermissionRequest | null
  savedSiteCount: number
}

interface PendingRequest {
  request: BrowserSitePermissionRequest
  resolve: (allowed: boolean) => void
  timer: NodeJS.Timeout | null
}

type DecisionMap = Record<string, Partial<Record<BrowserSitePermission, BrowserSitePermissionDecision>>>

const SUPPORTED_PERMISSIONS = new Set<BrowserSitePermission>([
  'camera', 'microphone', 'geolocation', 'notifications',
])

function originFrom(value: string | undefined): string | null {
  if (!value) return null
  try {
    const url = new URL(value)
    const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]'
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) return null
    return url.origin
  } catch {
    return null
  }
}

export function browserSitePermissionsFor(
  permission: string,
  details: BrowserSitePermissionDetails = {},
): BrowserSitePermission[] {
  if (permission === 'geolocation' || permission === 'notifications') {
    return [permission]
  }
  if (permission !== 'media') return []

  const mediaTypes = details.mediaTypes?.length
    ? details.mediaTypes
    : details.mediaType && details.mediaType !== 'unknown'
      ? [details.mediaType]
      : ['video', 'audio'] as const
  const translated: BrowserSitePermission[] = mediaTypes.map(type => type === 'video' ? 'camera' : 'microphone')
  return [...new Set(translated)]
}

/** Persistent, per-origin permission gate for privacy-sensitive website APIs. */
export class BrowserSitePermissionManager {
  private saved: DecisionMap
  private session: DecisionMap = {}
  private current: PendingRequest | null = null
  private queue: PendingRequest[] = []
  private sequence = 0

  constructor(
    private readonly filePath: string,
    private readonly onChange: (state: BrowserSitePermissionState) => void,
    private readonly requestTimeoutMs = 2 * 60 * 1000,
  ) {
    this.saved = this.readSaved()
  }

  getState(): BrowserSitePermissionState {
    return {
      pending: this.current ? { ...this.current.request, permissions: [...this.current.request.permissions] } : null,
      savedSiteCount: Object.keys(this.saved).length,
    }
  }

  check(permission: string, requestingOrigin: string, details: BrowserSitePermissionDetails = {}): boolean {
    const permissions = browserSitePermissionsFor(permission, details)
    const origin = this.resolveOrigin(requestingOrigin, details)
    if (!origin || permissions.length === 0) return false
    return permissions.every(item => this.decision(origin, item) === 'allow')
  }

  async request(permission: string, requestingOrigin: string, details: BrowserSitePermissionDetails = {}): Promise<boolean> {
    const permissions = browserSitePermissionsFor(permission, details)
    const origin = this.resolveOrigin(requestingOrigin, details)
    if (!origin || permissions.length === 0) return false

    const decisions = permissions.map(item => this.decision(origin, item))
    if (decisions.some(decision => decision === 'block')) return false
    if (decisions.every(decision => decision === 'allow')) return true

    return await new Promise<boolean>(resolve => {
      const request: BrowserSitePermissionRequest = {
        id: `site-permission-${process.pid}-${++this.sequence}`,
        origin,
        hostname: new URL(origin).hostname,
        permissions,
      }
      const pending = {
        request,
        resolve,
        timer: null,
      }
      this.queue.push(pending)
      this.advance()
    })
  }

  allowForSession(id: string): BrowserSitePermissionState {
    return this.respond(id, 'allow', false)
  }

  alwaysAllow(id: string): BrowserSitePermissionState {
    return this.respond(id, 'allow', true)
  }

  block(id: string): BrowserSitePermissionState {
    return this.respond(id, 'block', true)
  }

  clear(): BrowserSitePermissionState {
    this.saved = {}
    this.session = {}
    this.persist()
    this.finishAll(false)
    this.emit()
    return this.getState()
  }

  dispose(): void {
    this.finishAll(false)
  }

  private respond(
    id: string,
    decision: BrowserSitePermissionDecision,
    persist: boolean,
  ): BrowserSitePermissionState {
    const pending = this.current
    if (!pending || pending.request.id !== id) return this.getState()
    const target = persist ? this.saved : this.session
    target[pending.request.origin] ??= {}
    for (const permission of pending.request.permissions) {
      target[pending.request.origin][permission] = decision
    }
    if (persist) this.persist()
    this.finish(id, decision === 'allow')
    return this.getState()
  }

  private decision(origin: string, permission: BrowserSitePermission): BrowserSitePermissionDecision | undefined {
    return this.session[origin]?.[permission] ?? this.saved[origin]?.[permission]
  }

  private resolveOrigin(requestingOrigin: string, details: BrowserSitePermissionDetails): string | null {
    return originFrom(details.securityOrigin)
      ?? originFrom(requestingOrigin)
      ?? originFrom(details.requestingUrl)
  }

  private advance(): void {
    if (this.current || this.queue.length === 0) return
    this.current = this.queue.shift()!
    const id = this.current.request.id
    this.current.timer = setTimeout(() => this.finish(id, false), this.requestTimeoutMs)
    this.emit()
  }

  private finish(id: string, allowed: boolean): void {
    if (this.current?.request.id !== id) return
    const pending = this.current
    this.current = null
    if (pending.timer) clearTimeout(pending.timer)
    pending.resolve(allowed)
    this.emit()
    this.advance()
  }

  private finishAll(allowed: boolean): void {
    const requests = [this.current, ...this.queue].filter((item): item is PendingRequest => !!item)
    this.current = null
    this.queue = []
    for (const pending of requests) {
      if (pending.timer) clearTimeout(pending.timer)
      pending.resolve(allowed)
    }
  }

  private emit(): void {
    this.onChange(this.getState())
  }

  private readSaved(): DecisionMap {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'))
      const source = parsed?.decisions
      if (!source || typeof source !== 'object' || Array.isArray(source)) return {}
      const result: DecisionMap = {}
      for (const [origin, raw] of Object.entries(source as Record<string, unknown>)) {
        if (!originFrom(origin) || !raw || typeof raw !== 'object' || Array.isArray(raw)) continue
        const decisions: Partial<Record<BrowserSitePermission, BrowserSitePermissionDecision>> = {}
        for (const permission of SUPPORTED_PERMISSIONS) {
          const value = (raw as Record<string, unknown>)[permission]
          if (value === 'allow' || value === 'block') decisions[permission] = value
        }
        if (Object.keys(decisions).length > 0) result[origin] = decisions
      }
      return result
    } catch {
      return {}
    }
  }

  private persist(): void {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
      fs.writeFileSync(this.filePath, JSON.stringify({ version: 1, decisions: this.saved }, null, 2), {
        encoding: 'utf8',
        mode: 0o600,
      })
      fs.chmodSync(this.filePath, 0o600)
    } catch {
      // The in-memory decision remains valid for this app session. A future
      // launch safely asks again if persistence is unavailable.
    }
  }
}
