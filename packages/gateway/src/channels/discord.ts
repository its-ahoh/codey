import { ActionRowBuilder, ButtonBuilder, ButtonStyle, Client, GatewayIntentBits, Interaction, Message, TextChannel } from 'discord.js';
import { BaseChannelHandler } from './base';
import { UserMessage, GatewayResponse, ChatRoute, FileAttachment } from '@codey/core';

export class DiscordHandler extends BaseChannelHandler {
  name = 'discord';
  private client?: Client;
  private config?: { botToken: string };
  private lastChoiceMessageByChannel = new Map<string, string>(); // channelId → messageId

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

    const channelId = response.chatId;
    const channel = await this.client.channels.fetch(channelId);
    if (channel && channel instanceof TextChannel) {
      // Clear stale choice buttons from the previous bot message (if any)
      const prior = this.lastChoiceMessageByChannel.get(channelId);
      if (prior) {
        try {
          const msg = await channel.messages.fetch(prior);
          await msg.edit({ components: [] });
        } catch { /* deleted or too old */ }
        this.lastChoiceMessageByChannel.delete(channelId);
      }

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
      const sent = await channel.send({ content: response.text, components });
      // Track this message so the next sendMessage can clear its buttons if the user
      // types a free-text reply instead of clicking
      if (response.choices && response.choices.length > 0) {
        this.lastChoiceMessageByChannel.set(channelId, sent.id);
      }
    }
  }

  async sendToRoute(route: ChatRoute, text: string): Promise<void> {
    if (route.channel !== 'discord' || !this.client || !route.channelChatId) return;
    const channel = await this.client.channels.fetch(route.channelChatId).catch(() => null);
    if (channel && channel instanceof TextChannel) {
      await channel.send(text);
    }
  }

  async sendImages(target: string, images: FileAttachment[]): Promise<string[]> {
    const names = images.map(i => i.name);
    if (!this.client) return names;
    const channel = await this.client.channels.fetch(target).catch(() => null);
    if (!(channel instanceof TextChannel)) return names;
    const send = async (batch: FileAttachment[]): Promise<boolean> => {
      try {
        await channel.send({ files: batch.map(i => ({ attachment: i.path, name: i.name })) });
        return true;
      } catch {
        return false;
      }
    };
    const failed: string[] = [];
    for (const batch of batchAttachments(images)) {
      if (await send(batch)) continue;
      // One oversized or rejected file should not sink the rest of its batch.
      if (batch.length === 1) { failed.push(batch[0].name); continue; }
      for (const img of batch) {
        if (!(await send([img]))) failed.push(img.name);
      }
    }
    return failed;
  }
}

/** Discord caps a message at 10 attachments and limits the total upload size. */
const MAX_FILES_PER_MESSAGE = 10;
const MAX_BYTES_PER_MESSAGE = 8 * 1024 * 1024;

/**
 * Groups images into batches of at most 10 files whose summed size stays
 * within 8 MiB. A single file larger than the cap goes alone in its own batch.
 */
export function batchAttachments(images: FileAttachment[]): FileAttachment[][] {
  const batches: FileAttachment[][] = [];
  let current: FileAttachment[] = [];
  let bytes = 0;
  for (const img of images) {
    const full = current.length >= MAX_FILES_PER_MESSAGE || bytes + img.size > MAX_BYTES_PER_MESSAGE;
    if (current.length > 0 && full) {
      batches.push(current);
      current = [];
      bytes = 0;
    }
    current.push(img);
    bytes += img.size;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}
