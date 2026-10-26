import { describe, expect, it, vi } from 'vitest'
import type { FileAttachment } from '@codey/core'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { Codey } from './gateway'
import { ChannelEmitter } from './team-emitter'

const image: FileAttachment = {
  id: 'image',
  name: 'chart.png',
  path: '/w/.codey/uploads/outputs/chart.png',
  mimeType: 'image/png',
  size: 1,
}

function gatewayHarness(handler: Record<string, unknown>, chat?: Record<string, unknown>) {
  return Object.assign(Object.create(Codey.prototype), {
    handlers: new Map([['discord', handler]]),
    chatManager: { get: () => chat },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    MAX_MESSAGE_LENGTH: 80,
  })
}

describe('gateway channel media delivery', () => {
  it('labels snapshot links in text and sends the image afterward', async () => {
    const sent: string[] = []
    const handler = {
      sendMessage: vi.fn(async (response: { text: string }) => { sent.push(`text:${response.text}`) }),
      sendImages: vi.fn(async () => { sent.push('image'); return [] }),
    }
    const gateway = gatewayHarness(handler)

    await gateway.sendResponse({
      chatId: 'channel1',
      channel: 'discord',
      text: `Report: ![Chart](<${image.path}>)`,
      attachments: [image],
    })

    expect(sent).toEqual(['text:Report: [Image: Chart]', 'image'])
  })

  it('fan-out sends images only after every text chunk', async () => {
    const sent: string[] = []
    const route = { channel: 'discord', channelUserId: 'user1', channelChatId: 'channel1', attachedAt: 0 }
    const handler = {
      sendToRoute: vi.fn(async (_route: unknown, text: string) => { sent.push(`text:${text}`) }),
      sendImages: vi.fn(async () => { sent.push('image'); return [] }),
    }
    const gateway = gatewayHarness(handler, { routes: [route] })
    const longText = Array.from({ length: 12 }, (_, index) => `line ${index} ${'x'.repeat(20)}`).join('\n')

    await gateway.fanOutToOtherRoutes('chat1', '__mac__', '', longText, [image])

    expect(sent.filter(item => item.startsWith('text:')).length).toBeGreaterThan(1)
    expect(sent.at(-1)).toBe('image')
  })

  it('sends the team channel text with images to the origin channel', async () => {
    const sendResponse = vi.fn(async () => {})
    const gateway = Object.assign(Object.create(Codey.prototype), {
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      sendResponse,
      sendToChat: vi.fn(async (_id: string, _text: string, sink: (ev: unknown) => void) => {
        sink({ type: 'done', chatId: 'c', response: '', channelText: 'Aide summary', attachments: [image], teamTurnId: 't' })
      }),
    })
    await gateway.runChannelTurnViaChat({ chatId: 'channel1', channel: 'discord', userId: 'u', id: 'm', text: 'hi' }, { prompt: 'hi' }, 'c')
    expect(sendResponse).toHaveBeenCalledWith(expect.objectContaining({ text: 'Aide summary', attachments: [image] }))
  })

  it('skips the origin send when a team turn has no text and no images', async () => {
    const sendResponse = vi.fn(async () => {})
    const gateway = Object.assign(Object.create(Codey.prototype), {
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      sendResponse,
      sendToChat: vi.fn(async (_id: string, _text: string, sink: (ev: unknown) => void) => {
        sink({ type: 'done', chatId: 'c', response: '', teamTurnId: 't' })
      }),
    })
    await gateway.runChannelTurnViaChat({ chatId: 'channel1', channel: 'discord', userId: 'u', id: 'm', text: 'hi' }, { prompt: 'hi' }, 'c')
    expect(sendResponse).not.toHaveBeenCalled()
  })

  it('attaches images from the channel team final', async () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'team-final-media-'))
    try {
      fs.writeFileSync(path.join(work, 'chart.png'), Buffer.from('89504e470d0a1a0a', 'hex'))
      const sent: Array<{ text: string; attachments?: FileAttachment[] }> = []
      const gateway = Object.assign(Object.create(Codey.prototype), { isAideConfigured: () => false })
      const emitter = new ChannelEmitter(async r => { sent.push(r) }, undefined, 'c1', 'discord' as any, work)
      await gateway.notifyTeamFinal(emitter, 'Team', 'Draw', [{ step: 1, bot: 'ben', output: 'Here ![c](chart.png)' }])
      expect(sent).toHaveLength(1)
      expect(sent[0].attachments).toHaveLength(1)
      expect(sent[0].text).toContain(sent[0].attachments![0].path)
      expect(fs.readdirSync(path.join(work, '.codey', 'uploads', 'outputs'))).toHaveLength(1)
    } finally {
      fs.rmSync(work, { recursive: true, force: true })
    }
  })
})
