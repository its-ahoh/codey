import * as fs from 'fs';
import * as path from 'path';
import { EventEmitter } from 'events';
import { FallbackConfig, ModelEntry } from '@codey/core';

// ── Configuration types ─────────────────────────────────────────────

export interface GatewayConfigJson {
  gateway: {
    port: number;
    defaultAgent: string;
  };
  channels: {
    telegram?: { enabled: boolean; botToken: string; notifyChatId?: string };
    discord?: { enabled: boolean; botToken: string };
    imessage?: { enabled: boolean };
  };
  /** Agent enablement and which model each agent should use by default. */
  agents: {
    'claude-code'?: AgentSlot;
    'opencode'?: AgentSlot;
    'codex'?: AgentSlot;
  };
  /** Global, reusable model catalog. Each agent references an entry by name. */
  models: ModelEntry[];
  /** Fallback behaviour when the selected agent fails. */
  fallback: FallbackConfig;
  dev: {
    logLevel: 'debug' | 'info' | 'warn' | 'error';
    logFile?: string;
  };
}

export interface AgentSlot {
  enabled?: boolean;
  /** Name of a ModelEntry in the global models[] array. */
  defaultModel?: string;
}

// ── ConfigManager ────────────────────────────────────────────────────

export class ConfigManager extends EventEmitter {
  private config: GatewayConfigJson;
  private configPath: string;

  constructor(configPath?: string) {
    super();
    this.configPath = configPath || path.join(process.cwd(), 'gateway.json');
    this.config = this.loadConfig();
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

  save(): void {
    try {
      fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2));
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
    this.save();
  }

  get(): GatewayConfigJson { return this.config; }

  // ── Gateway settings ───────────────────────────────────────────────
  getPort(): number { return this.config.gateway.port; }
  getDefaultAgent(): string { return this.config.gateway.defaultAgent; }

  setDefaultAgent(agent: string): void {
    this.config.gateway.defaultAgent = agent;
    this.save();
  }

  // ── Model catalog ──────────────────────────────────────────────────
  listModels(): ModelEntry[] { return this.config.models ?? []; }

  getModel(name: string): ModelEntry | undefined {
    return this.config.models?.find(m => m.name === name);
  }

  saveModel(entry: ModelEntry): void {
    const idx = this.config.models.findIndex(m => m.name === entry.name);
    if (idx >= 0) this.config.models[idx] = entry;
    else this.config.models.push(entry);
    this.save();
  }

  deleteModel(name: string): boolean {
    const before = this.config.models.length;
    this.config.models = this.config.models.filter(m => m.name !== name);
    // If any agent referenced the deleted model, clear it
    for (const agent of Object.keys(this.config.agents) as (keyof typeof this.config.agents)[]) {
      const slot = this.config.agents[agent];
      if (slot && slot.defaultModel === name) slot.defaultModel = undefined;
    }
    if (this.config.models.length !== before) {
      this.save();
      return true;
    }
    return false;
  }

  /** Returns the ModelEntry referenced by the agent's defaultModel. */
  getAgentModel(agent: string): ModelEntry | undefined {
    const slot = this.config.agents[agent as keyof typeof this.config.agents];
    if (!slot?.defaultModel) return undefined;
    return this.getModel(slot.defaultModel);
  }

  getDefaultModel(): string {
    const agent = this.config.gateway.defaultAgent;
    return this.getAgentModel(agent)?.model ?? '';
  }

  setAgentModel(agent: string, modelName: string): void {
    const slot = this.config.agents[agent as keyof typeof this.config.agents];
    if (slot) {
      slot.defaultModel = modelName;
      this.save();
    }
  }

  // ── Fallback config ────────────────────────────────────────────────
  getFallback(): FallbackConfig { return this.config.fallback; }

  setFallback(fb: FallbackConfig): void {
    this.config.fallback = fb;
    this.save();
  }

  // ── Agent config ───────────────────────────────────────────────────
  getAgentConfig(agent: string): AgentSlot | undefined {
    return this.config.agents[agent as keyof typeof this.config.agents];
  }

  setAgentEnabled(agent: string, enabled: boolean): void {
    const slot = this.config.agents[agent as keyof typeof this.config.agents] ?? {};
    slot.enabled = enabled;
    this.config.agents[agent as keyof typeof this.config.agents] = slot;
    this.save();
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
    console.log(`  Default Agent: ${this.config.gateway.defaultAgent}`);
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
      console.log(`  • ${m.name} [${m.apiType}] → ${m.model}${urlHint}${keyHint}`);
    }
    console.log(`\nAgents:`);
    for (const a of ['claude-code', 'opencode', 'codex'] as const) {
      const slot = this.config.agents[a];
      const on = slot?.enabled !== false;
      console.log(`  ${on ? '✅' : '❌'} ${a} → ${slot?.defaultModel || '(no model)'}`);
    }
    console.log(`\nFallback: ${this.config.fallback.enabled ? '✅' : '❌'} order=${this.config.fallback.order.join(' → ')}`);
    console.log(`\nDev:\n  Log Level: ${this.config.dev.logLevel}`);
    console.log('─'.repeat(40) + '\n');
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

function getDefaultConfig(): GatewayConfigJson {
  return {
    gateway: { port: 3000, defaultAgent: 'claude-code' },
    channels: {
      telegram: { enabled: false, botToken: '' },
      discord: { enabled: false, botToken: '' },
      imessage: { enabled: false },
    },
    agents: {
      'claude-code': { enabled: true, defaultModel: 'sonnet-4-5' },
      'opencode':    { enabled: true, defaultModel: 'gpt-5' },
      'codex':       { enabled: true, defaultModel: 'gpt-5' },
    },
    models: [
      { name: 'sonnet-4-5', apiType: 'anthropic', model: 'claude-sonnet-4-5', provider: 'anthropic' },
      { name: 'opus-4-1',   apiType: 'anthropic', model: 'claude-opus-4-1',   provider: 'anthropic' },
      { name: 'haiku-4-5',  apiType: 'anthropic', model: 'claude-haiku-4-5',  provider: 'anthropic' },
      { name: 'gpt-5',      apiType: 'openai',    model: 'gpt-5',             provider: 'openai' },
    ],
    fallback: { enabled: true, order: ['claude-code', 'opencode', 'codex'] },
    dev: { logLevel: 'info' },
  };
}

/** Fill in any missing top-level fields with defaults so downstream code can assume shape. */
function normalize(raw: Partial<GatewayConfigJson>): GatewayConfigJson {
  const defaults = getDefaultConfig();
  return {
    gateway: { ...defaults.gateway, ...(raw.gateway ?? {}) },
    channels: raw.channels ?? defaults.channels,
    agents: { ...defaults.agents, ...(raw.agents ?? {}) },
    models: Array.isArray(raw.models) ? raw.models : defaults.models,
    fallback: raw.fallback ?? defaults.fallback,
    dev: raw.dev ?? defaults.dev,
  };
}
