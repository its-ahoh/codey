import { apiService, type BotDto } from '../services/api'

/**
 * Renames what a bot chat shows. In a one-bot chat this renames the bot itself
 * (its display name); in a group it renames the chat.
 */
export async function renameBotChat(
  chat: { id: string; title: string },
  bot: BotDto | undefined,
  next: string,
  renameChat: (chatId: string, title: string) => Promise<void>,
): Promise<void> {
  if (!bot) return renameChat(chat.id, next)
  await apiService.updateBot(bot.name, { personality: bot.personality, config: { ...bot.config, displayName: next } })
  // A custom chat title would hide the bot's name, so reset it to the bot id.
  if (chat.title !== bot.name) await renameChat(chat.id, bot.name)
  window.dispatchEvent(new Event('codey:bots-changed'))
}
