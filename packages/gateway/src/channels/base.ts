import { UserMessage, GatewayResponse, ChatRoute } from '@codey/core';

export interface ChannelHandler {
  name: string;
  start(config: any): Promise<void>;
  stop(): Promise<void>;
  sendMessage(response: GatewayResponse): Promise<void>;
  onMessage(callback: (message: UserMessage) => Promise<void>): void;
  streamText?(text: string): void;
  sendToRoute?(route: ChatRoute, text: string): Promise<void>;
}

// Base class for channel handlers
export abstract class BaseChannelHandler implements ChannelHandler {
  abstract name: string;
  protected messageCallback?: (message: UserMessage) => Promise<void>;

  abstract start(config: any): Promise<void>;
  abstract stop(): Promise<void>;
  abstract sendMessage(response: GatewayResponse): Promise<void>;

  onMessage(callback: (message: UserMessage) => Promise<void>): void {
    this.messageCallback = callback;
  }

  protected emitMessage(message: UserMessage): void {
    if (this.messageCallback) {
      this.messageCallback(message);
    }
  }
}

export function formatChoicesAsText(text: string, choices?: string[]): string {
  if (!choices || choices.length === 0) return text;
  const list = choices.map((c, i) => `${i + 1}) ${c}`).join('\n');
  return `${text}\n\n${list}\n\n_Reply with the number or the option text._`;
}
