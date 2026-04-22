// Channel type
export type ChannelType = 'telegram' | 'discord' | 'imessage' | 'tui';

// Message from a user
export interface UserMessage {
  id: string;
  channel: ChannelType;
  userId: string;
  username: string;
  chatId: string;
  text: string;
  timestamp: number;
}

// Response to send back to user
export interface GatewayResponse {
  chatId: string;
  channel: ChannelType;
  text: string;
  replyTo?: string;
}

// Coding agent types
export type CodingAgent = 'claude-code' | 'opencode' | 'codex';

// Model configuration for agents
export interface ModelConfig {
  provider: string;
  model: string;
  apiKey?: string;
  baseUrl?: string;
}

export interface AgentRequest {
  prompt: string;
  agent: CodingAgent;
  model?: ModelConfig;
  timeout?: number;
  interactive?: boolean;
  onStream?: (text: string) => void;
  onStatus?: (update: StatusUpdate) => void;
  context?: {
    files?: string[];
    workingDir?: string;
  };
}

export interface StatusUpdate {
  type: 'tool_start' | 'tool_end' | 'info';
  tool?: string;
  message: string;
  input?: Record<string, unknown>;
  output?: string;
}

export interface AgentStateEntry {
  source: string;
  status?: string;
  input?: Record<string, unknown>;
  output?: unknown;
}

export interface AgentResponse {
  success: boolean;
  output: string;
  error?: string;
  tokens?: {
    total: number;
    input: number;
    output: number;
    reasoning?: number;
    cache?: {
      read: number;
      write: number;
    };
  };
  duration?: number; // in seconds
  statusUpdates?: string[];
  states?: AgentStateEntry[];
}

// Channel configuration
export interface ChannelConfig {
  telegram?: {
    botToken: string;
    notifyChatId?: string;
  };
  discord?: {
    botToken: string;
    guildId?: string;
  };
  imessage?: {
    enabled: boolean;
  };
}

// Per-agent model configuration
export interface AgentModelConfig {
  enabled?: boolean;
  provider?: 'anthropic' | 'openai' | 'google';
  defaultModel?: string;
  models?: string[];  // model names only, provider determined by agent.provider
}

// Planner configuration
export interface PlannerSettings {
  enabled?: boolean;
  model?: string;
  maxTokens?: number;
  minPromptLength?: number;
}

// Context configuration
export interface ContextSettings {
  maxTokenBudget?: number;
  maxTurns?: number;
  ttlMinutes?: number;
}

// Memory configuration
export interface MemorySettings {
  enabled?: boolean;
  autoExtract?: boolean;
  maxAutoMemories?: number;
}

// Gateway configuration
export interface GatewayConfig {
  port: number;
  channels: ChannelConfig;
  defaultAgent: CodingAgent;
  agents?: {
    'claude-code'?: AgentModelConfig;
    'opencode'?: AgentModelConfig;
    'codex'?: AgentModelConfig;
  };
  rateLimitMs?: number; // Rate limit in ms (default: 3000)
  planner?: PlannerSettings;
  context?: ContextSettings;
  memory?: MemorySettings;
}
