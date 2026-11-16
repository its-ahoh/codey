import type { AgentRequest, AgentRunLease } from '@codey/core'

export interface ComputerApp { bundleId: string; name: string }
/** `all`: every installed application except Codey. `selected`: only the user's list.
 *  There is no setting for it: an empty list means all. */
export type ComputerScope = 'all' | 'selected'
export interface ComputerControlState {
  enabled: boolean
  scope: ComputerScope
  apps: ComputerApp[]
  available: boolean
  accessibility: boolean
  screenRecording: boolean
  active: null | { agent: string; chatId?: string; phase: 'waiting' | 'starting' | 'controlling' }
  queued: number
  desktop?: ComputerDesktop | null
}
export interface ComputerDriver {
  start(apps: ComputerApp[]): Promise<void>
  execute(command: ComputerCommand, validate?: () => void): Promise<ComputerReply>
  stop(): Promise<void>
}
export interface ComputerControlDeps {
  ready(): boolean
  approve(agent: string, apps: ComputerApp[], signal: AbortSignal, chatId?: string, scope?: ComputerScope): Promise<boolean>
  /** Every installed application; needed for the `all` scope. */
  installed?(): Promise<ComputerApp[]>
  driver(onExit: () => void): ComputerDriver
  changed(): void
}

export interface ComputerCommand { action: string; bundleId?: string; window?: string; args?: Record<string, unknown> }
export interface ComputerDesktop {
  sessionId: string; window: string; title: string; app: string
  controller: 'agent' | 'human'; transitioning: boolean; controlVersion: number
}
export interface ComputerTarget { pid: number; windowId: number; title: string; app: string; bundleId?: string }
export interface ComputerReply { target?: ComputerTarget; text?: string; windows?: { id: string; title: string; app: string }[]; images?: { mimeType: string; dataBase64: string }[]; data?: unknown; isError?: boolean }
export interface ComputerPreview { updatedAt: number; window?: string; reply: ComputerReply }
export type ComputerOrigin = 'agent' | 'human' | 'monitor'
export interface ComputerLease extends AgentRunLease {
  execute(command: ComputerCommand, origin?: ComputerOrigin, permitted?: () => boolean): Promise<ComputerReply>
  handoff(human: boolean): Promise<void>
}

const CODEY_BUNDLE_ID = 'com.codey.mac'
const bundleIdPattern = /^[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)+$/
const validName = (name: unknown): name is string =>
  typeof name === 'string' && !!name.trim() && name.length <= 128 && !/[\x00-\x1f]/.test(name)

/**
 * Turn whatever is installed into a grant list: unreadable or oddly named
 * bundles are dropped rather than failing the task, duplicates collapse, and
 * Codey itself is never included.
 */
export function allComputerApps(found: { bundleId: string; name: string }[]): ComputerApp[] {
  const seen = new Set<string>()
  const apps: ComputerApp[] = []
  for (const app of found) {
    if (typeof app?.bundleId !== 'string' || !bundleIdPattern.test(app.bundleId) || !validName(app.name)) continue
    const key = app.bundleId.toLowerCase()
    if (key === CODEY_BUNDLE_ID || seen.has(key)) continue
    seen.add(key)
    apps.push({ bundleId: app.bundleId, name: app.name.trim() })
  }
  return apps.sort((a, b) => a.name.localeCompare(b.name))
}

export function validateComputerApps(value: unknown, limit = 16): ComputerApp[] {
  if (!Array.isArray(value) || value.length > limit) throw new Error(`Select up to ${limit} applications`)
  const seen = new Set<string>()
  return value.map(app => {
    if (!app || typeof app.bundleId !== 'string' || !bundleIdPattern.test(app.bundleId) || !validName(app.name)) {
      throw new Error('Invalid application')
    }
    if (app.bundleId.toLowerCase() === CODEY_BUNDLE_ID) throw new Error('Codey cannot control its own authorization interface')
    if (seen.has(app.bundleId.toLowerCase())) throw new Error('Duplicate application')
    seen.add(app.bundleId.toLowerCase())
    return { bundleId: app.bundleId, name: app.name.trim() }
  })
}

export function computerManifest(apps: ComputerApp[]) {
  // The hand-picked list is short; an "all applications" grant is every installed app.
  const checked = validateComputerApps(apps, 5000)
  if (!checked.length) throw new Error('Select an application first')
  return {
    version: 3, expires_after: '2h', idle_timeout: '15m',
    allow: { tools: ['start_session', 'end_session', 'list_apps', 'list_windows', 'launch_app',
      'get_window_state', 'click', 'type_text', 'press_key', 'hotkey', 'scroll', 'drag', 'move_cursor'] },
    resources: {
      apps: checked.map(app => ({ bundle_id: app.bundleId, launch: true, windows: 'all' })),
      desktop: { display: false },
    },
  }
}

/** One desktop owner at a time. Each approved adapter run has its own bounded runtime. */
export class ComputerControl {
  enabled = false
  /** The hand-picked list. Empty means every installed application. */
  apps: ComputerApp[] = []
  active: ComputerControlState['active'] = null
  private tail: Promise<void> = Promise.resolve()
  private pending = new Set<AbortController>()
  private currentStop?: () => Promise<void>
  private closing = false
  constructor(private deps: ComputerControlDeps) {}
  get queued() { return Math.max(0, this.pending.size - (this.active ? 1 : 0)) }

  get scope(): ComputerScope { return this.apps.length ? 'selected' : 'all' }

