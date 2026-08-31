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

  it('reports the accent color on every poll and rejects junk values', async () => {
    const { bridge, endpoint } = await setup()
    const token = await connect(endpoint)
    const poll = async () => {
      const response = await fetch(`${endpoint}/v1/poll`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: '{}',
      })
      return await response.json() as { accent: string }
    }

    expect((await poll()).accent).toBe('#3377d5')
    bridge.setAccent('#2BE69B')
    expect((await poll()).accent).toBe('#2be69b')
    bridge.setAccent('javascript:alert(1)')
    expect((await poll()).accent).toBe('#3377d5')
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

  it('exports the session for a URL Codey names, not the tab in front', async () => {
    const { bridge, endpoint } = await setup()
    const token = await connect(endpoint)
    const exported = bridge.exportSessionForUrl('https://example.com/inbox')

    const poll = await fetch(`${endpoint}/v1/poll`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: '{}',
    })
    const work = await poll.json() as { command: { id: string; command: string; input: { url: string } } }
    expect(work.command.command).toBe('exportSessionForUrl')
    expect(work.command.input).toEqual({ url: 'https://example.com/inbox' })

    // No tab has to be open on the site, so the export carries no tab at all.
    const session = {
      url: 'https://example.com/inbox',
      origin: 'https://example.com',
      cookies: [{
        name: 'session', value: 'secret', domain: 'example.com', path: '/', expires: -1,
        httpOnly: true, secure: true, sameSite: 'lax' as const,
      }],
      origins: [],
    }
    await fetch(`${endpoint}/v1/result`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: work.command.id, ok: true, data: session }),
    })

    await expect(exported).resolves.toEqual(session)
  })

  it('notices Chrome is running an older extension than the one on disk', async () => {
    const { bridge, endpoint } = await setup()
    const token = await connect(endpoint)
    bridge.setExpectedVersion('0.10.0')

    const poll = (version?: string) => fetch(`${endpoint}/v1/poll`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(version === undefined ? {} : { version }),
    }).then(response => response.json() as Promise<{ expectedVersion: string | null }>)

    // Chrome is still running the build it loaded before Codey updated.
    await expect(poll('0.9.2')).resolves.toMatchObject({ expectedVersion: '0.10.0' })
    expect(bridge.status()).toMatchObject({
      clientVersion: '0.9.2', expectedVersion: '0.10.0', updateAvailable: true,
    })

    // After the user reloads it, the warning has to clear itself.
    await poll('0.10.0')
    expect(bridge.status().updateAvailable).toBe(false)
  })

  it('explains an unsupported command as an extension that needs reloading', async () => {
    const { bridge, endpoint } = await setup()
    const token = await connect(endpoint)
    bridge.setExpectedVersion('0.10.0')
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
    await fetch(`${endpoint}/v1/poll`, { method: 'POST', headers, body: JSON.stringify({ version: '0.9.2' }) })

    // Captured as a value: the rejection lands while the poll below is still
    // in flight, and an unhandled one would fail the suite.
    const clicked = bridge.act('click', 'e1').catch((error: Error) => error)
    const work = await fetch(`${endpoint}/v1/poll`, { method: 'POST', headers, body: '{}' })
      .then(response => response.json() as Promise<{ command: { id: string } }>)
    await fetch(`${endpoint}/v1/result`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ id: work.command.id, ok: false, error: 'Unsupported Codey command: click' }),
    })

    // The raw message reads like a Codey bug; the user needs the actual fix.
    const failure = await clicked
    expect(String(failure)).toMatch(/Reload the Codey extension/)
    expect(String(failure)).toMatch(/0\.9\.2/)
  })

  it('validates navigation before it reaches Chrome', async () => {
    const { bridge, endpoint } = await setup()
    await connect(endpoint)
    await expect(bridge.navigate('file:///etc/passwd')).rejects.toThrow('Only http(s)')
  })

  it('rejects a page action whose ref did not come from a snapshot', async () => {
    const { bridge, endpoint } = await setup()
    await connect(endpoint)
    await expect(bridge.act('click', 'button.submit')).rejects.toThrow('Invalid element ref')
    await expect(bridge.act('click', '')).rejects.toThrow('Invalid element ref')
    await expect(bridge.act('fill', 'e2')).rejects.toThrow('needs a value')
  })

  it('round-trips a click through the extension protocol', async () => {
    const { bridge, endpoint } = await setup()
    const token = await connect(endpoint)
    const clicked = bridge.act('click', 'e4')

    const poll = await fetch(`${endpoint}/v1/poll`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: '{}',
    })
    const work = await poll.json() as { command: { id: string; command: string; input: { ref: string } } }
    expect(work.command.command).toBe('click')
    expect(work.command.input).toEqual({ ref: 'e4' })

    const outcome = {
      tab: { id: 7, windowId: 3, title: 'Sent', url: 'https://example.com/done' },
      element: { tag: 'button', text: 'Send' },
    }
    await fetch(`${endpoint}/v1/result`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: work.command.id, ok: true, data: outcome }),
    })
    await expect(clicked).resolves.toEqual(outcome)
  })

  it('sends check as a boolean so "false" unticks instead of ticking', async () => {
    const { bridge, endpoint } = await setup()
    const token = await connect(endpoint)
    void bridge.act('check', 'e9', 'false').catch(() => undefined)

    const poll = await fetch(`${endpoint}/v1/poll`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: '{}',
    })
    const work = await poll.json() as { command: { input: { ref: string; value: boolean } } }
    expect(work.command.input).toEqual({ ref: 'e9', value: false })
  })

  it('hands the current site\'s session to Codey from the side panel', async () => {
    const handoffs: Array<string | undefined> = []
    const resyncs: boolean[] = []
    const features = {
      options: async () => ({
        agents: [], models: [], defaultAgent: null, defaultModel: null, defaultModels: {}, chat: null,
      }),
      updateSettings: async () => undefined,
      prepareChat: async () => ({
        id: 'chat-1', title: 'Chat', workspaceName: 'w', updatedAt: 1, messageCount: 0,
      }),
      upload: async () => ({ id: 'a', name: 'n', mimeType: 'text/plain', size: 0, path: '/tmp/n' }),
      transcribe: async () => ({ text: '' }),
      handoffSession: async (name?: string, resync?: boolean) => {
        handoffs.push(name)
        resyncs.push(resync === true)
        return { profileName: name || 'example.com-2', origin: 'https://example.com', cookieCount: 4, resynced: resync === true }
      },
      suggestProfileName: async (hostname: string) => ({ name: `${hostname}-free`, existing: [`${hostname}-saved`] }),
    } as unknown as ChromeCompanionFeatures
    const { endpoint } = await setup(undefined, undefined, undefined, features)
    const token = await connect(endpoint)

    // Unauthenticated callers must not be able to lift a session.
    const anonymous = await fetch(`${endpoint}/v1/session/handoff`, { method: 'POST' })
    expect(anonymous.status).toBe(401)
    expect(handoffs).toHaveLength(0)

    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }

    // The panel prefills its field with a name Codey says is free.
    const suggested = await fetch(`${endpoint}/v1/session/handoff/name`, {
      method: 'POST', headers, body: JSON.stringify({ hostname: 'example.com' }),
    })
    await expect(suggested.json()).resolves.toEqual({
      ok: true, name: 'example.com-free', existing: ['example.com-saved'],
    })

    // A name the user typed is passed through untouched.
    const named = await fetch(`${endpoint}/v1/session/handoff`, {
      method: 'POST', headers, body: JSON.stringify({ name: '  my-github  ' }),
    })
    expect(named.status).toBe(200)
    await expect(named.json()).resolves.toEqual({
      ok: true, profileName: 'my-github', origin: 'https://example.com', cookieCount: 4, resynced: false,
    })

    // An omitted or blank name means "you pick one".
    const auto = await fetch(`${endpoint}/v1/session/handoff`, {
      method: 'POST', headers, body: JSON.stringify({ name: '   ' }),
    })
    await expect(auto.json()).resolves.toMatchObject({ profileName: 'example.com-2' })

    // Refreshing an existing profile goes down the same route with a flag.
    const refreshed = await fetch(`${endpoint}/v1/session/handoff`, {
      method: 'POST', headers, body: JSON.stringify({ name: 'my-github', resync: true }),
    })
    await expect(refreshed.json()).resolves.toMatchObject({ profileName: 'my-github', resynced: true })

    // "Refresh whichever" is not a thing - there would be no way to guess which.
    const nameless = await fetch(`${endpoint}/v1/session/handoff`, {
      method: 'POST', headers, body: JSON.stringify({ resync: true }),
    })
    expect(nameless.status).toBe(400)
    await expect(nameless.json()).resolves.toMatchObject({ error: 'Choose which profile to re-sync' })

    expect(handoffs).toEqual(['my-github', undefined, 'my-github'])
    expect(resyncs).toEqual([false, false, true])
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
      handoffSession: async () => ({ profileName: 'example.com', origin: 'https://example.com', cookieCount: 3, resynced: false }),
      suggestProfileName: async hostname => ({ name: hostname, existing: [] }),
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
