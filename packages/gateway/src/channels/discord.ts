import { ActionRowBuilder, ButtonBuilder, ButtonStyle, Client, GatewayIntentBits, Interaction, Message, TextChannel } from 'discord.js';
import { BaseChannelHandler } from './base';
import { UserMessage, GatewayResponse, ChatRoute } from '@codey/core';

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

    this.client.on('interactionCreate', async (interaction: Interaction) => {
      if (!interaction.isButton()) return;
      const m = interaction.customId.match(/^ask_user:(\d+)$/);
      if (!m) return;
      const idx = parseInt(m[1], 10);
      const text = String(idx + 1); // digit form; gateway maps via lastAskedOptions/pendingTeam.options
      await interaction.update({ components: [] }).catch(() => { /* already updated */ });
      this.emitMessage({
        id: `dc-${interaction.id}`,
        channel: 'discord',
        userId: interaction.user.id,
        username: interaction.user.username,
        chatId: interaction.channelId,
        text,
        timestamp: Date.now(),
      });
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
      const components: ActionRowBuilder<ButtonBuilder>[] = [];
      if (response.choices && response.choices.length > 0) {
        const buttons = response.choices.slice(0, 25).map((label, idx) =>
          new ButtonBuilder()
            .setCustomId(`ask_user:${idx}`)
            .setLabel(label.length > 80 ? label.slice(0, 77) + '…' : label)
            .setStyle(ButtonStyle.Secondary)
        );
        for (let i = 0; i < buttons.length; i += 5) {
          const row = new ActionRowBuilder<ButtonBuilder>().addComponents(buttons.slice(i, i + 5));
          components.push(row);
        }
      }
      await channel.send({ content: response.text, components });
    }
  }

  async sendToRoute(route: ChatRoute, text: string): Promise<void> {
    if (route.channel !== 'discord' || !this.client) return;
    const channel = await this.client.channels.fetch(route.channelChatId).catch(() => null);
    if (channel && channel instanceof TextChannel) {
      await channel.send(text);
    }
  }
}
