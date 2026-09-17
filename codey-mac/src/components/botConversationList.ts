import type { Chat, ChatMessage } from '../types'
import type { WorkerDto } from '../services/api'

export interface BotConversationRow { key: string; title: string; chat?: Chat; bot?: WorkerDto; activity: number; messageMatch?: { snippet: string; count: number } }
export class BotMessageSearchCache {
  // Weak keys release deleted/replaced messages; no growing query-history cache.
  private messages = new WeakMap<ChatMessage, { source: string; content: string; lower: string; term: string; index: number }>()
  find(message: ChatMessage, term: string) {
    let cached = this.messages.get(message)
    if (!cached || cached.source !== message.content) {
      const content = message.content.replace(/\s+/g, ' ')
      const lower = content.toLowerCase()
      cached = { source: message.content, content, lower, term, index: lower.indexOf(term) }
      this.messages.set(message, cached)
    } else if (cached.term !== term) {
      cached.term = term
      cached.index = cached.lower.indexOf(term)
    }
    return cached
  }
}

export function botConversationList(bots: WorkerDto[], chats: Chat[], pins: string[], query = '', cache = new BotMessageSearchCache()): BotConversationRow[] {
  const global = chats.filter(chat => chat.botChat)
  const botsByName = new Map(bots.map(bot => [bot.name.toLowerCase(), bot]))
  const directNames = new Set(global.filter(chat => chat.botChat!.kind === 'direct').map(chat => chat.botChat!.members[0]?.toLowerCase()))
  const pinned = new Set(pins)
  const rows: BotConversationRow[] = global.map(chat => ({
    key: chat.id, title: chat.title, chat,
    bot: chat.botChat!.kind === 'direct' ? botsByName.get(chat.botChat!.members[0]?.toLowerCase()) : undefined,
    activity: chat.messages.length ? chat.messages.reduce((latest, message) => Math.max(latest, message.timestamp), 0) : chat.createdAt,
  }))
  for (const bot of bots) {
    if (!directNames.has(bot.name.toLowerCase())) {
      rows.push({ key: `bot:${bot.name}`, title: bot.name, bot, activity: 0 })
    }
  }
  const term = query.trim().replace(/\s+/g, ' ').toLowerCase()
  return rows.filter(row => {
    if (!term) return true
    let count = 0
    let snippet = ''
    for (const message of row.chat?.messages ?? []) {
      const { content, index } = cache.find(message, term)
      if (index < 0) continue
      count++
      const start = Math.max(0, index - 35)
      const end = Math.min(content.length, index + term.length + 70)
      snippet = `${start ? '…' : ''}${content.slice(start, end)}${end < content.length ? '…' : ''}`
    }
    if (count) row.messageMatch = { snippet, count }
    return count > 0 || `${row.title} ${row.bot?.personality.role ?? ''} ${row.chat?.botChat?.members.join(' ') ?? ''}`.toLowerCase().includes(term)
  })
    .sort((a, b) => Number(pinned.has(b.key)) - Number(pinned.has(a.key)) || b.activity - a.activity || a.title.localeCompare(b.title) || a.key.localeCompare(b.key))
}

export function readBotPins(raw: string | null): string[] {
  try { const value: unknown = JSON.parse(raw ?? '[]'); return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [] } catch { return [] }
}
