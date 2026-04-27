export interface ToolCallEntry {
  id: string;
  type: 'tool_start' | 'tool_end' | 'info';
  tool?: string;
  message: string;
  input?: Record<string, unknown>;
  output?: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  toolCalls?: ToolCallEntry[];
  isComplete?: boolean;
  /** Total tokens for the assistant response, set when the turn completes. */
  tokens?: number;
  /** Wall-clock seconds the agent took to produce the response. */
  durationSec?: number;
}

export type ChatSelection =
  | { type: 'none' }
  | { type: 'worker'; name: string }
  | { type: 'team' };

export interface Chat {
  id: string;
  title: string;
  workspaceName: string;
  selection: ChatSelection;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
}
