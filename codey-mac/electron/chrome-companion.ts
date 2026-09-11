import * as crypto from 'crypto'
import * as fs from 'fs'
import * as http from 'http'
import * as path from 'path'

const DEFAULT_PORT = 49321
const PORT_SCAN_SIZE = 10
const CONNECTED_TTL_MS = 45_000
// The extension's service worker only guarantees a poll within its 30s alarm
// cycle when it has gone idle, so a command issued to a sleeping worker can sit
// unclaimed for most of that cycle before it is even seen. A 20s ceiling used
// to time out those cold-start commands ("List sites" did nothing); the ceiling
// has to clear one whole alarm cycle plus a round trip.
const COMMAND_TIMEOUT_MS = 40_000
// Opening pages just to read their storage is the one command that legitimately
// takes longer than a round trip: it waits on real navigations in the user's
// Chrome. The extension caps its own pass below this.
const STORAGE_VISIT_TIMEOUT_MS = 60_000
const MAX_BODY_BYTES = 15 * 1024 * 1024
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024
export const CHROME_COMPANION_EXTENSION_ID = 'nkfblackdfiplaekehijkgimhmlhlfib'
const CHROME_COMPANION_ORIGIN = `chrome-extension://${CHROME_COMPANION_EXTENSION_ID}`

export interface ChromeCompanionStatus {
  endpoint: string | null
  paired: boolean
  connected: boolean
  clientName: string | null
  pairedAt: number | null
  lastSeenAt: number | null
  /** Version of the extension Chrome is actually running, once it has polled. */
  clientVersion: string | null
  /** Version Codey has staged on disk for it. */
  expectedVersion: string | null
  /** Chrome is running an older build than the one already staged on disk. */
  updateAvailable: boolean
}

/** One paired Chrome profile. The extension's `chrome.storage.local` is scoped
 *  to a Chrome profile, so `profileId` is stable per profile and unique across
 *  them. `null` is a pairing made by an extension too old to report one; it
 *  keeps working until that extension reconnects with an ID. */
export interface ChromeClientInfo {
  profileId: string | null
  /** Codey-assigned display name ("Chrome profile 1"), renameable by the user. */
  label: string
  /** What the extension called itself, e.g. "Chrome 140.0.1234.56". */
  clientName: string
  clientVersion: string | null
  pairedAt: number
  lastSeenAt: number | null
  connected: boolean
}

export interface ChromeTabInfo {
  id: number
  windowId: number
  title: string
  url: string
  favIconUrl?: string
}

export interface ChromePageSnapshot {
  tab: ChromeTabInfo
  text: string
  links: Array<{ ref: string; text: string; href: string }>
  forms: Array<{ ref: string; tag: string; type: string; name: string; placeholder: string; label: string }>
}

/** What a page action touched, so a caller never has to assume it landed. */
export interface ChromePageAction {
  tab: ChromeTabInfo
  element: { tag: string; text: string }
}

export type ChromePageActionName = 'click' | 'fill' | 'select' | 'check' | 'press'

export interface ChromeSessionExport {
  tab: ChromeTabInfo
  cookies: Array<{
    name: string
    value: string
    domain: string
    path: string
    expires: number
    httpOnly: boolean
    secure: boolean
    sameSite: 'unspecified' | 'no_restriction' | 'lax' | 'strict'
    hostOnly?: boolean
  }>
  origins: Array<{
    origin: string
    localStorage: Array<{ name: string; value: string }>
  }>
}

/** One site this Chrome profile holds cookies for or has open, as offered to
 *  the user to pick from. Storage-only sites legitimately have zero cookies. */
export interface ChromeSessionSite {
  site: string
  cookieCount: number
  openTabs: number
}

/** A session exported for the sites the user ticked, rather than for the tab
 *  in front. `origins` is best-effort: localStorage can only be read from a
 *  page that is open, so a site with no tab contributes cookies only. */
export interface ChromeSitesSessionExport {
  sites: string[]
  cookies: ChromeSessionExport['cookies']
  origins: ChromeSessionExport['origins']
}

export interface ChromeCompanionChatRequest {
  chatId?: string | null
  text: string
  page?: { title: string; url: string } | null
  agent?: string | null
  model?: string | null
  attachments?: ChromeCompanionAttachment[]
}

export interface ChromeCompanionChatResponse {
  chatId: string
  response: string
}

export interface ChromeCompanionChatSummary {
  id: string
  title: string
  workspaceName: string
  updatedAt: number
  messageCount: number
  agent?: string | null
  model?: string | null
}

export interface ChromeCompanionAttachment {
  id: string
  name: string
  path: string
  mimeType: string
  size: number
}

