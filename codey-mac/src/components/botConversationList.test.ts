import { describe, expect, it } from 'vitest'
import type { Chat } from '../types'
import type { WorkerDto } from '../services/api'
import { BotMessageSearchCache, botConversationList, readBotPins } from './botConversationList'
const bot = { name: 'Alice', personality: { role: 'Designer' }, config: {} } as WorkerDto
const chat = (id: string, kind: 'direct' | 'group', timestamp: number): Chat => ({
  id, title: id, workspaceName: '.bot-chats', selection: { type: 'none' }, createdAt: 1, updatedAt: 999,
  botChat: { kind, members: kind === 'direct' ? ['Alice'] : ['Alice', 'Ben'], homeDir: '/tmp' },
  messages: [{ id: `${id}-message`, role: 'user', content: 'Hello', timestamp }],
})
describe('unified Bot chat list', () => {
  it('reuses normalized messages and refreshes matches for new queries and edited content', () => {
    const cache = new BotMessageSearchCache()
    const message = chat('Alice', 'direct', 20).messages[0]
    message.content = 'AI\nNEWS digest'
    const first = cache.find(message, 'ai news')
    expect(first.index).toBe(0)
    expect(cache.find(message, 'ai news')).toBe(first)
    expect(cache.find(message, 'digest').index).toBe(8)
    message.content = 'Updated report'
    expect(cache.find(message, 'ai news').index).toBe(-1)
    expect(cache.find(message, 'report').content).toBe('Updated report')
  })
  it('keeps cached results current when messages are replaced, appended, or removed', () => {
    const cache = new BotMessageSearchCache()
    const direct = chat('Alice', 'direct', 20)
    const search = (query = 'news') => botConversationList([bot], [direct], [], query, cache)
    expect(search()).toHaveLength(0)
    direct.messages = [{ ...direct.messages[0], content: 'First news' }]
    expect(search()[0].messageMatch).toEqual({ count: 1, snippet: 'First news' })
    direct.messages.push({ id: 'reply', role: 'assistant', content: 'Latest news', timestamp: 30 })
    expect(search()[0].messageMatch).toEqual({ count: 2, snippet: 'Latest news' })
    direct.messages.pop()
    expect(search()[0].messageMatch).toEqual({ count: 1, snippet: 'First news' })
    expect(search('')[0].messageMatch).toBeUndefined()
    expect(search('latest')).toHaveLength(0)
    expect(search()[0].messageMatch?.count).toBe(1)
  })
  it('finds user and Bot messages across private and group chats', () => {
    const direct = chat('Alice', 'direct', 20), group = chat('Team', 'group', 30)
    direct.messages[0].content = 'Discuss AI news'
    direct.messages.push({ id: 'answer', role: 'assistant', content: 'Weekly AI\nnews digest', timestamp: 22 })
    group.messages[0].content = 'Share AI news in our group'
    const results = botConversationList([bot], [direct, group], [], 'ai NEWS')
    expect(results.map(row => row.key)).toEqual(['Team', 'Alice'])
    expect(results[1].messageMatch).toEqual({ count: 2, snippet: 'Weekly AI news digest' })
    expect(botConversationList([bot], [direct], [], 'unmatched')).toHaveLength(0)
    expect(botConversationList([bot], [direct], [])[0].messageMatch).toBeUndefined()
  })
  it('shows context around a match deep inside a long message', () => {
    const direct = chat('Alice', 'direct', 20)
    direct.messages[0].content = `${'intro '.repeat(100)}\u8d26\u6237\u589e\u957f${' ending'.repeat(100)}`
    const result = botConversationList([bot], [direct], [], '\u8d26\u6237\u589e\u957f')[0]
    expect(result.messageMatch?.snippet).toContain('\u8d26\u6237\u589e\u957f')
    expect(result.messageMatch?.snippet.length).toBeLessThan(120)
    expect(result.messageMatch?.snippet.startsWith('…')).toBe(true)
  })
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
