import TelegramBot from 'node-telegram-bot-api';
import { BaseChannelHandler } from './base';
import { UserMessage, GatewayResponse } from '../types';

export class TelegramHandler extends BaseChannelHandler {
  name = 'telegram';
  private bot?: TelegramBot;
  private config?: { botToken: string };

  async start(config: { botToken: string }): Promise<void> {
    this.config = config;
    this.bot = new TelegramBot(config.botToken, { polling: true });

    this.bot.on('message', (msg) => {
      if (!msg.text || msg.text.startsWith('/')) return;
      if (!msg.from || !msg.chat) return;

      const message: UserMessage = {
        id: msg.message_id.toString(),
        channel: 'telegram',
        userId: msg.from.id.toString(),
        username: msg.from.username || msg.from.first_name || 'unknown',
        chatId: msg.chat.id.toString(),
        text: msg.text,
        timestamp: msg.date * 1000,
      };

      this.emitMessage(message);
    });

    console.log('[Telegram] Handler started');
  }

  async stop(): Promise<void> {
    if (this.bot) {
      this.bot.stopPolling();
      this.bot = undefined;
    }
  }

  async sendMessage(response: GatewayResponse): Promise<void> {
    if (!this.bot) return;

    const options: TelegramBot.SendMessageOptions = {};
    if (response.replyTo) {
      options.reply_to_message_id = parseInt(response.replyTo);
    }

    await this.bot.sendMessage(response.chatId, response.text, options);
  }
}