export interface ChromeCompanionFeatures {
  options: (chatId?: string | null) => Promise<{
    agents: Array<{ id: string; installed: boolean }>
    models: Array<{ model: string; apiType: 'anthropic' | 'openai' | 'all'; provider?: string }>
    defaultAgent: string | null
    defaultModel: string | null
    defaultModels: Record<string, string>
    chat?: { id: string; agent?: string | null; model?: string | null } | null
  }>
  updateSettings: (chatId: string, agent: string | null, model: string | null) => Promise<void>
  prepareChat: (input: { page?: ChromeCompanionChatRequest['page']; agent?: string | null; model?: string | null }) => Promise<ChromeCompanionChatSummary>
  upload: (chatId: string, name: string, mimeType: string, data: Buffer) => Promise<ChromeCompanionAttachment>
  transcribe: (mimeType: string, data: Buffer) => Promise<{ text: string }>
  /**
   * Copy the current Chrome tab's signed-in session into a Codey Browser
   * profile. Without a name Codey picks a free one derived from the site, so
   * the one-click path never fails merely because the obvious name is taken;
   * a name the user typed is used as-is and collides loudly. `profileId` is the
   * Chrome profile that asked, so the session comes out of that Chrome and not
   * out of whichever one happens to be active in Codey.
   */
  handoffSession: (name: string | undefined, profileId: string | null) => Promise<ChromeSessionHandoff>
  /**
   * The name the handoff would use for `hostname` if the user just accepts it,
   * plus the profiles that already hold this site's session - the side panel
   * points at those instead of quietly creating a near-duplicate.
   */
  suggestProfileName: (hostname: string) => Promise<{ name: string; existing: string[] }>
  /**
   * What the Codey Browser's profiles look like right now, for the side
   * panel's one-line status: which are in use, which mirror Chrome, and which
   * hold `hostname`. `linked` marks the profile bound to the Chrome profile
   * that asked. Names and flags only - never session contents.
   */
  profilesOverview: (hostname: string | undefined, profileId: string | null) => Promise<{
    profiles: Array<{ name: string; active: boolean; holdsSite: boolean; linked: boolean }>
  }>
}

export interface ChromeSessionHandoff {
  profileName: string
  origin: string
  cookieCount: number
}

/** Hooks for keeping copied logins fresh without a click. `watchDomains` says
 *  which cookie domains the extension should report changes for (null while
 *  the feature is off), and `onSessionChanged` receives the domains a change
 *  burst actually touched. Notification only - no cookie values travel this
 *  way; Codey pulls a fresh export through the normal command channel.
 *
 *  Every hook is per Chrome profile: a watch list describes the one Codey
 *  profile bound to that Chrome, and a change burst may only write that one.
 *  `profileId` is null for a legacy pairing, which is bound to nothing. */
export interface ChromeAutoSyncHooks {
  watchDomains: (profileId: string | null) => string[] | null
  excludedDomains?: (profileId: string | null) => string[]
  revision?: (profileId: string | null) => number
  onPoll?: (profileId: string | null) => void
  onConnected?: (profileId: string | null) => void
  onSessionChanged: (profileId: string | null, domains: string[]) => void
}

export interface ChromeCompanionChatHistory {
  chat: ChromeCompanionChatSummary
  messages: Array<{
    role: 'user' | 'assistant'
    content: string
    timestamp: number
    attachments?: Array<{ id: string; name: string; mimeType: string; size: number }>
  }>
}

