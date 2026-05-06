import { ChatRoute } from './route';

export interface FileAttachment {
  id: string;
  name: string;        // original filename
  path: string;        // absolute path on disk after save
  mimeType: string;    // e.g. "image/png", "text/typescript"
  size: number;        // bytes
}

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
  attachments?: FileAttachment[];
  toolCalls?: ToolCallEntry[];
  isComplete?: boolean;
  /** Total tokens for the assistant response, set when the turn completes. */
  tokens?: number;
  /** Wall-clock seconds the agent took to produce the response. */
  durationSec?: number;
}

export type ChatSelection =
  | { type: 'none'; name?: string }
  | { type: 'worker'; name: string }
  /** `name` identifies which team to run. Optional only for backward compat with chats persisted before per-team selection landed; the UI always sets it. */
  | { type: 'team'; name?: string };

export interface Chat {
  id: string;
  title: string;
  workspaceName: string;
  selection: ChatSelection;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
  /** Per-chat coding agent override. Falls back to gateway default when unset. */
  agent?: 'claude-code' | 'opencode' | 'codex';
  /** Per-chat model override (model id from the global catalog). Falls back to the agent's default model when unset. */
  model?: string;
  /** Attached channel routes. Absent or empty means Mac-only. */
  routes?: ChatRoute[];
}
