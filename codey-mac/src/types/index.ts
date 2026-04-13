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

export interface ToolCallEntry {
  id: string;
  type: 'tool_start' | 'tool_end' | 'info';
  tool?: string;
  message: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  toolCalls?: ToolCallEntry[];
  isComplete?: boolean;
}

export interface GatewayConfig {
  // Add specific fields as needed
  [key: string]: any;
}

export interface Workspace {
  name: string;
  path?: string;
}
