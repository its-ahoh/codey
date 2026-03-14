import TelegramBot from 'node-telegram-bot-api';
import { BaseChannelHandler } from './base';
import { UserMessage, GatewayResponse } from '../types';

function escapeMarkdownV2(text: string): string {
  return text.replace(/([_*`\[\]()#+\-={}.!])/g, '\\$1');
}

export class TelegramHandler extends BaseChannelHandler {
  name = 'telegram';
  private bot?: TelegramBot;
  private typingIntervals: Map<string, NodeJS.Timeout> = new Map();

  private notifyChatId?: string;

  async start(config: { botToken: string; notifyChatId?: string }): Promise<void> {
    this.notifyChatId = config.notifyChatId;
    this.bot = new TelegramBot(config.botToken, { polling: true });

    // Register bot commands menu
    this.bot.setMyCommands([
      { command: 'help', description: 'Show help message' },
      { command: 'status', description: 'Show gateway status' },
      { command: 'workers', description: 'List workers in current workspace' },
      { command: 'workspaces', description: 'List all workspaces' },
      { command: 'workspace', description: 'Switch workspace' },
      { command: 'worker', description: 'Run a specific worker' },
      { command: 'team', description: 'Run workers in sequence' },
      { command: 'clear', description: 'Clear conversation history' },
      { command: 'reset', description: 'Start new conversation' },
      { command: 'model', description: 'Show or set model' },
      { command: 'agent', description: 'Switch default agent' },
      { command: 'parallel', description: 'Run all agents in parallel' },
    ]);

    this.bot.on('message', (msg) => {
      if (!msg.text) return;
      if (!msg.from || !msg.chat) return;

      const chatId = msg.chat.id.toString();

      // Show typing indicator while processing
      this.startTyping(chatId);

      const message: UserMessage = {
        id: msg.message_id.toString(),
        channel: 'telegram',
        userId: msg.from.id.toString(),
        username: msg.from.username || msg.from.first_name || 'unknown',
        chatId,
        text: msg.text,
        timestamp: msg.date * 1000,
      };

      this.emitMessage(message);
    });

    console.log('[Telegram] Handler started');
  }

  async stop(): Promise<void> {
    // Clear all typing intervals
    for (const interval of this.typingIntervals.values()) {
      clearInterval(interval);
    }
    this.typingIntervals.clear();

    if (this.bot) {
      this.bot.stopPolling();
      this.bot = undefined;
    }
  }

  async sendMessage(response: GatewayResponse): Promise<void> {
    if (!this.bot) return;

    // Stop typing indicator when sending a response
    this.stopTyping(response.chatId);

    const options: TelegramBot.SendMessageOptions = {
      parse_mode: 'MarkdownV2',
    };
    if (response.replyTo) {
      options.reply_to_message_id = parseInt(response.replyTo);
    }

    await this.bot.sendMessage(response.chatId, escapeMarkdownV2(response.text), options);
  }

  private startTyping(chatId: string): void {
    if (!this.bot || this.typingIntervals.has(chatId)) return;

    // Send immediately, then repeat every 4s (Telegram typing expires after 5s)
    this.bot.sendChatAction(chatId, 'typing').catch(() => {});
    const interval = setInterval(() => {
      this.bot?.sendChatAction(chatId, 'typing').catch(() => {});
    }, 4000);

    this.typingIntervals.set(chatId, interval);
  }

  private stopTyping(chatId: string): void {
    const interval = this.typingIntervals.get(chatId);
    if (interval) {
      clearInterval(interval);
      this.typingIntervals.delete(chatId);
    }
  }

  async sendStartupMessage(text: string): Promise<void> {
    if (!this.bot || !this.notifyChatId) return;
    await this.bot.sendMessage(this.notifyChatId, escapeMarkdownV2(text), {
      parse_mode: 'MarkdownV2',
    });
  }
}