type PendingCommand = {
  id: string
  command: string
  input: unknown
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

/** A paired Chrome profile's live state. Queue, pending map and heartbeat are
 *  per client so one Chrome can neither read nor stall another's work. */
type ChromeClient = {
  profileId: string | null
  label: string
  token: string
  clientName: string
  clientVersion: string | null
  pairedAt: number
  lastSeenAt: number | null
  queue: PendingCommand[]
  pending: Map<string, PendingCommand>
  uploadedAttachments: Map<string, { chatId: string; attachment: ChromeCompanionAttachment }>
}

type PersistedClient = {
  profileId: string | null
  label: string
  token: string
  clientName: string
  pairedAt: number
}

type PersistedState = { clients: PersistedClient[] }

/** Map key for a pairing from an extension that reports no profile ID. Only one
 *  can exist: such an extension cannot be told apart from another like it. */
const LEGACY_CLIENT_KEY = 'legacy:unidentified-chrome'

/** Fallback accent (Classic palette blue) until the renderer reports its theme. */
const DEFAULT_ACCENT = '#3377d5'
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/

function safeJson(value: string): unknown {
  try { return JSON.parse(value) } catch { throw new Error('Request body must be valid JSON') }
}

function timingSafeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

/**
 * Loopback bridge for the real-Chrome companion extension. The extension owns
 * all Chrome API access; Codey only queues narrowly typed commands after an
 * an official, stable extension identity. No Chrome profile files are opened.
 */
export class ChromeCompanionBridge {
  private server: http.Server | null = null
  private endpoint: string | null = null
  /** Paired Chrome profiles, keyed by their reported profile ID. */
  private clientsByKey = new Map<string, ChromeClient>()
  // The Mac app's current accent color, mirrored to the extension so the
  // controlled-tab highlight matches whatever palette the user picked.
  private accent = DEFAULT_ACCENT
  private expectedVersion: string | null = null
  private autoSync: ChromeAutoSyncHooks | null = null
  /** Resolves which Chrome profile a Codey-initiated command belongs to, set by
   *  the app once bindings are known. Throws a named error when the active Codey
   *  profile is bound to nothing, or to a Chrome that is not running. */
  private targetResolver: (() => string | null) | null = null

  constructor(
    private readonly stateFile: string,
    private readonly preferredPort = DEFAULT_PORT,
    private readonly onStatus?: (status: ChromeCompanionStatus) => void,
    private readonly onChat?: (request: ChromeCompanionChatRequest) => Promise<ChromeCompanionChatResponse>,
    private readonly onListChats?: () => Promise<ChromeCompanionChatSummary[]>,
    private readonly onChatHistory?: (chatId: string) => Promise<ChromeCompanionChatHistory>,
    private readonly features?: ChromeCompanionFeatures,
    /** The pairing secret Codey staged into the extension's folder. When set,
     *  /v1/connect becomes mutual: the extension must prove it holds the
     *  secret, and the reply carries Codey's own proof so the extension can
     *  tell Codey apart from any other process squatting on the port. */
    private readonly pairingSecret?: () => string | null,
  ) {
    this.loadPairing()
  }

  /** Load pairings. A file still holding the pre-binding single-record shape
   *  reads back as one legacy client, so an extension that has not been
   *  upgraded yet stays authorized instead of being silently logged out. */
  private loadPairing(): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'))
    } catch { return /* first run or damaged state starts unpaired */ }
    if (!parsed || typeof parsed !== 'object') return
    const record = parsed as Record<string, unknown>
    const rows: unknown[] = Array.isArray(record.clients) ? record.clients : [record]
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue
      const value = row as Record<string, unknown>
      if (typeof value.token !== 'string' || value.token.length < 32) continue
      const profileId = typeof value.profileId === 'string' && value.profileId.trim()
        ? value.profileId.trim().slice(0, 100)
        : null
      const key = profileId ?? LEGACY_CLIENT_KEY
      if (this.clientsByKey.has(key)) continue
      this.clientsByKey.set(key, {
        profileId,
        label: typeof value.label === 'string' && value.label.trim()
          ? value.label.trim().slice(0, 80)
          : `Chrome profile ${this.clientsByKey.size + 1}`,
        token: value.token,
        clientName: typeof value.clientName === 'string' ? value.clientName : 'Chrome',
        clientVersion: null,
        pairedAt: typeof value.pairedAt === 'number' ? value.pairedAt : Date.now(),
        lastSeenAt: null,
        queue: [],
        pending: new Map(),
        uploadedAttachments: new Map(),
      })
    }
  }

  private persistPairing(): void {
    fs.mkdirSync(path.dirname(this.stateFile), { recursive: true })
    const state: PersistedState = {
      clients: [...this.clientsByKey.values()].map(client => ({
        profileId: client.profileId,
        label: client.label,
        token: client.token,
        clientName: client.clientName,
        pairedAt: client.pairedAt,
      })),
    }
    const temporary = `${this.stateFile}.${process.pid}.tmp`
    fs.writeFileSync(temporary, JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600 })
    fs.renameSync(temporary, this.stateFile)
  }

  /** "Chrome profile <n>" for a newly seen Chrome. Numbered past the highest
   *  one already in use so deleting a pairing cannot produce two of a name. */
  private nextLabel(): string {
    let highest = 0
    for (const client of this.clientsByKey.values()) {
      const match = /^Chrome profile (\d+)$/.exec(client.label)
      if (match) highest = Math.max(highest, Number(match[1]))
    }
    return `Chrome profile ${Math.max(highest + 1, this.clientsByKey.size + 1)}`
  }

  private isConnected(client: ChromeClient): boolean {
    return !!client.lastSeenAt && Date.now() - client.lastSeenAt < CONNECTED_TTL_MS
  }

  /** The client a single-target status line should describe: the one most
   *  recently heard from, so a connected Chrome is never hidden behind a stale
   *  pairing that happens to sort first. */
  private primary(): ChromeClient | null {
    let best: ChromeClient | null = null
    for (const client of this.clientsByKey.values()) {
      if (!best
        || (client.lastSeenAt ?? 0) > (best.lastSeenAt ?? 0)
        || ((client.lastSeenAt ?? 0) === (best.lastSeenAt ?? 0) && client.pairedAt > best.pairedAt)) {
        best = client
      }
    }
    return best
  }

  /** Every paired Chrome profile, most recently seen first. */
  clients(): ChromeClientInfo[] {
    return [...this.clientsByKey.values()]
      .map(client => ({
        profileId: client.profileId,
        label: client.label,
        clientName: client.clientName,
        clientVersion: client.clientVersion,
        pairedAt: client.pairedAt,
        lastSeenAt: client.lastSeenAt,
        connected: this.isConnected(client),
      }))
      .sort((left, right) => (right.lastSeenAt ?? 0) - (left.lastSeenAt ?? 0) || left.pairedAt - right.pairedAt)
  }

  /** Rename a Chrome profile as shown in Codey. Display only - the binding and
   *  the token are keyed by the ID the extension reports. */
  renameClient(profileId: string, label: string): ChromeClientInfo[] {
    const client = this.clientsByKey.get(String(profileId || ''))
    if (!client) throw new Error('That Chrome profile is not paired with Codey')
    const next = String(label || '').trim().slice(0, 80)
    if (!next) throw new Error('Enter a name for this Chrome profile')
    client.label = next
    this.persistPairing()
    this.emitStatus()
    return this.clients()
  }

  /** Tell the bridge how to pick the Chrome a Codey-initiated command targets.
   *  Without one, a sole paired Chrome is used and anything else is an error. */
  setTargetResolver(resolve: (() => string | null) | null): void {
    this.targetResolver = resolve
  }

  private emitStatus(): void {
    this.onStatus?.(this.status())
  }

  /**
   * Mirror the renderer's accent color. Picked up by the extension on its next
   * poll, so switching palettes recolors the controlled tab without a reload.
   */
  setAccent(hex: string): void {
    this.accent = HEX_COLOR.test(hex) ? hex.toLowerCase() : DEFAULT_ACCENT
  }

  /** A one-line summary across every pairing, for the callers that only ever
   *  asked "is Chrome there?". Per-profile detail lives in `clients()`. */
  status(): ChromeCompanionStatus {
    const primary = this.primary()
    const connected = [...this.clientsByKey.values()].some(client => this.isConnected(client))
    const stale = [...this.clientsByKey.values()].some(client =>
      !!client.clientVersion && !!this.expectedVersion && client.clientVersion !== this.expectedVersion)
    return {
      endpoint: this.endpoint,
      paired: this.clientsByKey.size > 0,
      connected,
      clientName: primary?.clientName ?? null,
      pairedAt: primary?.pairedAt ?? null,
      lastSeenAt: primary?.lastSeenAt ?? null,
      clientVersion: primary?.clientVersion ?? null,
      expectedVersion: this.expectedVersion,
      updateAvailable: stale,
    }
  }

  /** The extension version Codey has staged on disk, so a Chrome still running
   *  an older build can be told to reload rather than failing cryptically. */
  setExpectedVersion(version: string | null): void {
    const next = version && version.trim() ? version.trim().slice(0, 40) : null
    if (next === this.expectedVersion) return
    this.expectedVersion = next
    this.emitStatus()
  }

  /** Drop one Chrome profile's pairing, or every one of them when no ID is
   *  given. Dropping one leaves the others authorized and mid-command. */
  disconnect(profileId?: string | null): ChromeCompanionStatus {
    if (profileId === undefined || profileId === null) {
      for (const client of this.clientsByKey.values()) {
        this.rejectClient(client, new Error('Chrome companion was disconnected'))
      }
      this.clientsByKey.clear()
      try { fs.unlinkSync(this.stateFile) } catch { /* already absent */ }
    } else {
      const key = String(profileId)
      const client = this.clientsByKey.get(key)
      if (client) {
        this.rejectClient(client, new Error(`${client.label} was disconnected`))
        this.clientsByKey.delete(key)
      }
      if (this.clientsByKey.size === 0) {
        try { fs.unlinkSync(this.stateFile) } catch { /* already absent */ }
      } else {
        this.persistPairing()
      }
    }
    this.emitStatus()
    return this.status()
  }

  async start(): Promise<ChromeCompanionStatus> {
    if (this.server) return this.status()
    this.server = http.createServer((request, response) => void this.handle(request, response))
    const candidates = this.preferredPort === 0
      ? [0]
      : Array.from({ length: PORT_SCAN_SIZE }, (_, index) => this.preferredPort + index)
    let lastError: Error | null = null
    for (const port of candidates) {
      try {
        await new Promise<void>((resolve, reject) => {
          const server = this.server!
          const onError = (error: Error) => { server.removeListener('listening', onListening); reject(error) }
          const onListening = () => { server.removeListener('error', onError); resolve() }
          server.once('error', onError)
          server.once('listening', onListening)
          server.listen(port, '127.0.0.1')
        })
        lastError = null
        break
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error))
        if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') break
      }
    }
    if (lastError) { this.server = null; throw lastError }
    const address = this.server.address()
    if (!address || typeof address === 'string') throw new Error('Chrome companion bridge did not bind a TCP port')
    this.endpoint = `http://127.0.0.1:${address.port}`
    this.emitStatus()
    return this.status()
  }

  async stop(): Promise<void> {
    const server = this.server
    this.server = null
    this.endpoint = null
    for (const client of this.clientsByKey.values()) {
      this.rejectClient(client, new Error('Chrome companion bridge stopped'))
    }
    if (!server) return
    await new Promise<void>(resolve => server.close(() => resolve()))
  }

  async activeTab(profileId?: string | null): Promise<ChromeTabInfo> {
    return await this.command<ChromeTabInfo>('activeTab', {}, COMMAND_TIMEOUT_MS, profileId)
  }

  async snapshot(profileId?: string | null): Promise<ChromePageSnapshot> {
    return await this.command<ChromePageSnapshot>('snapshot', {}, COMMAND_TIMEOUT_MS, profileId)
  }

  async exportSession(profileId?: string | null): Promise<ChromeSessionExport> {
    return await this.command<ChromeSessionExport>('exportSession', {}, COMMAND_TIMEOUT_MS, profileId)
  }

  /** Turn change-driven syncing on (or off with null). Takes effect on the
   *  extension's next poll - the watch list rides the poll response. */
  setAutoSync(hooks: ChromeAutoSyncHooks | null): void {
    this.autoSync = hooks
  }

  /** Every site this Chrome profile has cookies for or currently has open. */
  async listSessionSites(profileId?: string | null): Promise<{ sites: ChromeSessionSite[] }> {
    return await this.command<{ sites: ChromeSessionSite[] }>('listSessionSites', {}, COMMAND_TIMEOUT_MS, profileId)
  }

  /**
   * The session Chrome holds for exactly the sites named, nothing else.
   *
   * `openMissing` is the user's opt-in to Chrome briefly opening the picked
   * sites that have no tab, which is the only way to reach their localStorage.
   * It costs real navigations, so it is never assumed.
   */
  async exportSessionForSites(sites: string[], openMissing = false, profileId?: string | null): Promise<ChromeSitesSessionExport> {
    return await this.command<ChromeSitesSessionExport>(
      'exportSessionForSites',
      { sites, openMissing },
      openMissing ? STORAGE_VISIT_TIMEOUT_MS : COMMAND_TIMEOUT_MS,
      profileId,
    )
  }

  /**
   * Act on an element the last `snapshot` stamped with `ref`. Refs are
   * renumbered by every snapshot, so a stale one is rejected by the extension
   * rather than applied to whatever element inherited the number.
   */
  async act(action: ChromePageActionName, ref: string, value?: string, profileId?: string | null): Promise<ChromePageAction> {
    if (!/^e\d+$/.test(ref)) throw new Error(`Invalid element ref: ${ref || '(empty)'}. Run "chrome view" first.`)
    if ((action === 'fill' || action === 'select' || action === 'press') && value === undefined) {
      throw new Error(`Chrome ${action} needs a value`)
    }
    const input: Record<string, unknown> = { ref }
    if (action === 'check') input.value = value !== 'false'
    else if (value !== undefined) input.value = value
    return await this.command<ChromePageAction>(action, input, COMMAND_TIMEOUT_MS, profileId)
  }

  async navigate(url: string, profileId?: string | null): Promise<ChromeTabInfo> {
    let parsed: URL
    try { parsed = new URL(url) } catch { throw new Error('Enter a valid http(s) URL') }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('Only http(s) URLs are allowed')
    return await this.command<ChromeTabInfo>('navigate', { url: parsed.toString() }, COMMAND_TIMEOUT_MS, profileId)
  }

  /** An extension too old to know a command reports it as unsupported, which
   *  reads like a Codey bug. Say what actually needs to happen instead. */
  private explain(client: ChromeClient, error: string): string {
    if (!error) return 'Chrome command failed'
    if (!/Unsupported Codey command/i.test(error)) return error
    const versions = client.clientVersion && this.expectedVersion
      ? ` Chrome is running ${client.clientVersion}; ${this.expectedVersion} is already installed on disk.`
      : ''
    return `Reload the Codey extension at chrome://extensions to finish updating it.${versions}`
  }

  /**
   * Which Chrome a Codey-initiated command goes to. An explicit ID wins; past
   * that the app's resolver decides from the active Codey profile's binding,
   * and with no resolver a sole pairing is the only unambiguous answer.
   */
  private target(profileId?: string | null): ChromeClient {
    if (profileId !== undefined && profileId !== null) {
      const client = this.clientsByKey.get(String(profileId))
      if (!client) throw new Error('That Chrome profile is not paired with Codey')
      if (!this.isConnected(client)) throw new Error(`${client.label} is paired but not running`)
      return client
    }
    if (profileId === undefined && this.targetResolver) {
      return this.target(this.targetResolver())
    }
    if (this.clientsByKey.size === 0) throw new Error('Install the Chrome companion and keep Codey running')
    const connected = [...this.clientsByKey.values()].filter(client => this.isConnected(client))
    if (connected.length === 1) return connected[0]
    if (connected.length === 0) throw new Error('Chrome companion is paired but not connected')
    throw new Error('Several Chrome profiles are connected - link the active Codey profile to one of them in Browser settings')
  }

  private async command<T>(
    command: string,
    input: unknown,
    timeoutMs = COMMAND_TIMEOUT_MS,
    profileId?: string | null,
  ): Promise<T> {
    const client = this.target(profileId)
    return await new Promise<T>((resolve, reject) => {
      const id = crypto.randomUUID()
      const item: PendingCommand = {
        id,
        command,
        input,
        resolve: value => resolve(value as T),
        reject,
        timer: setTimeout(() => {
          client.pending.delete(id)
          client.queue = client.queue.filter(entry => entry.id !== id)
          reject(new Error(`Chrome command timed out: ${command}`))
        }, timeoutMs),
      }
      client.queue.push(item)
      client.pending.set(id, item)
    })
  }

  /** Fail one client's in-flight work, leaving every other client alone. */
  private rejectClient(client: ChromeClient, error: Error): void {
    for (const item of client.pending.values()) {
      clearTimeout(item.timer)
      item.reject(error)
    }
    client.pending.clear()
    client.queue = []
  }

  /** Resolve the bearer token to the Chrome profile that holds it. Every
   *  authenticated route then operates on that client alone, so one Chrome's
   *  token reaches neither another's command queue nor another's cookies. */
  private authorize(request: http.IncomingMessage): ChromeClient | null {
    const header = request.headers.authorization
    const supplied = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : ''
    if (!supplied) return null
    for (const client of this.clientsByKey.values()) {
      if (timingSafeEqual(supplied, client.token)) return client
    }
    return null
  }

  private headers(request: http.IncomingMessage, response: http.ServerResponse, status = 200): void {
    const origin = request.headers.origin === CHROME_COMPANION_ORIGIN ? CHROME_COMPANION_ORIGIN : 'null'
    response.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Headers': 'authorization, content-type, x-codey-extension-id',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    })
  }

  private reply(request: http.IncomingMessage, response: http.ServerResponse, status: number, value: unknown): void {
    this.headers(request, response, status)
    response.end(JSON.stringify(value))
  }

  private async body(request: http.IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += buffer.length
      if (size > MAX_BODY_BYTES) throw new Error('Request body is too large')
      chunks.push(buffer)
    }
    const value = safeJson(Buffer.concat(chunks).toString('utf8') || '{}')
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Request body must be a JSON object')
    return value as Record<string, unknown>
  }

  private touch(client: ChromeClient): void {
    const wasConnected = this.isConnected(client)
    client.lastSeenAt = Date.now()
    this.emitStatus()
    if (!wasConnected) this.notifyConnected(client)
  }

  private notifyConnected(client: ChromeClient): void {
    if (!this.autoSync?.onConnected) return
    void Promise.resolve().then(() => this.autoSync?.onConnected?.(client.profileId)).catch(() => { /* advisory hook */ })
  }

  private async handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    try {
      if (request.method === 'OPTIONS') {
        if (request.headers.origin !== CHROME_COMPANION_ORIGIN) {
          this.reply(request, response, 403, { ok: false, error: 'Untrusted extension origin' })
          return
        }
        this.headers(request, response, 204)
        response.end()
        return
      }
      const url = new URL(request.url || '/', this.endpoint || 'http://127.0.0.1')
      if (request.method === 'GET' && url.pathname === '/v1/status') {
        this.reply(request, response, 200, { ok: true, paired: this.clientsByKey.size > 0 })
        return
      }
      if (request.method === 'POST' && url.pathname === '/v1/connect') {
        if (request.headers.origin !== CHROME_COMPANION_ORIGIN
          || request.headers['x-codey-extension-id'] !== CHROME_COMPANION_EXTENSION_ID) {
          this.reply(request, response, 403, { ok: false, error: 'Untrusted Chrome extension' })
          return
        }
        const input = await this.body(request)
        const secret = this.pairingSecret?.() ?? null
        const nonce = typeof input.nonce === 'string' ? input.nonce.slice(0, 100) : ''
        if (secret) {
          const proof = typeof input.proof === 'string' ? input.proof : ''
          const expected = crypto.createHmac('sha256', secret).update(`codey-client:${nonce}`).digest('hex')
          if (!nonce || !timingSafeEqual(proof, expected)) {
            this.reply(request, response, 403, {
              ok: false,
              error: 'This extension holds no valid pairing secret. Reinstall it from Codey’s Chrome settings, then reload it at chrome://extensions.',
            })
            return
          }
        }
        // The ID is scoped to the Chrome profile the extension runs in, so one
        // Chrome reconnecting replaces only its own pairing. An extension too
        // old to report one lands on the single legacy slot.
        const reportedId = typeof input.profileId === 'string' && input.profileId.trim()
          ? input.profileId.trim().slice(0, 100)
          : null
        const key = reportedId ?? LEGACY_CLIENT_KEY
        const token = crypto.randomBytes(32).toString('base64url')
        const existing = this.clientsByKey.get(key)
        if (existing) this.rejectClient(existing, new Error(`${existing.label} was paired again`))
        // A profile that pairs with an ID supersedes the legacy slot: it is the
        // same extension, now able to say which Chrome profile it speaks for.
        const legacy = reportedId ? this.clientsByKey.get(LEGACY_CLIENT_KEY) : null
        if (legacy) {
          this.rejectClient(legacy, new Error('Chrome companion was paired again'))
          this.clientsByKey.delete(LEGACY_CLIENT_KEY)
        }
        const client: ChromeClient = {
          profileId: reportedId,
          label: existing?.label ?? legacy?.label ?? this.nextLabel(),
          token,
          clientName: typeof input.clientName === 'string' && input.clientName.trim()
            ? input.clientName.trim().slice(0, 80)
            : 'Chrome',
          clientVersion: existing?.clientVersion ?? null,
          pairedAt: Date.now(),
          lastSeenAt: Date.now(),
          queue: [],
          pending: new Map(),
          uploadedAttachments: new Map(),
        }
        this.clientsByKey.set(key, client)
        this.persistPairing()
        this.emitStatus()
        this.notifyConnected(client)
        this.reply(request, response, 200, {
          ok: true,
          token,
          ...(secret
            ? { serverProof: crypto.createHmac('sha256', secret).update(`codey-server:${nonce}:${token}`).digest('hex') }
            : {}),
        })
        return
      }
      const client = this.authorize(request)
      if (!client) {
        this.reply(request, response, 401, { ok: false, error: 'Unauthorized' })
        return
      }
      if (request.method === 'POST' && url.pathname === '/v1/disconnect') {
        this.disconnect(client.profileId ?? LEGACY_CLIENT_KEY)
        this.reply(request, response, 200, { ok: true })
        return
      }
      this.touch(client)
      if (request.method === 'POST' && url.pathname === '/v1/poll') {
        const input = await this.body(request)
        const reported = typeof input.version === 'string' ? input.version.trim().slice(0, 40) : ''
        if (reported && reported !== client.clientVersion) {
          client.clientVersion = reported
          this.emitStatus()
        }
        const command = client.queue.shift()
        const watchDomains = this.autoSync?.watchDomains(client.profileId) ?? null
        const excludedDomains = this.autoSync?.excludedDomains?.(client.profileId) ?? []
        const syncRevision = this.autoSync?.revision?.(client.profileId) ?? 0
        // A poll is a heartbeat from the authorized extension. Let consumers
        // notice config revisions without delaying (or risking) the response.
        const onPoll = this.autoSync?.onPoll
        if (onPoll) void Promise.resolve().then(() => onPoll(client.profileId)).catch(() => { /* advisory hook */ })
        const base = {
          ok: true,
          accent: this.accent,
          expectedVersion: this.expectedVersion,
          // null (not absent) when auto-sync is off, so the extension can drop
          // a stale watch list instead of reporting changes forever.
          watchDomains: watchDomains ? watchDomains.slice(0, 500) : null,
          excludedDomains: excludedDomains.slice(0, 500),
          syncRevision: Number.isSafeInteger(syncRevision) ? syncRevision : 0,
        }
        this.reply(request, response, 200, command
          ? { ...base, command: { id: command.id, command: command.command, input: command.input } }
          : { ...base, command: null })
        return
      }
      if (request.method === 'POST' && url.pathname === '/v1/session/changed') {
        const input = await this.body(request)
        const domains = (Array.isArray(input.domains) ? input.domains : [])
          .filter((domain): domain is string => typeof domain === 'string' && !!domain.trim())
          .map(domain => domain.trim().toLowerCase().slice(0, 300))
          .slice(0, 200)
        if (domains.length > 0) this.autoSync?.onSessionChanged(client.profileId, domains)
        this.reply(request, response, 200, { ok: true })
        return
      }
      if (request.method === 'POST' && url.pathname === '/v1/result') {
        const input = await this.body(request)
        const id = typeof input.id === 'string' ? input.id : ''
        // Only this client's own pending commands: a result posted with one
        // Chrome's token must not be able to resolve another Chrome's command.
        const command = client.pending.get(id)
        if (!command) {
          this.reply(request, response, 404, { ok: false, error: 'Unknown or expired command' })
          return
        }
        clearTimeout(command.timer)
        client.pending.delete(id)
        if (input.ok === true) command.resolve(input.data)
        else command.reject(new Error(this.explain(client, typeof input.error === 'string' ? input.error : '')))
        this.reply(request, response, 200, { ok: true })
        return
      }
      if (request.method === 'POST' && url.pathname === '/v1/chat') {
        if (!this.onChat) throw new Error('Codey chat is unavailable')
        const input = await this.body(request)
        const text = typeof input.text === 'string' ? input.text.trim() : ''
        if (text.length > 20_000) throw new Error('Chat message is too long')
        const chatId = typeof input.chatId === 'string' ? input.chatId.slice(0, 100) : null
        const agent = typeof input.agent === 'string' ? input.agent.slice(0, 50) : null
        const model = typeof input.model === 'string' ? input.model.slice(0, 200) : null
        const attachmentIds = Array.isArray(input.attachmentIds)
          ? input.attachmentIds.filter((id): id is string => typeof id === 'string').slice(0, 10)
          : []
        const attachments = attachmentIds.map(id => client.uploadedAttachments.get(id))
          .filter((entry): entry is { chatId: string; attachment: ChromeCompanionAttachment } => !!entry && !!chatId && entry.chatId === chatId)
          .map(entry => entry.attachment)
        if (!text && attachments.length === 0) throw new Error('A message or attachment is required')
        let page: ChromeCompanionChatRequest['page'] = null
        if (input.page && typeof input.page === 'object' && !Array.isArray(input.page)) {
          const record = input.page as Record<string, unknown>
          const title = typeof record.title === 'string' ? record.title.slice(0, 500) : ''
          const rawUrl = typeof record.url === 'string' ? record.url : ''
          try {
            const parsed = new URL(rawUrl)
            if (parsed.protocol === 'http:' || parsed.protocol === 'https:') page = { title, url: parsed.toString() }
          } catch { /* invalid page context is ignored */ }
        }
        const result = await this.onChat({ chatId, text, page, agent, model, attachments })
        for (const id of attachmentIds) client.uploadedAttachments.delete(id)
        this.reply(request, response, 200, { ok: true, ...result })
        return
      }
      if (request.method === 'POST' && url.pathname === '/v1/profiles') {
        if (!this.features) throw new Error('Browser profiles are unavailable')
        const input = await this.body(request)
        const hostname = typeof input.hostname === 'string' ? input.hostname.slice(0, 300) : ''
        this.reply(request, response, 200, { ok: true, ...await this.features.profilesOverview(hostname || undefined, client.profileId) })
        return
      }
      if (request.method === 'POST' && url.pathname === '/v1/session/handoff/name') {
        if (!this.features) throw new Error('Session handoff is unavailable')
        const input = await this.body(request)
        const hostname = typeof input.hostname === 'string' ? input.hostname.slice(0, 300) : ''
        this.reply(request, response, 200, { ok: true, ...await this.features.suggestProfileName(hostname) })
        return
      }
      if (request.method === 'POST' && url.pathname === '/v1/session/handoff') {
        if (!this.features) throw new Error('Session handoff is unavailable')
        const input = await this.body(request)
        const name = typeof input.name === 'string' ? input.name.trim() : ''
        this.reply(request, response, 200, { ok: true, ...await this.features.handoffSession(name || undefined, client.profileId) })
        return
      }
      if (request.method === 'GET' && url.pathname === '/v1/chats') {
        if (!this.onListChats) throw new Error('Codey chat list is unavailable')
        const chats = await this.onListChats()
        this.reply(request, response, 200, { ok: true, chats })
        return
      }
      if (request.method === 'POST' && url.pathname === '/v1/chat/history') {
        if (!this.onChatHistory) throw new Error('Codey chat history is unavailable')
        const input = await this.body(request)
        const chatId = typeof input.chatId === 'string' ? input.chatId.trim().slice(0, 100) : ''
        if (!chatId) throw new Error('Chat ID is required')
        const history = await this.onChatHistory(chatId)
        this.reply(request, response, 200, { ok: true, ...history })
        return
      }
      if (request.method === 'GET' && url.pathname === '/v1/chat/options') {
        if (!this.features) throw new Error('Chat settings are unavailable')
        const chatId = url.searchParams.get('chatId')?.slice(0, 100) || null
        const options = await this.features.options(chatId)
        this.reply(request, response, 200, { ok: true, ...options })
        return
      }
      if (request.method === 'POST' && url.pathname === '/v1/chat/settings') {
        if (!this.features) throw new Error('Chat settings are unavailable')
        const input = await this.body(request)
        const chatId = typeof input.chatId === 'string' ? input.chatId.trim().slice(0, 100) : ''
        if (!chatId) throw new Error('Chat ID is required')
        const agent = typeof input.agent === 'string' && input.agent ? input.agent.slice(0, 50) : null
        const model = typeof input.model === 'string' && input.model ? input.model.slice(0, 200) : null
        await this.features.updateSettings(chatId, agent, model)
        this.reply(request, response, 200, { ok: true })
        return
      }
      if (request.method === 'POST' && url.pathname === '/v1/chat/prepare') {
        if (!this.features) throw new Error('Chat preparation is unavailable')
        const input = await this.body(request)
        const agent = typeof input.agent === 'string' && input.agent ? input.agent.slice(0, 50) : null
        const model = typeof input.model === 'string' && input.model ? input.model.slice(0, 200) : null
        let page: ChromeCompanionChatRequest['page'] = null
        if (input.page && typeof input.page === 'object' && !Array.isArray(input.page)) {
          const record = input.page as Record<string, unknown>
          const title = typeof record.title === 'string' ? record.title.slice(0, 500) : ''
          const rawUrl = typeof record.url === 'string' ? record.url : ''
          try {
            const parsed = new URL(rawUrl)
            if (parsed.protocol === 'http:' || parsed.protocol === 'https:') page = { title, url: parsed.toString() }
          } catch { /* invalid page context is ignored */ }
        }
        const chat = await this.features.prepareChat({ page, agent, model })
        this.reply(request, response, 200, { ok: true, chat })
        return
      }
      if (request.method === 'POST' && url.pathname === '/v1/chat/upload') {
        if (!this.features) throw new Error('File uploads are unavailable')
        const input = await this.body(request)
        const chatId = typeof input.chatId === 'string' ? input.chatId.trim().slice(0, 100) : ''
        const name = typeof input.name === 'string' ? input.name.trim().slice(0, 255) : ''
        const mimeType = typeof input.mimeType === 'string' ? input.mimeType.slice(0, 200) : 'application/octet-stream'
        const encoded = typeof input.data === 'string' ? input.data : ''
        if (!chatId || !name || !encoded) throw new Error('Chat, file name, and file data are required')
        const data = Buffer.from(encoded, 'base64')
        if (!data.length) throw new Error('The selected file is empty')
        if (data.length > MAX_UPLOAD_BYTES) throw new Error(`${name} exceeds 10 MB`)
        const attachment = await this.features.upload(chatId, name, mimeType, data)
        client.uploadedAttachments.set(attachment.id, { chatId, attachment })
        while (client.uploadedAttachments.size > 100) client.uploadedAttachments.delete(client.uploadedAttachments.keys().next().value!)
        this.reply(request, response, 200, { ok: true, attachment: { id: attachment.id, name: attachment.name, mimeType: attachment.mimeType, size: attachment.size } })
        return
      }
      if (request.method === 'POST' && url.pathname === '/v1/voice/transcribe') {
        if (!this.features) throw new Error('Voice transcription is unavailable')
        const input = await this.body(request)
        const mimeType = typeof input.mimeType === 'string' ? input.mimeType.slice(0, 200) : 'audio/webm'
        const encoded = typeof input.data === 'string' ? input.data : ''
        const data = Buffer.from(encoded, 'base64')
        if (!data.length) throw new Error('The recording was empty')
        if (data.length > MAX_UPLOAD_BYTES) throw new Error('The recording exceeds 10 MB')
        const result = await this.features.transcribe(mimeType, data)
        this.reply(request, response, 200, { ok: true, ...result })
        return
      }
      this.reply(request, response, 404, { ok: false, error: 'Not found' })
    } catch (error) {
      this.reply(request, response, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }
}
