// Message from a user
export interface UserMessage {
  id: string;
  channel: 'telegram' | 'discord' | 'imessage';
  userId: string;
  username: string;
  chatId: string;
  text: string;
  timestamp: number;
}

// Response to send back to user
export interface GatewayResponse {
  chatId: string;
  channel: 'telegram' | 'discord' | 'imessage';
  text: string;
  replyTo?: string;
}

// Coding agent types
export type CodingAgent = 'claude-code' | 'opencode' | 'codex';

export interface AgentRequest {
  prompt: string;
  agent: CodingAgent;
  context?: {
    files?: string[];
    workingDir?: string;
  };
}

export interface AgentResponse {
  success: boolean;
  output: string;
  error?: string;
}

// Channel configuration
export interface ChannelConfig {
  telegram?: {
    botToken: string;
  };
  discord?: {
    botToken: string;
    guildId?: string;
  };
  imessage?: {
    enabled: boolean;
  };
}

// Gateway configuration
export interface GatewayConfig {
  port: number;
  channels: ChannelConfig;
  defaultAgent: CodingAgent;
}
