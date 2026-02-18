import { Client, GatewayIntentBits, Message, TextChannel } from 'discord.js';
import { BaseChannelHandler } from './base';
import { UserMessage, GatewayResponse } from '../types';

export class DiscordHandler extends BaseChannelHandler {
  name = 'discord';
  private client?: Client;
  private config?: { botToken: string };

  async start(config: { botToken: string }): Promise<void> {
    this.config = config;
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
    });

    this.client.once('ready', () => {
      console.log(`[Discord] Logged in as ${this.client?.user?.tag}`);
    });

    this.client.on('messageCreate', (msg: Message) => {
      if (msg.author.bot) return;
      if (!msg.content) return;

      const message: UserMessage = {
        id: msg.id,
        channel: 'discord',
        userId: msg.author.id,
        username: msg.author.username,
        chatId: msg.channelId,
        text: msg.content,
        timestamp: msg.createdTimestamp,
      };

      this.emitMessage(message);
    });

    await this.client.login(config.botToken);
  }

  async stop(): Promise<void> {
    if (this.client) {
      this.client.destroy();
      this.client = undefined;
    }
  }

  async sendMessage(response: GatewayResponse): Promise<void> {
    if (!this.client) return;

    const channel = await this.client.channels.fetch(response.chatId);
    if (channel && channel instanceof TextChannel) {
      await channel.send(response.text);
    }
  }
}
