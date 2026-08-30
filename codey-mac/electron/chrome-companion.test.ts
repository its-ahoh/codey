import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CHROME_COMPANION_EXTENSION_ID,
  ChromeCompanionBridge,
  type ChromeCompanionChatRequest,
  type ChromeCompanionChatHistory,
  type ChromeCompanionChatSummary,
  type ChromeCompanionFeatures,
} from './chrome-companion'

const bridges: ChromeCompanionBridge[] = []
const directories: string[] = []

afterEach(async () => {
  await Promise.all(bridges.splice(0).map(bridge => bridge.stop()))
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

async function setup(
  onChat?: (request: ChromeCompanionChatRequest) => Promise<{ chatId: string; response: string }>,
  onListChats?: () => Promise<ChromeCompanionChatSummary[]>,
  onChatHistory?: (chatId: string) => Promise<ChromeCompanionChatHistory>,
  features?: ChromeCompanionFeatures,
) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-chrome-companion-'))
  directories.push(directory)
  const stateFile = path.join(directory, 'pairing.json')
  const bridge = new ChromeCompanionBridge(stateFile, 0, undefined, onChat, onListChats, onChatHistory, features)
  bridges.push(bridge)
  const status = await bridge.start()
  expect(status.endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
  return { bridge, endpoint: status.endpoint!, stateFile }
}

async function connect(endpoint: string): Promise<string> {
  const response = await fetch(`${endpoint}/v1/connect`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: `chrome-extension://${CHROME_COMPANION_EXTENSION_ID}`,
      'X-Codey-Extension-Id': CHROME_COMPANION_EXTENSION_ID,
    },
    body: JSON.stringify({ clientName: 'Test Chrome' }),
  })
  const value = await response.json() as { ok: boolean; token: string }
  expect(response.status).toBe(200)
  expect(value.ok).toBe(true)
  return value.token
}