  /** The applications a task started now would be offered. */
  async allowedApps(): Promise<ComputerApp[]> {
    if (this.scope === 'selected') return this.apps.map(app => ({ ...app }))
    if (!this.deps.installed) throw new Error('Listing installed applications is unavailable')
    return this.deps.installed()
  }

  async configure(enabled: boolean, apps: unknown): Promise<void> {
    const checked = validateComputerApps(apps)
    if (enabled && !this.deps.ready()) throw new Error('Grant Accessibility and Screen Recording first')
    this.enabled = false
    this.deps.changed()
    await this.stop()
    if (this.closing) throw new Error('Computer control is shutting down')
    this.apps = checked
    this.enabled = enabled
    this.deps.changed()
  }

  async stop(): Promise<void> {
    for (const controller of this.pending) controller.abort()
    await this.currentStop?.()
    this.deps.changed()
  }

  async shutdown(): Promise<void> {
    this.closing = true
    this.enabled = false
    await this.stop()
    await this.tail
  }

  async prepare(agent: string, request: AgentRequest): Promise<ComputerLease | undefined> {
    if (!this.enabled || this.closing || request.browserTools !== true ||
        !request.context?.workingDir || request.allowedTools) return undefined
    if (!this.deps.ready()) throw new Error('Computer control permissions are unavailable; check Tools > Plugins > Computer')
    // The grant is fixed when the task asks: later setting changes never widen it.
    const scope = this.scope
    const selected = this.apps.map(app => ({ ...app }))
    const controller = new AbortController()
    const cancel = () => controller.abort()
    if (request.signal?.aborted) cancel()
    request.signal?.addEventListener('abort', cancel, { once: true })
    this.pending.add(controller)
    const previous = this.tail
    let release!: () => void
    const released = new Promise<void>(resolve => { release = resolve })
    this.tail = previous.then(() => released)
    this.deps.changed()
    let driver: ComputerDriver | undefined
    let stopping: Promise<void> | undefined
    let disposed = false
    let owned = false
    const stopDriver = () => stopping ??= Promise.resolve().then(() => driver?.stop()).catch(error => {
      // Never hand the desktop to another bot after uncertain native teardown.
      this.enabled = false
      this.closing = true
      for (const pending of this.pending) pending.abort()
      throw error
    })
    const dispose = async () => {
      if (disposed) return
      disposed = true
      controller.abort()
      try { await stopDriver() } finally {
        request.signal?.removeEventListener('abort', cancel)
        controller.signal.removeEventListener('abort', onAbort)
        this.pending.delete(controller)
        if (owned) { this.active = null; this.currentStop = undefined }
        release()
        this.deps.changed()
      }
    }
    const onAbort = () => { void stopDriver().catch(() => {}) }
    try {
      await new Promise<void>((resolve, reject) => {
        const aborted = () => { cleanup(); reject(new Error('Computer request was cancelled')) }
        const cleanup = () => controller.signal.removeEventListener('abort', aborted)
        controller.signal.addEventListener('abort', aborted, { once: true })
        if (controller.signal.aborted) { aborted(); return }
        void previous.then(() => { cleanup(); resolve() }, error => { cleanup(); reject(error) })
      })
      controller.signal.throwIfAborted()
      owned = true
      this.active = { agent, chatId: request.browserChatId, phase: 'waiting' }
      this.currentStop = stopDriver
      this.deps.changed()
      const apps = scope === 'all' ? await this.allowedApps() : selected
      controller.signal.throwIfAborted()
      if (!apps.length) throw new Error('No applications were found on this Mac')
      const accepted = await this.deps.approve(agent, apps, controller.signal, request.browserChatId, scope)
      controller.signal.throwIfAborted()
      if (!accepted) throw new Error('Computer control was declined. The coding task can continue without computer control.')
      if (!this.deps.ready()) throw new Error('Computer control permissions were revoked')
      driver = this.deps.driver(() => controller.abort())
      controller.signal.addEventListener('abort', onAbort, { once: true })
      this.active.phase = 'starting'
      this.deps.changed()
      await driver.start(apps)
      controller.signal.throwIfAborted()
      this.active.phase = 'controlling'
      this.deps.changed()
      let calls: Promise<unknown> = Promise.resolve()
      let human = false
      let generation = 0
      return {
        request: { ...request, signal: controller.signal }, dispose,
        async handoff(nextHuman) {
          human = nextHuman
          generation++
          const barrier = calls.then(async () => {
            controller.signal.throwIfAborted()
            await driver!.execute({ action: 'invalidate' })
          })
          calls = barrier.catch(() => {})
          await barrier
        },
        execute: (command, origin = 'agent', permitted = () => true) => {
          const submittedGeneration = generation
          const validate = (delivered = false) => {
            controller.signal.throwIfAborted()
            if (origin !== 'monitor' && submittedGeneration !== generation) throw new Error('Control changed; observe again before continuing')
            if (origin === 'agent' && human) throw new Error('The user paused computer control. Wait until they resume it, then observe again.')
            if (origin === 'human' && !human) throw new Error('Take control before sending input')
            // Once the driver has delivered the input, a stream that ended
            // meanwhile must not relabel it as cancelled.
            if (!delivered && !permitted()) throw new Error('The request was abandoned before it was delivered')
            if (!this.deps.ready()) throw new Error('Computer control permissions were revoked')
          }
          const result = calls.then(async () => {
            validate()
            const reply = await driver!.execute(command, validate)
            validate(true)
            return reply
          })
          calls = result.catch(() => {})
          return result
        },
      }
    } catch (error) {
      await dispose()
      throw error
    }
  }
}
