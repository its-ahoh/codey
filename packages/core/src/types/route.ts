export type ChannelKind = 'telegram' | 'discord' | 'imessage';

export interface ChatRoute {
  channel: ChannelKind;
  /** Channel-side user identifier (e.g. Telegram from.id, Discord author.id). Used for route matching. */
  channelUserId: string;
  /** Channel-side conversation identifier (e.g. Telegram chat.id, Discord channelId). Used as send target. */
  channelChatId: string;
  /** Unix ms when this route was attached. */
  attachedAt: number;
}
