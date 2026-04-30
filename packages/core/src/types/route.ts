export type ChannelKind = 'telegram' | 'discord' | 'imessage';

export interface ChatRoute {
  channel: ChannelKind;
  /** Channel-side user identifier (e.g. Telegram user id, Discord user id, iMessage handle). */
  channelUserId: string;
  /**
   * Channel-side conversation identifier (e.g. Telegram chat id, Discord channel id).
   * For 1:1 DM channels this often equals channelUserId; we store both for clarity.
   */
  channelChatId: string;
  /** Unix ms when this route was attached. */
  attachedAt: number;
}
