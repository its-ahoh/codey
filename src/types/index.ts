export interface GatewayConfig {
  gateway: {
    port: number;
    defaultAgent: string;
  };
  channels: {
    telegram?: { enabled: boolean; botToken: string; notifyChatId?: string };
    discord?: { enabled: boolean; botToken: string };
    imessage?: { enabled: boolean };
  };
  agents: {
    'claude-code'?: AgentConfig;
    'opencode'?: AgentConfig;
    'codex'?: AgentConfig;
  };
  apiKeys: {
    anthropic?: string;
    openai?: string;
    google?: string;
  };
  dev: {
    logLevel: 'debug' | 'info' | 'warn' | 'error';
  };
}

export interface AgentConfig {
  enabled: boolean;
  defaultModel: string;
  models: { provider: string; model: string }[];
}

export interface GatewayStatus {
  status: 'healthy' | 'degraded' | 'stopped';
  uptime: number;
  messagesProcessed: number;
  errors: number;
  channels: {
    telegram: boolean;
    discord: boolean;
    imessage: boolean;
  };
}

export interface Workspace {
  name: string;
  path: string;
  isActive: boolean;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}