describe('ChromeCompanionBridge', () => {
  it('auto-connects the official extension and persists its long-lived token', async () => {
    const { bridge, endpoint, stateFile } = await setup()
    const token = await connect(endpoint)
    expect(token.length).toBeGreaterThan(32)
    expect(bridge.status()).toMatchObject({ paired: true, connected: true, clientName: 'Test Chrome' })

    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
    expect(state.token).toBe(token)

    const disconnected = await fetch(`${endpoint}/v1/disconnect`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: '{}',
    })
    expect(disconnected.status).toBe(200)
    expect(bridge.status().paired).toBe(false)
    expect(fs.existsSync(stateFile)).toBe(false)
  })

  it('rejects unauthenticated polls', async () => {
    const { bridge, endpoint } = await setup()
    await connect(endpoint)
    const response = await fetch(`${endpoint}/v1/poll`, { method: 'POST', body: '{}' })
    expect(response.status).toBe(401)
  })

  it('rejects automatic connection from any non-official extension origin', async () => {
    const { endpoint } = await setup()
    const response = await fetch(`${endpoint}/v1/connect`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        'X-Codey-Extension-Id': 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      },
      body: JSON.stringify({ clientName: 'Impostor' }),
    })
    expect(response.status).toBe(403)
  })

  it('round-trips a command through the extension protocol', async () => {
    const { bridge, endpoint } = await setup()
    const token = await connect(endpoint)
    const activeTab = bridge.activeTab()

    const poll = await fetch(`${endpoint}/v1/poll`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: '{}',
    })
    const work = await poll.json() as { command: { id: string; command: string } }
    expect(work.command.command).toBe('activeTab')

    await fetch(`${endpoint}/v1/result`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: work.command.id,
        ok: true,
        data: { id: 7, windowId: 3, title: 'Signed in', url: 'https://example.com/account' },
      }),
    })
    await expect(activeTab).resolves.toMatchObject({ id: 7, title: 'Signed in' })
  })

  it('round-trips a current-site session export without writing it to disk', async () => {
    const { bridge, endpoint } = await setup()
    const token = await connect(endpoint)
    const exported = bridge.exportSession()

    const poll = await fetch(`${endpoint}/v1/poll`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: '{}',
    })
    const work = await poll.json() as { command: { id: string; command: string } }
    expect(work.command.command).toBe('exportSession')

    const session = {
      tab: { id: 7, windowId: 3, title: 'Account', url: 'https://example.com/account' },
      cookies: [{
        name: 'session', value: 'secret', domain: 'example.com', path: '/', expires: -1,
        httpOnly: true, secure: true, sameSite: 'lax' as const, hostOnly: true,
      }],
      origins: [{ origin: 'https://example.com', localStorage: [{ name: 'theme', value: 'dark' }] }],
    }
    await fetch(`${endpoint}/v1/result`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: work.command.id, ok: true, data: session }),
    })

    await expect(exported).resolves.toEqual(session)
  })

  it('validates navigation before it reaches Chrome', async () => {
    const { bridge, endpoint } = await setup()
    await connect(endpoint)
    await expect(bridge.navigate('file:///etc/passwd')).rejects.toThrow('Only http(s)')
  })

  it('routes authenticated side-panel chat through Codey', async () => {
    const received: ChromeCompanionChatRequest[] = []
    const { endpoint } = await setup(async request => {
      received.push(request)
      return { chatId: 'chat-1', response: 'Hello from Codey' }
    })
    const token = await connect(endpoint)
    const response = await fetch(`${endpoint}/v1/chat`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: 'Summarize this page',
        page: { title: 'Example', url: 'https://example.com/docs' },
      }),
    })
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ ok: true, chatId: 'chat-1', response: 'Hello from Codey' })
    expect(received).toEqual([{
      chatId: null,
      text: 'Summarize this page',
      page: { title: 'Example', url: 'https://example.com/docs' },
      agent: null,
      model: null,
      attachments: [],
    }])
  })

  it('supports chat settings, uploads, and voice transcription for the side panel', async () => {
    const settings: unknown[][] = []
    const received: ChromeCompanionChatRequest[] = []
    const summary: ChromeCompanionChatSummary = {
      id: 'chat-2', title: 'Chrome', workspaceName: 'default', updatedAt: 1, messageCount: 0,
      agent: 'codex', model: 'gpt-test',
    }
    const features: ChromeCompanionFeatures = {
      options: async () => ({
        agents: [{ id: 'codex', installed: true }],
        models: [{ model: 'gpt-test', apiType: 'openai' }],
        defaultAgent: 'codex',
        defaultModel: 'gpt-test',
        defaultModels: { codex: 'gpt-test' },
        chat: null,
      }),
      updateSettings: async (...values) => { settings.push(values) },
      prepareChat: async () => summary,
      upload: async (_chatId, name, mimeType, data) => ({
        id: 'attachment-1', name, mimeType, size: data.length, path: '/safe/upload.txt',
      }),
      transcribe: async (_mimeType, data) => ({ text: `heard ${data.length} bytes` }),
    }
    const { endpoint } = await setup(
      async request => { received.push(request); return { chatId: 'chat-2', response: 'Attached' } },
      undefined,
      undefined,
      features,
    )
    const token = await connect(endpoint)
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }

    const optionResponse = await fetch(`${endpoint}/v1/chat/options`, { headers })
    await expect(optionResponse.json()).resolves.toMatchObject({ ok: true, defaultAgent: 'codex' })

    await fetch(`${endpoint}/v1/chat/settings`, {
      method: 'POST', headers, body: JSON.stringify({ chatId: 'chat-2', agent: 'codex', model: 'gpt-test' }),
    })
    expect(settings).toEqual([['chat-2', 'codex', 'gpt-test']])

    const uploadResponse = await fetch(`${endpoint}/v1/chat/upload`, {
      method: 'POST', headers,
      body: JSON.stringify({ chatId: 'chat-2', name: 'notes.txt', mimeType: 'text/plain', data: Buffer.from('hello').toString('base64') }),
    })
    const uploaded = await uploadResponse.json() as { attachment: { id: string } }
    expect(uploaded.attachment.id).toBe('attachment-1')

    const chatResponse = await fetch(`${endpoint}/v1/chat`, {
      method: 'POST', headers,
      body: JSON.stringify({ chatId: 'chat-2', text: '', attachmentIds: ['attachment-1'], agent: 'codex', model: 'gpt-test' }),
    })
    expect(chatResponse.status).toBe(200)
    expect(received[0]).toMatchObject({
      chatId: 'chat-2', agent: 'codex', model: 'gpt-test',
      attachments: [{ id: 'attachment-1', name: 'notes.txt', path: '/safe/upload.txt' }],
    })

    const voiceResponse = await fetch(`${endpoint}/v1/voice/transcribe`, {
      method: 'POST', headers,
      body: JSON.stringify({ mimeType: 'audio/webm', data: Buffer.from('audio').toString('base64') }),
    })
    await expect(voiceResponse.json()).resolves.toEqual({ ok: true, text: 'heard 5 bytes' })
  })

  it('lists current-workspace chats and loads a selected chat history', async () => {
    const summary: ChromeCompanionChatSummary = {
      id: 'chat-1',
      title: 'Existing chat',
      workspaceName: 'default',
      updatedAt: 123,
      messageCount: 2,
    }
    const requested: string[] = []
    const { endpoint } = await setup(
      undefined,
      async () => [summary],
      async chatId => {
        requested.push(chatId)
        return {
          chat: summary,
          messages: [
            { role: 'user', content: 'Earlier question', timestamp: 100 },
            { role: 'assistant', content: 'Earlier answer', timestamp: 110 },
          ],
        }
      },
    )
    const token = await connect(endpoint)
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }

    const list = await fetch(`${endpoint}/v1/chats`, { headers })
    expect(list.status).toBe(200)
    await expect(list.json()).resolves.toEqual({ ok: true, chats: [summary] })

    const history = await fetch(`${endpoint}/v1/chat/history`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ chatId: 'chat-1' }),
    })
    expect(history.status).toBe(200)
    await expect(history.json()).resolves.toEqual({
      ok: true,
      chat: summary,
      messages: [
        { role: 'user', content: 'Earlier question', timestamp: 100 },
        { role: 'assistant', content: 'Earlier answer', timestamp: 110 },
      ],
    })
    expect(requested).toEqual(['chat-1'])
  })
})
