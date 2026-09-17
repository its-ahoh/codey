import type { Chat } from '../types'
import type { WorkerDto } from '../services/api'

export interface BotConversationRow { key: string; title: string; chat?: Chat; bot?: WorkerDto; activity: number }
export function botConversationList(bots: WorkerDto[], chats: Chat[], pins: string[], query = ''): BotConversationRow[] {
  const global = chats.filter(chat => chat.botChat)
  const rows: BotConversationRow[] = global.map(chat => ({
    key: chat.id, title: chat.title, chat,
    bot: chat.botChat!.kind === 'direct' ? bots.find(bot => bot.name.toLowerCase() === chat.botChat!.members[0]?.toLowerCase()) : undefined,
    activity: chat.messages.length ? chat.messages.reduce((latest, message) => Math.max(latest, message.timestamp), 0) : chat.createdAt,
  }))
  for (const bot of bots) {
    if (!global.some(chat => chat.botChat!.kind === 'direct' && chat.botChat!.members[0]?.toLowerCase() === bot.name.toLowerCase())) {
      rows.push({ key: `bot:${bot.name}`, title: bot.name, bot, activity: 0 })
    }
  }
  const term = query.trim().toLowerCase()
  return rows.filter(row => `${row.title} ${row.bot?.personality.role ?? ''} ${row.chat?.botChat?.members.join(' ') ?? ''}`.toLowerCase().includes(term))
    .sort((a, b) => Number(pins.includes(b.key)) - Number(pins.includes(a.key)) || b.activity - a.activity || a.title.localeCompare(b.title) || a.key.localeCompare(b.key))
}

export function readBotPins(raw: string | null): string[] {
  try { const value: unknown = JSON.parse(raw ?? '[]'); return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [] } catch { return [] }
}
