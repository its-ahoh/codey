import { describe, expect, it } from 'vitest'
import type { Chat } from '../types'
import type { WorkerDto } from '../services/api'
import { botConversationList, readBotPins } from './botConversationList'
const bot = { name: 'Alice', personality: { role: 'Designer' }, config: {} } as WorkerDto
const chat = (id: string, kind: 'direct' | 'group', timestamp: number): Chat => ({
  id, title: id, workspaceName: '.bot-chats', selection: { type: 'none' }, createdAt: 1, updatedAt: 999,
  botChat: { kind, members: kind === 'direct' ? ['Alice'] : ['Alice', 'Ben'], homeDir: '/tmp' },
  messages: [{ id: `${id}-message`, role: 'user', content: 'Hello', timestamp }],
})
describe('unified Bot chat list', () => {
  it('interleaves private chats and groups by messages, with pinned chats first', () => {
    const direct = chat('Alice', 'direct', 20), group = chat('Team', 'group', 30)
    expect(botConversationList([bot], [direct, group], []).map(row => row.key)).toEqual(['Team', 'Alice'])
    expect(botConversationList([bot], [direct, group], ['Alice']).map(row => row.key)).toEqual(['Alice', 'Team'])
    direct.messages.push({ id: 'reply', role: 'assistant', content: 'Reply', timestamp: 40 })
    expect(botConversationList([bot], [group, direct], []).map(row => row.key)).toEqual(['Alice', 'Team'])
  })
  it('retains existing conversations when a Bot is unavailable and does not duplicate its roster entry', () => {
    const direct = chat('Alice', 'direct', 20)
    expect(botConversationList([bot], [direct], [])).toHaveLength(1)
    expect(botConversationList([], [direct], [direct.id])[0].chat).toBe(direct)
    expect(botConversationList([bot], [], [])[0].bot).toBe(bot)
    expect(botConversationList([bot], [direct, chat('Team', 'group', 30)], [], 'ben')[0].title).toBe('Team')
  })
  it('restores pins safely and ignores missing conversations', () => {
    expect(readBotPins('["Alice",7]')).toEqual(['Alice'])
    expect(readBotPins('broken')).toEqual([])
    expect(botConversationList([bot], [chat('Alice', 'direct', 20)], ['deleted'])).toHaveLength(1)
  })
})
