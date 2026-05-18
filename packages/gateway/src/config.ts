import * as fs from 'fs';
import * as path from 'path';
import { EventEmitter } from 'events';
import { CodingAgent, FallbackConfig, FallbackEntry, ModelEntry, TeamConfigRaw } from '@codey/core';

// ── Configuration types ─────────────────────────────────────────────

export interface GatewayConfigJson {
  gateway: {
    port: number;
  };
  channels: {
    telegram?: { enabled: boolean; botToken: string; notifyChatId?: string };
    discord?: { enabled: boolean; botToken: string };
    imessage?: { enabled: boolean };
  };
  /**
   * Reserved per-agent settings slot. Currently empty — enablement is derived
   * from membership in `fallback.order`, and per-agent default model lives on
   * those fallback entries. Kept in the schema for forward compatibility so
   * future per-agent options (custom env vars, timeouts, …) have a home.
   */
  agents: {
    'claude-code'?: AgentSlot;
    'opencode'?: AgentSlot;
    'codex'?: AgentSlot;
  };
  /** Global, reusable model catalog. Each agent references an entry by name. */
  models: ModelEntry[];
  /**
   * Ordered priority list. `order[0]` is the canonical default agent+model;
   * subsequent entries are tried only when an earlier one fails (and only if
   * `enabled` is true). One source of truth for both "which agent runs by
   * default" and "what to try after a failure".
   */
  fallback: FallbackConfig;
  dev: {
    logLevel: 'debug' | 'info' | 'warn' | 'error';
    logFile?: string;
  };
  /** See GatewayConfig.dispatcher in @codey/core types. Optional. */
  dispatcher?: {
    agent?: CodingAgent;
    model?: string;
  };
  /**
   * Global team library. Each entry maps a team name to its members + dispatch
   * mode. Workspaces opt into teams by listing their names in workspace.json's
   * `teams: string[]` field.
   */
  teams?: Record<string, TeamConfigRaw>;
  /** Voice input helper (native macOS app) configuration. */
  voice?: {
    enabled: boolean;
    hotkey: string;
    language: string;
    injection: 'paste' | 'ax';
    /** Transcription backend: hosted API or on-device WhisperKit. */
    provider: 'api' | 'local';
    /** Base URL of an OpenAI-compatible transcription endpoint (e.g. https://api.openai.com/v1). */
    apiUrl: string;
    /** Bearer token for the API endpoint. */
    apiKey: string;
    /** Model identifier sent to the API (e.g. whisper-1). */
    apiModel: string;
    /** WhisperKit model variant for local mode (e.g. openai_whisper-large-v3-turbo). */
    localModel: string;
  };
}

/** Reserved for future per-agent settings. Currently empty. */
export type AgentSlot = Record<string, never>;

// ── ConfigManager ────────────────────────────────────────────────────

export class ConfigManager extends EventEmitter {
  private config: GatewayConfigJson;
  private configPath: string;
  private watcher?: fs.FSWatcher;
  private lastSerialized: string = '';
  private reloadTimer?: NodeJS.Timeout;

  constructor(configPath?: string) {
    super();
    this.configPath = configPath || path.join(process.cwd(), 'gateway.json');
    this.config = this.loadConfig();
    this.lastSerialized = JSON.stringify(this.config);
    this.startWatching();
  }

  private loadConfig(): GatewayConfigJson {
    try {
      if (fs.existsSync(this.configPath)) {
        const data = fs.readFileSync(this.configPath, 'utf-8');
        return normalize(JSON.parse(data));
      }
    } catch (error) {
      console.error('[Config] Error loading config:', error);
    }
    return getDefaultConfig();
  }

  private startWatching(): void {
    try {
      this.watcher = fs.watch(this.configPath, { persistent: false }, () => {
        if (this.reloadTimer) clearTimeout(this.reloadTimer);
        this.reloadTimer = setTimeout(() => this.reloadFromDisk(), 150);
      });
      this.watcher.on('error', err => console.error('[Config] watch error:', err));
    } catch (err) {
      console.error('[Config] failed to watch', this.configPath, err);
    }
  }

  private reloadFromDisk(): void {
    try {
      if (!fs.existsSync(this.configPath)) return;
      const data = fs.readFileSync(this.configPath, 'utf-8');
      const next = normalize(JSON.parse(data));
      const serialized = JSON.stringify(next);
      if (serialized === this.lastSerialized) return;
      this.config = next;
      this.lastSerialized = serialized;
      console.log('[Config] Reloaded from disk');
      this.emit('change', this.config);
    } catch (err) {
      console.error('[Config] reload failed:', err);
    }
  }

