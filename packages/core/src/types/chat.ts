import { ChatRoute } from './route';
import { PendingTeamState } from './pending-team';

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
  /** Option labels when this assistant message ended in [ASK_USER:choice]. */
  choices?: string[];
}

export type ChatSelection =
  | { type: 'none'; name?: string }
  | { type: 'worker'; name: string }
  /** `name` identifies which team to run. Optional only for backward compat with chats persisted before per-team selection landed; the UI always sets it. */
  | { type: 'team'; name?: string };

export type DiscussionStatus = 'running' | 'paused' | 'done' | 'terminated';
export type DiscussionTerminatedReason =
  | 'consensus'
  | 'drift'
  | 'timeout'
  | 'max_duration'
  | 'user_cancel'
  | 'manager_error';

export interface DiscussionMeta {
  teamName: string;
  status: DiscussionStatus;
  startedAt: number;
  terminatedReason?: DiscussionTerminatedReason;
}

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
  /** Set while a /team run is paused waiting for the user to answer a worker's question. */
  pendingTeam?: PendingTeamState;
  /** Per-chat preference for the right-side context panel in codey-mac.
   *  undefined = user hasn't decided; auto-open logic applies on first tool call.
   *  true/false = explicit user choice; honored verbatim. */
  contextPanelOpen?: boolean;
  /** Last unanswered choice question in a non-team chat. Cleared on next user message. */
  lastAskedOptions?: { messageId: string; options: string[] };
  /**
   * Warm CLI session for this chat. When set, the next turn for the same
   * coding agent is sent via `--resume <sessionId>` (only the new user text is
   * passed to the agent; the agent retrieves prior context from its own
   * session store). Cleared on agent switch, selection-type change, /clear,
   * or when a resume attempt fails.
   */
  sessionAnchor?: { agent: 'claude-code' | 'opencode' | 'codex'; sessionId: string };
  /**
   * Rolling LLM-generated summary of older messages. When set, the bootstrap
   * prompt prepends `summary` and only renders the transcript tail starting at
   * `summarizedUpTo`. Produced asynchronously by the Aide after appendMessage
   * crosses a threshold; never blocks a user-visible turn.
   */
  compaction?: ChatCompaction;
  /** Set when this chat is hosting a parallel-team (roundtable) discussion. */
  discussion?: DiscussionMeta;
}

export interface ChatCompaction {
  /** Summary text covering messages[0 .. summarizedUpTo - 1]. */
  summary: string;
  /** Exclusive end index — everything strictly before this is folded into `summary`. */
  summarizedUpTo: number;
  /** Model id used to produce the summary (for telemetry / future invalidation). */
  model: string;
  updatedAt: number;
}
