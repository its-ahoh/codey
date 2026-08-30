import * as crypto from 'crypto'
import * as fs from 'fs'
import * as http from 'http'
import * as path from 'path'

const DEFAULT_PORT = 49321
const PORT_SCAN_SIZE = 10
const CONNECTED_TTL_MS = 45_000
const COMMAND_TIMEOUT_MS = 20_000
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
  links: Array<{ text: string; href: string }>
  forms: Array<{ tag: string; type: string; name: string; placeholder: string }>
}

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

type PersistedPairing = {
  token: string
  clientName: string
  pairedAt: number
}

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
  private token: string | null = null
  private clientName: string | null = null
  private pairedAt: number | null = null
  private lastSeenAt: number | null = null
  private queue: PendingCommand[] = []
  // The Mac app's current accent color, mirrored to the extension so the
  // controlled-tab highlight matches whatever palette the user picked.
  private accent = DEFAULT_ACCENT
  private pending = new Map<string, PendingCommand>()
  private uploadedAttachments = new Map<string, { chatId: string; attachment: ChromeCompanionAttachment }>()

  constructor(
    private readonly stateFile: string,
    private readonly preferredPort = DEFAULT_PORT,
    private readonly onStatus?: (status: ChromeCompanionStatus) => void,
    private readonly onChat?: (request: ChromeCompanionChatRequest) => Promise<ChromeCompanionChatResponse>,
    private readonly onListChats?: () => Promise<ChromeCompanionChatSummary[]>,
    private readonly onChatHistory?: (chatId: string) => Promise<ChromeCompanionChatHistory>,
    private readonly features?: ChromeCompanionFeatures,
  ) {
    this.loadPairing()
  }

  private loadPairing(): void {
    try {
      const value = JSON.parse(fs.readFileSync(this.stateFile, 'utf8')) as Partial<PersistedPairing>
      if (typeof value.token !== 'string' || value.token.length < 32) return
      this.token = value.token
      this.clientName = typeof value.clientName === 'string' ? value.clientName : 'Chrome'
      this.pairedAt = typeof value.pairedAt === 'number' ? value.pairedAt : Date.now()
    } catch { /* first run or damaged state starts unpaired */ }
  }

  private persistPairing(): void {
    if (!this.token || !this.clientName || !this.pairedAt) return
    fs.mkdirSync(path.dirname(this.stateFile), { recursive: true })
    const temporary = `${this.stateFile}.${process.pid}.tmp`
    fs.writeFileSync(temporary, JSON.stringify({
      token: this.token,
      clientName: this.clientName,
      pairedAt: this.pairedAt,
    } satisfies PersistedPairing, null, 2), { encoding: 'utf8', mode: 0o600 })
    fs.renameSync(temporary, this.stateFile)
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

  status(): ChromeCompanionStatus {
    return {
      endpoint: this.endpoint,
      paired: !!this.token,
      connected: !!this.token && !!this.lastSeenAt && Date.now() - this.lastSeenAt < CONNECTED_TTL_MS,
      clientName: this.clientName,
      pairedAt: this.pairedAt,
      lastSeenAt: this.lastSeenAt,
    }
  }

  disconnect(): ChromeCompanionStatus {
    this.token = null
    this.clientName = null
    this.pairedAt = null
    this.lastSeenAt = null
    try { fs.unlinkSync(this.stateFile) } catch { /* already absent */ }
    this.rejectAll(new Error('Chrome companion was disconnected'))
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
    this.rejectAll(new Error('Chrome companion bridge stopped'))
    if (!server) return
    await new Promise<void>(resolve => server.close(() => resolve()))
  }

  async activeTab(): Promise<ChromeTabInfo> {
    return await this.command<ChromeTabInfo>('activeTab', {})
  }

  async snapshot(): Promise<ChromePageSnapshot> {
    return await this.command<ChromePageSnapshot>('snapshot', {})
  }

  async exportSession(): Promise<ChromeSessionExport> {
    return await this.command<ChromeSessionExport>('exportSession', {})
  }

  async navigate(url: string): Promise<ChromeTabInfo> {
    let parsed: URL
    try { parsed = new URL(url) } catch { throw new Error('Enter a valid http(s) URL') }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('Only http(s) URLs are allowed')
    return await this.command<ChromeTabInfo>('navigate', { url: parsed.toString() })
  }

  private async command<T>(command: string, input: unknown): Promise<T> {
    if (!this.token) throw new Error('Install the Chrome companion and keep Codey running')
    if (!this.status().connected) throw new Error('Chrome companion is paired but not connected')
    return await new Promise<T>((resolve, reject) => {
      const id = crypto.randomUUID()
      const item: PendingCommand = {
        id,
        command,
        input,
        resolve: value => resolve(value as T),
        reject,
        timer: setTimeout(() => {
          this.pending.delete(id)
          this.queue = this.queue.filter(entry => entry.id !== id)
          reject(new Error(`Chrome command timed out: ${command}`))
        }, COMMAND_TIMEOUT_MS),
      }
      this.queue.push(item)
      this.pending.set(id, item)
    })
  }

  private rejectAll(error: Error): void {
    for (const item of this.pending.values()) {
      clearTimeout(item.timer)
      item.reject(error)
    }
    this.pending.clear()
    this.queue = []
  }

  private authorize(request: http.IncomingMessage): boolean {
    const header = request.headers.authorization
    const supplied = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : ''
    return !!this.token && timingSafeEqual(supplied, this.token)
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

  private touch(): void {
    this.lastSeenAt = Date.now()
    this.emitStatus()
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
        this.reply(request, response, 200, { ok: true, paired: !!this.token })
        return
      }
      if (request.method === 'POST' && url.pathname === '/v1/connect') {
        if (request.headers.origin !== CHROME_COMPANION_ORIGIN
          || request.headers['x-codey-extension-id'] !== CHROME_COMPANION_EXTENSION_ID) {
          this.reply(request, response, 403, { ok: false, error: 'Untrusted Chrome extension' })
          return
        }
        const input = await this.body(request)
        this.token = crypto.randomBytes(32).toString('base64url')
        this.rejectAll(new Error('Chrome companion was paired again'))
        this.clientName = typeof input.clientName === 'string' && input.clientName.trim()
          ? input.clientName.trim().slice(0, 80)
          : 'Chrome'
        this.pairedAt = Date.now()
        this.lastSeenAt = Date.now()
        this.persistPairing()
        this.emitStatus()
        this.reply(request, response, 200, { ok: true, token: this.token })
        return
      }
      if (!this.authorize(request)) {
        this.reply(request, response, 401, { ok: false, error: 'Unauthorized' })
        return
      }
      if (request.method === 'POST' && url.pathname === '/v1/disconnect') {
        this.disconnect()
        this.reply(request, response, 200, { ok: true })
        return
      }
      this.touch()
      if (request.method === 'POST' && url.pathname === '/v1/poll') {
        const command = this.queue.shift()
        this.reply(request, response, 200, command
          ? { ok: true, accent: this.accent, command: { id: command.id, command: command.command, input: command.input } }
          : { ok: true, accent: this.accent, command: null })
        return
      }
      if (request.method === 'POST' && url.pathname === '/v1/result') {
        const input = await this.body(request)
        const id = typeof input.id === 'string' ? input.id : ''
        const command = this.pending.get(id)
        if (!command) {
          this.reply(request, response, 404, { ok: false, error: 'Unknown or expired command' })
          return
        }
        clearTimeout(command.timer)
        this.pending.delete(id)
        if (input.ok === true) command.resolve(input.data)
        else command.reject(new Error(typeof input.error === 'string' ? input.error : 'Chrome command failed'))
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
        const attachments = attachmentIds.map(id => this.uploadedAttachments.get(id))
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
        for (const id of attachmentIds) this.uploadedAttachments.delete(id)
        this.reply(request, response, 200, { ok: true, ...result })
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
        this.uploadedAttachments.set(attachment.id, { chatId, attachment })
        while (this.uploadedAttachments.size > 100) this.uploadedAttachments.delete(this.uploadedAttachments.keys().next().value!)
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