  /** Stop the fs.watch handle (call on shutdown). */
  stop(): void {
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    this.watcher?.close();
    this.watcher = undefined;
  }

  save(): void {
    try {
      const serialized = JSON.stringify(this.config, null, 2);
      fs.writeFileSync(this.configPath, serialized);
      this.lastSerialized = JSON.stringify(this.config);
      console.log('[Config] Saved to', this.configPath);
      this.emit('change', this.config);
    } catch (error) {
      console.error('[Config] Error saving config:', error);
    }
  }

  /** Bulk update from external source (e.g. renderer IPC). Merges, saves, emits change. */
  update(partial: Partial<GatewayConfigJson>): void {
    if (partial.gateway) Object.assign(this.config.gateway, partial.gateway);
    if (partial.channels) Object.assign(this.config.channels, partial.channels);
    if (partial.agents) Object.assign(this.config.agents, partial.agents);
    if (partial.dev) Object.assign(this.config.dev, partial.dev);
    if (partial.models !== undefined) this.config.models = partial.models;
    if (partial.fallback !== undefined) this.config.fallback = partial.fallback;
    if (partial.dispatcher !== undefined) this.config.dispatcher = partial.dispatcher;
    if (partial.teams !== undefined) this.config.teams = partial.teams;
    if (partial.voice !== undefined) this.config.voice = partial.voice;
    this.save();
  }

  get(): GatewayConfigJson { return this.config; }

  // ── Gateway settings ───────────────────────────────────────────────
  getPort(): number { return this.config.gateway.port; }

  /** Canonical default = first entry in fallback.order. */
  getDefaultAgent(): CodingAgent {
    return (this.config.fallback.order[0]?.agent ?? 'claude-code') as CodingAgent;
  }

  /**
   * Promote (or insert) `agent` to position 0 of fallback.order. The previous
   * position-0 entry slides down — it remains in the priority list as the
   * primary fallback step, which matches user intent ("I want X first, but
   * keep what I had before as backup").
   */
  setDefaultAgent(agent: string): void {
    if (!KNOWN_AGENTS.has(agent as CodingAgent)) return;
    const existing = this.config.fallback.order.findIndex(e => e.agent === agent);
    if (existing === 0) return;
    if (existing > 0) {
      const [entry] = this.config.fallback.order.splice(existing, 1);
      this.config.fallback.order.unshift(entry);
    } else {
      this.config.fallback.order.unshift({ agent: agent as CodingAgent });
    }
    this.save();
  }

  // ── Model catalog ──────────────────────────────────────────────────
  // Models are keyed by the `model` field — the same string passed to
  // the CLI as --model. agent.defaultModel references a model by id.

  listModels(): ModelEntry[] { return this.config.models ?? []; }

  getModel(modelId: string): ModelEntry | undefined {
    return this.config.models?.find(m => m.model === modelId);
  }

  saveModel(entry: ModelEntry): void {
    const idx = this.config.models.findIndex(m => m.model === entry.model);
    if (idx >= 0) this.config.models[idx] = entry;
    else this.config.models.push(entry);
    this.save();
  }

  /**
   * Change a model entry's identifier and rewrite every fallback entry that
   * pointed at it. Content (apiType, baseUrl, apiKey) is preserved.
   */
  renameModel(oldId: string, newId: string): boolean {
    if (!newId.trim() || oldId === newId) return false;
    if (this.config.models.some(m => m.model === newId)) {
      throw new Error(`A model with id "${newId}" already exists`);
    }
    const idx = this.config.models.findIndex(m => m.model === oldId);
    if (idx < 0) return false;
    this.config.models[idx] = { ...this.config.models[idx], model: newId };
    for (const entry of this.config.fallback.order) {
      if (entry.model === oldId) entry.model = newId;
    }
    this.save();
    return true;
  }

  deleteModel(modelId: string): boolean {
    const before = this.config.models.length;
    this.config.models = this.config.models.filter(m => m.model !== modelId);
    for (const entry of this.config.fallback.order) {
      if (entry.model === modelId) entry.model = undefined;
    }
    if (this.config.models.length !== before) {
      this.save();
      return true;
    }
    return false;
  }

  /** First fallback entry for `agent` that pins a model — that's the agent's default. */
  getAgentModel(agent: string): ModelEntry | undefined {
    const entry = this.config.fallback.order.find(e => e.agent === agent && e.model);
    if (!entry?.model) return undefined;
    return this.getModel(entry.model);
  }

