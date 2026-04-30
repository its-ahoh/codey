export type { ChatMessage, ToolCallEntry, Chat, ChatSelection, FileAttachment } from '@codey/core';

export interface GatewayStatus {
  status: string;
  uptime: number;
  messagesProcessed: number;
  errors: number;
  channels: {
    telegram: boolean;
    discord: boolean;
    imessage: boolean;
  };
}

export interface GatewayConfig {
  // Add specific fields as needed
  [key: string]: any;
}

export interface Workspace {
  name: string;
  path?: string;
}
