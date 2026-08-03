import { GatewayResponse, UserMessage } from '@codey/core';
import { BaseChannelHandler } from './base';

/**
 * Not a real transport — there's no external service to poll or connect to.
 * This just gives `/voice/converse` a way to run a transcript through the
 * gateway's normal `handleMessage` pipeline (rate limiting, context window,
 * agent execution) and capture whatever text the agent replies with, so it
 * can be digested and spoken. Registered once, lazily, the same way
 * telegram/discord/imessage handlers are registered elsewhere in gateway.ts.
 */
export class VoiceChannelHandler extends BaseChannelHandler {
  name = 'voice';
  private pending = new Map<string, string[]>();

  async start(): Promise<void> {
    // No-op: nothing to connect to.
  }

  async stop(): Promise<void> {
    this.pending.clear();
  }

  async sendMessage(response: GatewayResponse): Promise<void> {
    const texts = this.pending.get(response.chatId);
    if (texts) texts.push(response.text);
  }

  /**
   * Runs one voice transcript through the gateway and returns whatever the
   * agent replied with (all `sendMessage` calls for this chatId, joined).
   * Empty string means the message was accepted but produced no reply
   * (e.g. a paused team question that isn't `[ASK_USER]`-shaped, or a
   * silently dropped rate-limited turn) — callers decide how to handle that.
   */
  async runMessage(message: UserMessage): Promise<string> {
    if (!this.messageCallback) {
      throw new Error('Voice channel handler is not wired to the gateway yet');
    }
    this.pending.set(message.chatId, []);
    try {
      await this.messageCallback(message);
      return (this.pending.get(message.chatId) ?? []).join('\n\n');
    } finally {
      this.pending.delete(message.chatId);
    }
  }
}