  /** Resolved default model id (the model on fallback.order[0], if any). */
  getDefaultModel(): string {
    return this.config.fallback.order[0]?.model ?? '';
  }

  /**
   * Set the default model for `agent`. Updates the first fallback entry for
   * that agent in place, or inserts one. When the agent is the current default
   * (position 0), the new model becomes the gateway-wide default model too.
   */
  setAgentModel(agent: string, modelId: string): void {
    if (!KNOWN_AGENTS.has(agent as CodingAgent)) return;
    const idx = this.config.fallback.order.findIndex(e => e.agent === agent);
    if (idx >= 0) {
      this.config.fallback.order[idx] = { agent: agent as CodingAgent, model: modelId || undefined };
    } else {
      this.config.fallback.order.push({ agent: agent as CodingAgent, model: modelId || undefined });
    }
    this.save();
  }

  // ── Global teams ───────────────────────────────────────────────────
  getTeams(): Record<string, TeamConfigRaw> { return this.config.teams ?? {}; }

  setTeams(teams: Record<string, TeamConfigRaw>): void {
    this.config.teams = teams || {};
    this.save();
  }

  // ── Fallback config ────────────────────────────────────────────────
  getFallback(): FallbackConfig { return this.config.fallback; }

  /**
   * Accepts either the canonical FallbackConfig or a legacy
   * `{ enabled, order: string[] }` payload (still sent by older UI clients).
   * Both shapes are normalized to FallbackEntry[] before being persisted.
   */
  setFallback(fb: { enabled?: boolean; order?: Array<FallbackEntry | CodingAgent | string> }): void {
    this.config.fallback = normalizeFallback(fb, this.config.fallback);
    this.save();
  }

  // ── Agent config ───────────────────────────────────────────────────
  getAgentConfig(agent: string): AgentSlot | undefined {
    return this.config.agents[agent as keyof typeof this.config.agents];
  }


  // ── Channels ───────────────────────────────────────────────────────
  getTelegramConfig() { return this.config.channels.telegram; }
  getDiscordConfig() { return this.config.channels.discord; }

  setTelegramToken(token: string): void {
    if (!this.config.channels.telegram) this.config.channels.telegram = { enabled: false, botToken: '' };
    this.config.channels.telegram.botToken = token;
    this.save();
  }

  setDiscordToken(token: string): void {
    if (!this.config.channels.discord) this.config.channels.discord = { enabled: false, botToken: '' };
    this.config.channels.discord.botToken = token;
    this.save();
  }

  enableChannel(channel: 'telegram' | 'discord' | 'imessage'): void {
    if (channel === 'telegram' && this.config.channels.telegram) this.config.channels.telegram.enabled = true;
    else if (channel === 'discord' && this.config.channels.discord) this.config.channels.discord.enabled = true;
    else if (channel === 'imessage') this.config.channels.imessage = { enabled: true };
    this.save();
  }

  disableChannel(channel: 'telegram' | 'discord' | 'imessage'): void {
    if (channel === 'telegram' && this.config.channels.telegram) this.config.channels.telegram.enabled = false;
    else if (channel === 'discord' && this.config.channels.discord) this.config.channels.discord.enabled = false;
    else if (channel === 'imessage' && this.config.channels.imessage) this.config.channels.imessage.enabled = false;
    this.save();
  }

  // ── Dev settings ───────────────────────────────────────────────────
  getLogLevel(): string { return this.config.dev.logLevel; }

  setLogLevel(level: 'debug' | 'info' | 'warn' | 'error'): void {
    this.config.dev.logLevel = level;
    this.save();
  }

