// Minimal logger interface so core modules can accept a logger without
// depending on the gateway Logger class.
export interface CoreLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

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
  conversationId?: string;
}

// Response to send back to user
export interface GatewayResponse {
  chatId: string;
  channel: ChannelType;
  text: string;
  replyTo?: string;
  /** When present, the response is asking the user to pick from these options. */
  choices?: string[];
}

// Coding agent types
export type CodingAgent = 'claude-code' | 'opencode' | 'codex';

// Model configuration for agents
export type ApiType = 'anthropic' | 'openai';

/**
 * A reusable API key entry — credentials + endpoints stored once and
 * referenced from any number of ModelEntry rows by name. Lets a single
 * key power multiple models without duplication.
 *
 * A single entry can hold both an Anthropic-style and an OpenAI-style
 * endpoint with the same bearer token (useful for proxy services and
 * hybrid setups that expose both protocol variants). The resolver picks
 * `anthropicBaseUrl` or `openaiBaseUrl` based on the *model's* apiType,
 * so one key can service any model regardless of its protocol.
 */
export interface ApiKeyEntry {
  name: string;                  // unique id, surfaced in the model dropdown
  apiKey: string;                // required — shared bearer token
  anthropicBaseUrl?: string;     // optional override for anthropic-typed models
  openaiBaseUrl?: string;        // optional override for openai-typed models
}

export interface ModelConfig {
  provider: string;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  /**
   * Which environment-variable style the spawned CLI expects.
   * anthropic → ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN
   * openai   → OPENAI_BASE_URL   + OPENAI_API_KEY
   * Inferred from the referenced ModelEntry in gateway.json.
   */
  apiType?: ApiType;
}

/**
 * A reusable model definition the user manages in Settings.
 * The `model` field is both the identifier agent.defaultModel points
 * at and the string passed to the CLI as --model. `apiKeyRef` names an
 * ApiKeyEntry that supplies the credentials at run time. When unset, the
 * adapter falls back to its default environment variables.
 */
export interface ModelEntry {
  apiType: ApiType;
  model: string;
  apiKeyRef?: string;   // name of an ApiKeyEntry in the gateway's apiKeys catalog
  provider?: string;    // optional human label (anthropic, minimax, openai, …)
}

export interface FallbackEntry {
  agent: CodingAgent;
  /**
   * Optional model id from the global ModelEntry catalog. When omitted, the
   * gateway resolves the agent's defaultModel at run time. Two entries with
   * the same agent but different models are valid (e.g. claude-code with
   * sonnet → claude-code with haiku).
   */
  model?: string;
}

export interface FallbackConfig {
  enabled: boolean;
  order: FallbackEntry[];
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
  /**
   * Resume an existing CLI session by id. When set, the gateway has decided
   * conversation history lives in the CLI session, so `prompt` should carry
   * only the current user turn. Mutually exclusive with `newSessionId`.
   */
  resumeSessionId?: string;
  /**
   * Pre-allocated UUID for a fresh CLI session. The adapter passes this to
   * the CLI's session-id flag so the gateway can resume on later turns
   * without waiting for the CLI to emit one. Mutually exclusive with
   * `resumeSessionId`.
   */
  newSessionId?: string;
  /**
   * Optional abort signal. When triggered, the adapter kills the spawned CLI
   * process and resolves with a non-success response so callers can surface
   * the cancellation to the user.
   */
  signal?: AbortSignal;
  /**
   * Extra environment variables to pass through to the spawned CLI. Populated
   * by AgentFactory from per-agent settings; adapters merge these on top of
   * applyModelEnv so users can override credentials or inject CLI-specific
   * vars (e.g. CLAUDE_CONFIG_DIR, OPENAI_ORG) without touching the agent code.
   */
  extraEnv?: Record<string, string>;
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
  /**
   * Session id captured from the CLI on this run when the CLI generates
   * its own id (codex `thread_id`, opencode `sessionID`). Adapters that
   * accept a pre-allocated `newSessionId` (claude-code) leave this unset —
   * the gateway already knows the id it sent.
   */
  sessionId?: string;
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

// Advisor configuration — routing/orchestration LLM used by /team and
// dispatch:auto. Replaces the old `dispatcher` and `planner` blocks.
export interface AdvisorSettings {
  /** Coding agent to use for advisor decisions. Defaults to gateway default. */
  agent?: CodingAgent;
  /** Model name (must exist in the global model catalog). Defaults to default agent's default model. */
  model?: string;
}

// Aide configuration — lightweight global LLM for housekeeping tasks
// (chat summarization, title generation, classification). Recommend a small
// fast model (e.g. Haiku) here. Falls back to the gateway default agent +
// model when either field is unset.
export interface AideSettings {
  /** Coding agent to use for Aide calls. Defaults to gateway default. */
  agent?: CodingAgent;
  /** Model name (must exist in the global model catalog). Defaults to default agent's default model. */
  model?: string;
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
  /** Global model catalog — mirrors GatewayConfigJson.models. */
  models?: ModelEntry[];
  /** Fallback config — mirrors GatewayConfigJson.fallback. */
  fallback?: FallbackConfig;
  rateLimitMs?: number; // Rate limit in ms (default: 3000)
  context?: ContextSettings;
  memory?: MemorySettings;
  /** Advisor (team manager / auto-dispatcher) settings. */
  advisor?: AdvisorSettings;
  /** Aide (lightweight housekeeping LLM) settings. */
  aide?: AideSettings;
}

export * from './chat';
export * from './route';
export * from './pending-team';
