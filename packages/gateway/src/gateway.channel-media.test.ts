import { describe, expect, it, vi } from 'vitest'
import type { FileAttachment } from '@codey/core'
import { Codey } from './gateway'

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
})