  printConfig(): void {
    console.log('\n📋 Current Configuration:');
    console.log('─'.repeat(40));
    console.log('Gateway:');
    console.log(`  Default Agent: ${this.getDefaultAgent()}`);
    console.log(`  Default Model: ${this.getDefaultModel() || '(none)'}`);
    console.log(`  Port: ${this.config.gateway.port}`);
    console.log('\nChannels:');
    console.log(`  Telegram: ${this.config.channels.telegram?.enabled ? '✅' : '❌'}`);
    console.log(`  Discord: ${this.config.channels.discord?.enabled ? '✅' : '❌'}`);
    console.log(`  iMessage: ${this.config.channels.imessage?.enabled ? '✅' : '❌'}`);
    console.log(`\nModels (${this.config.models.length}):`);
    for (const m of this.config.models) {
      const keyHint = m.apiKey ? ' 🔑' : '';
      const urlHint = m.baseUrl ? ` @ ${m.baseUrl}` : '';
      console.log(`  • ${m.model} [${m.apiType}]${urlHint}${keyHint}`);
    }
    console.log(`\nAgents:`);
    const inOrder = new Set(this.config.fallback.order.map(e => e.agent));
    for (const a of ['claude-code', 'opencode', 'codex'] as const) {
      console.log(`  ${inOrder.has(a) ? '✅' : '❌'} ${a}`);
    }
    console.log(`\nPriority: ${this.config.fallback.enabled ? '✅' : '❌'} order=${formatFallbackOrder(this.config.fallback.order)}`);
    console.log(`\nDev:\n  Log Level: ${this.config.dev.logLevel}`);
    console.log('─'.repeat(40) + '\n');
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

const KNOWN_AGENTS: ReadonlySet<CodingAgent> = new Set(['claude-code', 'opencode', 'codex']);

/**
 * Coerce a raw fallback blob (legacy `string[]` order or new `FallbackEntry[]`)
 * into the canonical FallbackConfig shape. Unknown agents get dropped; missing
 * model ids are kept and validated lazily at run time so a stale model rename
 * doesn't silently delete user-configured fallback steps.
 */
export function formatFallbackOrder(order: FallbackEntry[]): string {
  return order.map(e => (e.model ? `${e.agent}(${e.model})` : e.agent)).join(' → ');
}

function normalizeFallback(raw: any, defaults: FallbackConfig): FallbackConfig {
  if (!raw || typeof raw !== 'object') return defaults;
  const order: FallbackEntry[] = Array.isArray(raw.order)
    ? raw.order
        .map((e: any): FallbackEntry | null => {
          if (typeof e === 'string') {
            return KNOWN_AGENTS.has(e as CodingAgent) ? { agent: e as CodingAgent } : null;
          }
          if (e && typeof e === 'object' && typeof e.agent === 'string' && KNOWN_AGENTS.has(e.agent)) {
            const model = typeof e.model === 'string' && e.model.length > 0 ? e.model : undefined;
            return model ? { agent: e.agent, model } : { agent: e.agent };
          }
          return null;
        })
        .filter((x: FallbackEntry | null): x is FallbackEntry => x !== null)
    : defaults.order;
  return {
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : defaults.enabled,
    order,
  };
}

function getDefaultConfig(): GatewayConfigJson {
  return {
    gateway: { port: 3000 },
    channels: {
      telegram: { enabled: false, botToken: '' },
      discord: { enabled: false, botToken: '' },
      imessage: { enabled: false },
    },
    agents: {
      'claude-code': {},
      'opencode':    {},
      'codex':       {},
    },
    models: [
      { apiType: 'anthropic', model: 'claude-sonnet-4-5', provider: 'anthropic' },
      { apiType: 'anthropic', model: 'claude-opus-4-1',   provider: 'anthropic' },
      { apiType: 'anthropic', model: 'claude-haiku-4-5',  provider: 'anthropic' },
      { apiType: 'openai',    model: 'gpt-5',             provider: 'openai' },
    ],
    fallback: {
      enabled: true,
      order: [
        { agent: 'claude-code', model: 'claude-sonnet-4-5' },
        { agent: 'opencode',    model: 'gpt-5' },
        { agent: 'codex',       model: 'gpt-5' },
      ],
    },
    dev: { logLevel: 'info' },
  };
}

/** Fill in any missing top-level fields with defaults so downstream code can assume shape. */
function normalize(raw: Partial<GatewayConfigJson>): GatewayConfigJson {
  const defaults = getDefaultConfig();
  const out: GatewayConfigJson = {
    gateway: { ...defaults.gateway, ...(raw.gateway ?? {}) },
    channels: raw.channels ?? defaults.channels,
    agents: { ...defaults.agents, ...(raw.agents ?? {}) },
    models: Array.isArray(raw.models) ? raw.models : defaults.models,
    fallback: normalizeFallback(raw.fallback, defaults.fallback),
    dev: raw.dev ?? defaults.dev,
  };
  if (raw.dispatcher && typeof raw.dispatcher === 'object') {
    out.dispatcher = {
      agent: raw.dispatcher.agent,
      model: raw.dispatcher.model,
    };
  }
  if (raw.teams && typeof raw.teams === 'object') {
    out.teams = raw.teams as Record<string, TeamConfigRaw>;
  }
  if (raw.voice && typeof raw.voice === 'object') {
    out.voice = raw.voice;
  }
  return out;
}
