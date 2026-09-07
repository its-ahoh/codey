import * as fs from 'fs';
import * as path from 'path';
import { EventEmitter } from 'events';
import { SecretKey, SecretStore, apiKeySecret, channelSecret } from './secret-store';
import { ApiKeyEntry, CodingAgent, FallbackConfig, FallbackEntry, isApiType, McpServerSpec, ModelEntry, TeamConfigRaw, ThinkingEffort } from '@codey/core';

// ── Configuration types ─────────────────────────────────────────────

/** One user-configured external MCP server as stored in gateway.json. */
export interface ExternalMcpServerConfig {
  transport: 'stdio' | 'remote';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  enabled: boolean;
}

/** Loopback only. Exposing the HTTP server has to be an explicit choice. */
export const DEFAULT_API_BIND_HOST = '127.0.0.1';

export interface GatewayConfigJson {
  gateway: {
    port: number;
    skipPermissions?: boolean;
  };
  channels: {
    telegram?: { enabled: boolean; botToken: string };
    discord?: { enabled: boolean; botToken: string };
    imessage?: { enabled: boolean; allowedSenders?: string[]; pollIntervalMs?: number };
  };
  /**
   * Per-agent settings. Holds the agent's default reasoning effort; enablement
   * is derived from membership in `fallback.order`, and per-agent default
   * model lives on those fallback entries.
   */
  agents: {
    'claude-code'?: AgentSlot;
    'opencode'?: AgentSlot;
    'codex'?: AgentSlot;
    'pi'?: AgentSlot;
  };
  /** Global, reusable model catalog. Each agent references an entry by name. */
  models: ModelEntry[];
  /** Shared API key entries referenced by ModelEntry.apiKeyRef. */
  apiKeys: ApiKeyEntry[];
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
  /** Advisor (team advisor / auto-dispatcher) configuration. Optional. */
  advisor?: {
    agent?: CodingAgent;
    model?: string;
  };
  /**
   * Aide configuration — lightweight global LLM for housekeeping tasks
   * (chat summarization, title generation, classification). Recommend a
   * small fast model. Falls back to gateway default agent + model when
   * either field is unset.
   */
  aide?: {
    agent?: CodingAgent;
    model?: string;
  };
  /** Self-crystallizing skills configuration. All fields optional — defaults are sensible. */
  skills?: {
    enabled?: boolean;
    suggestOnRepeat?: number;
    autoApply?: boolean;
    staleDays?: number;
    weakSkillDays?: number;
    /** Model override for distillation. Falls back to advisor.model. */
    distillModel?: string;
    /** Suggest playbooks from clustered procedures instead of from an LLM's
     *  impression of recent prompts. On by default; set false to disable. */
    induction?: boolean;
  };
  /**
   * Codey's own memory: structured entries it keeps per workspace (and one
   * user-global store), injected into prompts at run time. The runtime already
   * honours these flags — they simply had no home on disk until now, so memory
   * could not be turned off.
   */
  memory?: {
    /** Inject remembered entries into prompts. Default true. */
    enabled?: boolean;
    /** Let Codey record entries by itself from interactions. Default true. */
    autoExtract?: boolean;
  };
  /**
   * One shared knowledge base that every agent reads. Codey keeps the text in
   * `~/.codey/memory/MEMORY.md` and mirrors it into each agent's own global
   * memory file inside a marked block. Off until the user opts in, because
   * syncing writes into files the user owns.
   */
  sharedMemory?: {
    enabled?: boolean;
  };
  /**
   * Global team library. Each entry maps a team name to its members + dispatch
   * mode. Workspaces opt into teams by listing their names in workspace.json's
   * `teams: string[]` field.
   */
  teams?: Record<string, TeamConfigRaw>;
  /**
   * HTTP API surface (health/metrics/config today, Router API next). Contains
   * no credentials: bearer tokens live in `~/.codey/api-tokens.json` so that
   * this file — which is watched, diffed and served over HTTP — never carries
   * one. See `api-tokens.ts`.
   */
  api?: {
    /**
     * Which interface the HTTP server binds. Default `127.0.0.1` (this machine
     * only). Set `0.0.0.0` to expose it on the LAN — deliberately explicit,
     * because every endpoint including `/config` becomes reachable.
     */
    bindHost?: string;
    /** Browser origins allowed to call the server. Empty = none. */
    allowedOrigins?: string[];
  };
  /** Voice input helper (native macOS app) configuration. */
  voice?: {
    /** Legacy aggregate kept true while either global hotkey is enabled. */
    enabled: boolean;
    /** Dictation global hotkey only. The in-chat action remains available. */
    dictationEnabled?: boolean;
    /** Talk-to-chat global hotkey only. The in-chat action remains available. */
    conversationEnabled?: boolean;
    hotkey: string;
    /**
     * Second hotkey: start/stop a spoken conversation in the focused chat.
     * `hotkey` above dictates at the cursor instead. Unset means no binding.
     * Fn-based combinations are delegated to the bundled Swift helper because
     * Electron's globalShortcut cannot bind them.
     */
    converseHotkey?: string;
    language: string;
    injection: 'paste' | 'ax';
    /** Transcription backend: hosted API or on-device WhisperKit. */
    provider: 'api' | 'local';
    /** Base URL of an OpenAI-compatible transcription endpoint (e.g. https://api.openai.com/v1). */
    apiUrl: string;
    /** Saved Voice key selected from Settings → API Keys. */
    apiKeyRef?: string;
    /** Model identifier sent to the API (e.g. whisper-1). */
    apiModel: string;
    /** WhisperKit model variant for local mode (e.g. openai_whisper-large-v3-turbo). */
    localModel: string;
    /**
     * Proper nouns the recognizer keeps getting wrong. Each term is hinted to
     * the decoder before transcription; its aliases are rewritten to the term
     * afterwards. A bare string is shorthand for `{ term, aliases: [] }`.
     * Passed through to the Swift helper verbatim.
     */
    vocabulary?: (string | { term: string; aliases?: string[] })[];
    /**
     * Learn mis-hearings automatically: when dictation lands in a Codey chat
     * and the user fixes a word before sending, the fix is folded into
     * `vocabulary`. Defaults to on; only the Mac app acts on it.
     */
    vocabularyAutoLearn?: boolean;
    /**
     * Corrections seen once and waiting to see whether they repeat. A single
     * sighting cannot tell a mis-hearing from a change of mind, so nothing
     * rewrites a transcript until it has been observed twice. Managed by the
     * Mac app; the Swift helper never reads it.
     */
    vocabularyPending?: { term: string; alias: string; count: number }[];
    /**
     * Post-transcription cleanup: a model pass that removes the false starts
     * and repeated words speech leaves behind and fixes the grammar a
     * recognizer gets wrong. Off by default — it adds a round trip to the
     * silence right after the user stops talking, which is the most
     * latency-sensitive moment of a dictation turn.
     */
    polish?: {
      enabled?: boolean;
      /**
       * Named model to run the cleanup on, resolved the same way as
       * `tts.digestModel`. Unset — the normal case, and the only one the Mac
       * app produces — uses the Aide model. Kept as a hand-editable escape
       * hatch for a setup where the Aide model is a poor fit for the job.
       */
      model?: string;
      /**
       * Ceiling on the cleanup call. On timeout the raw transcript is used,
       * so this is the worst case the user can be made to wait, not a
       * failure threshold.
       */
      timeoutMs?: number;
      /**
       * The user's own cleanup instructions, added to the built-in ones.
       *
       * Additive rather than a replacement on purpose: the guards in
       * `sanitizePolished` reject a rewrite that summarizes, translates or
       * answers whatever the prompt asked for, so a prompt free to drop the
       * built-in prohibitions would mostly produce results that are thrown
       * away without the user being told why.
       */
      extraInstructions?: string;
    };
    /** Text-to-speech (spoken replies) configuration. */
    tts?: VoiceTtsSettings;
  };

  /**
   * Legacy opt-in marker for the Browser plugin, from when enablement lived in
   * config. A plugin is now installed as an ordinary skill and its presence on
   * disk is the source of truth; this field is read once at startup to carry a
   * pre-existing opt-in over, and is written no more.
   */
  plugins?: {
    browser?: { enabled: boolean };
  };
  /**
   * User-configured external MCP servers, keyed by server name. Enabled
   * entries are exposed to every task-performing agent turn alongside plugin
   * servers. Env values are stored in plaintext, same as `apiKeys`.
   */
  mcpServers?: Record<string, ExternalMcpServerConfig>;
  notifications?: { enabled?: boolean };
  capture?: { hotkey?: string };
  ui?: { launchAtLogin?: boolean; dockless?: boolean; zoom?: number };
}

/**
 * Per-agent settings. `env` lets users inject extra environment variables
 * into the spawned CLI (e.g. CLAUDE_CONFIG_DIR, OPENAI_ORG, custom proxies)
 * without modifying the adapter. Values pass through verbatim and override
 * credentials applied by applyModelEnv.
 */
export interface AgentSlot {
  env?: Record<string, string>;
  /** Default reasoning effort for this agent, when the user has set one. */
  defaultEffort?: ThinkingEffort;
}

/** Text-to-speech settings for spoken replies. */
export interface VoiceTtsSettings {
  enabled: boolean;
  /** Synthesis backend: hosted streaming API or on-device AVSpeechSynthesizer fallback. */
  provider: 'api' | 'local';
  /** Base URL of an OpenAI-compatible speech endpoint (e.g. https://api.openai.com/v1). */
  apiUrl: string;
  /** Independently selected saved key for API speech synthesis. */
  apiKeyRef?: string;
  /** Model identifier sent to the API (e.g. gpt-4o-mini-tts). */
  apiModel: string;
  /** Voice identifier passed to the API or AVSpeechSynthesizer. */
  voiceId: string;
  /** Web Speech/macOS voiceURI used for client-side system speech. */
  systemVoice?: string;
  /**
   * Model (by name, from the global model catalog) used to condense a
   * reply before speaking it. Point this at a small, fast model — the
   * digest is a tool-free text transform and its latency lands in the
   * silence before Codey starts talking. Falls back to the advisor's
   * Aide model when unset; when the resolved model carries an API key the
   * digest runs as a direct API call instead of an agent CLI spawn.
   */
  digestModel?: string;
  /**
   * How much of a reply gets spoken: 'full' reads it verbatim, 'digest'
   * always summarizes to a spoken-form gist, 'auto' summarizes only
   * replies longer than a length threshold and reads short ones verbatim.
   */
  verbosity: 'full' | 'digest' | 'auto';
}

/** Runtime-only voice shape. Secrets are materialized from apiKeyRef for
 * trusted consumers but are never persisted inside the voice config. */
export type ResolvedVoiceTtsSettings = VoiceTtsSettings & { apiKey: string };
export type ResolvedVoiceConfig = Omit<NonNullable<GatewayConfigJson['voice']>, 'tts'> & {
  apiKey: string;
  tts?: ResolvedVoiceTtsSettings;
};

// ── ConfigManager ────────────────────────────────────────────────────

export class ConfigManager extends EventEmitter {
  private config: GatewayConfigJson;
  private configPath: string;
  private watcher?: fs.FSWatcher;
  private lastSerialized: string = '';
  private reloadTimer?: NodeJS.Timeout;
  private secrets: SecretStore;
  /** Set by adoptSecrets when it found inline secrets that must be rewritten out. */
  private pendingMigration = false;

  constructor(configPath?: string, secrets?: SecretStore) {
    super();
    this.configPath = configPath || path.join(process.cwd(), 'gateway.json');
    this.secrets = secrets ?? new SecretStore();
    this.config = this.loadConfig();
    this.lastSerialized = JSON.stringify(stripSecrets(this.config));
    // A migration is only complete once the secret is off disk. This cannot
    // happen inside loadConfig(): save() reads this.config, which is not
    // assigned until the line above.
    if (this.pendingMigration) {
      this.pendingMigration = false;
      this.save();
    }
    this.startWatching();
  }

  private loadConfig(): GatewayConfigJson {
    try {
      if (fs.existsSync(this.configPath)) {
        const data = fs.readFileSync(this.configPath, 'utf-8');
        return this.adoptSecrets(normalize(JSON.parse(data)));
      }
    } catch (error) {
      console.error('[Config] Error loading config:', error);
    }
    return this.adoptSecrets(getDefaultConfig());
  }

  /**
   * Reconcile a freshly-parsed config with the secret store, in both
   * directions:
   *
   * - **Migration.** A secret still written inline in `gateway.json` (an
   *   existing install, a hand-edited file, `gateway.json.example`) is moved
   *   into the store and the config is rewritten without it. This is the only
   *   path that removes a secret from disk, so it must never drop one: the
   *   store is written first, and only then is the config re-saved.
   * - **Hydration.** Every secret the store knows about is put back into the
   *   in-memory config. Existing readers — the channels, the agent adapters,
   *   the Mac app's key editor — keep seeing the shape they always saw. The
   *   split is a storage detail, not an API change.
   */
  private adoptSecrets(config: GatewayConfigJson): GatewayConfigJson {
    const migrated: Array<[SecretKey, string]> = [];

    for (const entry of config.apiKeys ?? []) {
      if (entry.apiKey) migrated.push([apiKeySecret(entry.name), entry.apiKey]);
    }
    for (const channel of ['telegram', 'discord'] as const) {
      const token = config.channels?.[channel]?.botToken;
      if (token) migrated.push([channelSecret(channel), token]);
    }
    if (migrated.length > 0) {
      this.secrets.setMany(migrated);
      this.pendingMigration = true;
      console.log(`[Config] Moved ${migrated.length} secret(s) out of ${this.configPath} into the 0600 secret store`);
    }

    // Hydrate after migrating so a value present in both places resolves to
    // the config's — the file the user just edited wins over the cache.
    for (const entry of config.apiKeys ?? []) {
      if (!entry.apiKey) entry.apiKey = this.secrets.get(apiKeySecret(entry.name)) ?? '';
    }
    for (const channel of ['telegram', 'discord'] as const) {
      const slot = config.channels?.[channel];
      if (slot && !slot.botToken) slot.botToken = this.secrets.get(channelSecret(channel)) ?? '';
    }

    return config;
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
      // Compare stripped forms: the file never carries secrets, so including
      // the hydrated values would make every reload look like a change.
      const serialized = JSON.stringify(stripSecrets(next));
      if (serialized === this.lastSerialized) return;
      // Another process may have written a secret since we last read.
      this.secrets.reload();
      this.config = this.adoptSecrets(next);
      this.lastSerialized = serialized;
      console.log('[Config] Reloaded from disk');
      if (this.pendingMigration) {
        this.pendingMigration = false;
        this.save();  // emits 'change' itself
      } else {
        this.emit('change', this.config);
      }
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
      // Secrets are pushed to the 0600 store BEFORE the config is written, so
      // a crash between the two loses nothing: the worst case is a secret in
      // both places, which the next load reconciles.
      this.persistSecrets();
      const onDisk = stripSecrets(this.config);
      fs.writeFileSync(this.configPath, JSON.stringify(onDisk, null, 2));
      this.lastSerialized = JSON.stringify(onDisk);
      console.log('[Config] Saved to', this.configPath);
      // Listeners get the live config, secrets included — they are runtime
      // consumers (channels, adapters), not writers.
      this.emit('change', this.config);
    } catch (error) {
      console.error('[Config] Error saving config:', error);
    }
  }

  /** Mirror the in-memory secrets into the store. */
  private persistSecrets(): void {
    const entries: Array<[SecretKey, string]> = [];
    for (const entry of this.config.apiKeys ?? []) {
      if (entry.apiKey) entries.push([apiKeySecret(entry.name), entry.apiKey]);
    }
    for (const channel of ['telegram', 'discord'] as const) {
      const token = this.config.channels?.[channel]?.botToken;
      if (token) entries.push([channelSecret(channel), token]);
    }
    this.secrets.setMany(entries);
  }

  /** Bulk update from external source (e.g. renderer IPC). Merges, saves, emits change. */
  update(partial: Partial<GatewayConfigJson>): void {
    if (partial.gateway) Object.assign(this.config.gateway, partial.gateway);
    if (partial.channels) Object.assign(this.config.channels, partial.channels);
    if (partial.agents) Object.assign(this.config.agents, partial.agents);
    if (partial.dev) Object.assign(this.config.dev, partial.dev);
    if (partial.models !== undefined) this.config.models = partial.models;
    if (partial.apiKeys !== undefined) this.config.apiKeys = partial.apiKeys;
    if (partial.fallback !== undefined) this.config.fallback = partial.fallback;
    if (partial.advisor !== undefined) this.config.advisor = partial.advisor;
    if (partial.aide !== undefined) this.config.aide = partial.aide;
    if (partial.teams !== undefined) this.config.teams = partial.teams;
    if (partial.memory !== undefined) {
      this.config.memory = { ...this.config.memory, ...partial.memory };
    }
    if (partial.sharedMemory !== undefined) {
      this.config.sharedMemory = { ...this.config.sharedMemory, ...partial.sharedMemory };
    }
    if (partial.plugins !== undefined) {
      this.config.plugins = { ...this.config.plugins, ...partial.plugins };
    }
    if (partial.mcpServers !== undefined) {
      this.config.mcpServers = { ...this.config.mcpServers, ...partial.mcpServers };
    }
    if (partial.voice !== undefined) this.config.voice = partial.voice;
    if (partial.notifications !== undefined) {
      this.config.notifications = { ...this.config.notifications, ...partial.notifications };
    }
    if (partial.capture !== undefined) {
      this.config.capture = { ...this.config.capture, ...partial.capture };
    }
    if (partial.ui !== undefined) {
      this.config.ui = { ...this.config.ui, ...partial.ui };
    }
    this.save();
  }

  get(): GatewayConfigJson { return this.config; }

  // ── Gateway settings ───────────────────────────────────────────────
  getPort(): number { return this.config.gateway.port; }

  /**
   * Interface for the HTTP server. Defaults to loopback: none of these
   * endpoints has a cross-machine use case, and `/config` in particular used to
   * be reachable from the whole LAN because `listen()` was called without a
   * host.
   */
  getApiBindHost(): string { return this.config.api?.bindHost?.trim() || DEFAULT_API_BIND_HOST; }

  /** Browser origins allowed to call the HTTP server. Empty = block all. */
  getApiAllowedOrigins(): string[] { return this.config.api?.allowedOrigins ?? []; }
  getSkipPermissions(): boolean { return this.config.gateway.skipPermissions ?? true; }

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
   * pointed at it. Content (apiType, apiKeyRef, provider) is preserved.
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

  // ── API Keys ───────────────────────────────────────────────────────
  listApiKeys(): ApiKeyEntry[] { return this.config.apiKeys ?? []; }

  getApiKey(name: string): ApiKeyEntry | undefined {
    return this.config.apiKeys?.find(a => a.name === name);
  }

  /** Voice config with its selected saved key materialized for runtime-only
   * consumers such as the native helper. The secret remains stored once in
   * apiKeys and is never copied back into voice settings. */
  getResolvedVoiceConfig(): ResolvedVoiceConfig | undefined {
    const voice = this.config.voice;
    if (!voice) return undefined;
    const saved = voice.apiKeyRef ? this.getApiKey(voice.apiKeyRef) : undefined;
    const ttsKeyRef = voice.tts?.apiKeyRef;
    const ttsSaved = ttsKeyRef ? this.getApiKey(ttsKeyRef) : undefined;
    const apiKey = saved?.apiKey ?? '';
    const apiUrl = saved?.openaiBaseUrl ?? voice.apiUrl;
    return {
      ...voice,
      apiKey,
      apiUrl,
      tts: voice.tts ? {
        ...voice.tts,
        apiKey: ttsSaved?.apiKey ?? '',
        apiUrl: ttsSaved?.openaiBaseUrl ?? voice.tts.apiUrl,
      } : undefined,
    };
  }

  /**
   * Upsert an API key entry **by name** — `name` is the identity key. To change
   * the name of an existing entry, call `renameApiKey` instead, otherwise the
   * old entry is left in place and every `ModelEntry.apiKeyRef` that pointed
   * at it is silently orphaned.
   */
  saveApiKey(entry: ApiKeyEntry): void {
    if (!entry.name?.trim()) throw new Error('API name is required');
    if (!entry.apiKey?.trim()) throw new Error('API key is required');
    const idx = this.config.apiKeys.findIndex(a => a.name === entry.name);
    if (idx >= 0) this.config.apiKeys[idx] = entry;
    else this.config.apiKeys.push(entry);
    this.save();
  }

  renameApiKey(oldName: string, newName: string): boolean {
    if (!newName.trim() || oldName === newName) return false;
    if (this.config.apiKeys.some(a => a.name === newName)) {
      throw new Error(`An API key with name "${newName}" already exists`);
    }
    const idx = this.config.apiKeys.findIndex(a => a.name === oldName);
    if (idx < 0) return false;
    this.config.apiKeys[idx] = { ...this.config.apiKeys[idx], name: newName };
    // The store is keyed by entry name; without this the secret is orphaned
    // under the old key and the renamed entry silently loses its credential.
    this.secrets.rename(apiKeySecret(oldName), apiKeySecret(newName));
    // Rewrite every model that referenced the old name so apiKeyRef stays valid.
    for (const m of this.config.models) {
      if (m.apiKeyRef === oldName) m.apiKeyRef = newName;
    }
    if (this.config.voice?.apiKeyRef === oldName) {
      this.config.voice.apiKeyRef = newName;
    }
    if (this.config.voice?.tts?.apiKeyRef === oldName) {
      this.config.voice.tts.apiKeyRef = newName;
    }
    this.save();
    return true;
  }

  deleteApiKey(name: string): boolean {
    const dependents = this.config.models.filter(m => m.apiKeyRef === name).map(m => m.model);
    if (this.config.voice?.apiKeyRef === name) dependents.push('Voice transcription');
    if (this.config.voice?.tts?.apiKeyRef === name) dependents.push('Voice TTS');
    if (dependents.length > 0) {
      throw new Error(`API key "${name}" is referenced by: ${dependents.join(', ')}`);
    }
    const before = this.config.apiKeys.length;
    this.config.apiKeys = this.config.apiKeys.filter(a => a.name !== name);
    if (this.config.apiKeys.length !== before) {
      // Deleting the entry has to delete the credential; `save()` only writes
      // secrets it can still see in the config.
      this.secrets.delete(apiKeySecret(name));
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

  getSkillsConfig(): {
    enabled: boolean; suggestOnRepeat: number; autoApply: boolean;
    staleDays: number; weakSkillDays: number; distillModel: string | undefined;
    induction: boolean;
  } {
    const raw = this.config.skills;
    return {
      enabled: raw?.enabled ?? true,
      suggestOnRepeat: raw?.suggestOnRepeat ?? 2,
      autoApply: raw?.autoApply ?? true,
      staleDays: raw?.staleDays ?? 30,
      weakSkillDays: raw?.weakSkillDays ?? 7,
      distillModel: raw?.distillModel,
      // On by default. The gates (3+ distinct tools, 2+ members, 0.4
      // distinctiveness) all err toward finding nothing, the suggestion still
      // needs the user's "yes", and a "no" is remembered — so the cost of a
      // bad cluster is one dismissed message. Set false to fall back to prose
      // distillation; clustering still logs either way.
      induction: raw?.induction ?? true,
    };
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

  /** Set or clear an agent's default reasoning effort and persist gateway.json. */
  setAgentDefaultEffort(agent: CodingAgent, effort?: ThinkingEffort): void {
    if (!this.config.agents) this.config.agents = {};
    const key = agent as keyof typeof this.config.agents;
    const slot: AgentSlot = this.config.agents[key] ?? {};
    if (effort === undefined) delete slot.defaultEffort;
    else slot.defaultEffort = effort;
    this.config.agents[key] = slot;
    this.save();
  }

  /** Legacy: the pre-install-model opt-in flag. Only the one-time migration
   *  that installs the skill for an existing user reads this. */
  isPluginEnabled(name: 'browser'): boolean {
    return this.config.plugins?.[name]?.enabled === true;
  }

  // ── External MCP servers ───────────────────────────────────────────
  /** Add or replace one external MCP server entry. Saves and emits change. */
  setExternalMcpServer(name: string, cfg: ExternalMcpServerConfig): void {
    this.config.mcpServers = { ...this.config.mcpServers, [name]: cfg };
    this.save();
  }

  /** Delete one external MCP server entry (merge-based update() cannot). */
  removeExternalMcpServer(name: string): void {
    if (!this.config.mcpServers || !(name in this.config.mcpServers)) return;
    const { [name]: _removed, ...rest } = this.config.mcpServers;
    this.config.mcpServers = rest;
    this.save();
  }

  /**
   * Enabled external servers mapped to the core McpServerSpec shape. Skips
   * disabled entries, entries missing their transport's required field, and
   * the reserved `codey-browser` name.
   */
  getEnabledExternalMcpServers(): Record<string, McpServerSpec> {
    const out: Record<string, McpServerSpec> = {};
    for (const [name, cfg] of Object.entries(this.config.mcpServers ?? {})) {
      if (!cfg.enabled || name === 'codey-browser') continue;
      if (cfg.transport === 'remote') {
        if (!cfg.url) continue;
        out[name] = { command: '', args: [], env: {}, url: cfg.url };
      } else if (cfg.transport === 'stdio') {
        if (!cfg.command) continue;
        out[name] = { command: cfg.command, args: cfg.args ?? [], env: cfg.env ?? {} };
      }
    }
    return out;
  }

  // ── Channels ───────────────────────────────────────────────────────
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

  setIMessageSenders(senders: string[]): void {
    if (!this.config.channels.imessage) this.config.channels.imessage = { enabled: false, allowedSenders: [] };
    this.config.channels.imessage.allowedSenders = senders;
    this.save();
  }

  enableChannel(channel: 'telegram' | 'discord' | 'imessage'): void {
    if (channel === 'telegram' && this.config.channels.telegram) this.config.channels.telegram.enabled = true;
    else if (channel === 'discord' && this.config.channels.discord) this.config.channels.discord.enabled = true;
    else if (channel === 'imessage') {
      if (this.config.channels.imessage) this.config.channels.imessage.enabled = true;
      else this.config.channels.imessage = { enabled: true };
    }
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
      const keyHint = m.apiKeyRef ? ` 🔑 ${m.apiKeyRef}` : ' (default)';
      console.log(`  • ${m.model} [${m.apiType}]${keyHint}`);
    }
    console.log(`\nAgents:`);
    const inOrder = new Set(this.config.fallback.order.map(e => e.agent));
    for (const a of ['claude-code', 'opencode', 'codex', 'pi'] as const) {
      console.log(`  ${inOrder.has(a) ? '✅' : '❌'} ${a}`);
    }
    console.log(`\nPriority: ${this.config.fallback.enabled ? '✅' : '❌'} order=${formatFallbackOrder(this.config.fallback.order)}`);
    console.log(`\nDev:\n  Log Level: ${this.config.dev.logLevel}`);
    console.log('─'.repeat(40) + '\n');
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

const KNOWN_AGENTS: ReadonlySet<CodingAgent> = new Set(['claude-code', 'opencode', 'codex', 'pi']);

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
    gateway: { port: 3000, skipPermissions: true },
    channels: {
      telegram: { enabled: false, botToken: '' },
      discord: { enabled: false, botToken: '' },
      imessage: { enabled: false, allowedSenders: [] },
    },
    agents: {
      'claude-code': {},
      'opencode':    {},
      'codex':       {},
      'pi':          {},
    },
    models: [
      { apiType: 'anthropic', model: 'claude-sonnet-4-5', provider: 'anthropic' },
      { apiType: 'anthropic', model: 'claude-opus-4-1',   provider: 'anthropic' },
      { apiType: 'anthropic', model: 'claude-haiku-4-5',  provider: 'anthropic' },
      { apiType: 'openai',    model: 'gpt-5',             provider: 'openai' },
    ],
    apiKeys: [],
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

/**
 * The config as it is allowed to touch disk: same shape, secrets blanked.
 *
 * Blanked rather than deleted, so the JSON keeps the field and a reader
 * (including a human opening the file) sees that a credential exists and is
 * stored elsewhere — rather than concluding none was ever configured.
 */
export function stripSecrets(config: GatewayConfigJson): GatewayConfigJson {
  return {
    ...config,
    apiKeys: (config.apiKeys ?? []).map(entry => ({ ...entry, apiKey: '' })),
    channels: {
      ...config.channels,
      ...(config.channels?.telegram ? { telegram: { ...config.channels.telegram, botToken: '' } } : {}),
      ...(config.channels?.discord ? { discord: { ...config.channels.discord, botToken: '' } } : {}),
    },
  };
}

/** Fill in any missing top-level fields with defaults so downstream code can assume shape. */
function normalize(raw: Partial<GatewayConfigJson> & { dispatcher?: { agent?: CodingAgent; model?: string }; planner?: { model?: string } }): GatewayConfigJson {
  const defaults = getDefaultConfig();
  const rawModels = Array.isArray(raw.models) ? raw.models : defaults.models;
  // Clean break: drop inline apiKey/baseUrl from any pre-existing model entries.
  // Users re-bind via the API Keys tab. apiKeyRef is left unset until they do.
  const models: ModelEntry[] = rawModels.map(m => ({
    // Hand-edited or older configs can carry an unknown apiType; fall back to
    // anthropic rather than letting the value reach the adapters unchecked.
    apiType: isApiType(m.apiType) ? m.apiType : 'anthropic',
    model: m.model,
    apiKeyRef: (m as any).apiKeyRef,
    provider: m.provider,
  }));
  // `name` is the identity; an empty `apiKey` is now the normal on-disk state
  // (the secret lives in the 0600 store) and must NOT drop the entry, or every
  // saved key would vanish on the first reload after being stripped.
  const apiKeys: ApiKeyEntry[] = Array.isArray(raw.apiKeys)
    ? raw.apiKeys
        .filter((a: any) => a && typeof a.name === 'string' && a.name.trim())
        .map((a: any) => ({ ...a, apiKey: typeof a.apiKey === 'string' ? a.apiKey : '' }))
    : [];
  const out: GatewayConfigJson = {
    gateway: { ...defaults.gateway, ...(raw.gateway ?? {}) },
    channels: raw.channels ?? defaults.channels,
    agents: { ...defaults.agents, ...(raw.agents ?? {}) },
    models,
    apiKeys,
    fallback: normalizeFallback(raw.fallback, defaults.fallback),
    dev: raw.dev ?? defaults.dev,
  };
  if (raw.aide && typeof raw.aide === 'object') {
    out.aide = {
      agent: raw.aide.agent,
      model: raw.aide.model,
    };
  }
  if (raw.skills && typeof raw.skills === 'object') {
    out.skills = {
      enabled: raw.skills.enabled,
      suggestOnRepeat: raw.skills.suggestOnRepeat,
      autoApply: raw.skills.autoApply,
      staleDays: raw.skills.staleDays,
      weakSkillDays: raw.skills.weakSkillDays,
      distillModel: raw.skills.distillModel,
      induction: raw.skills.induction,
    };
  }
  if (raw.advisor && typeof raw.advisor === 'object') {
    out.advisor = {
      agent: raw.advisor.agent,
      model: raw.advisor.model,
    };
  } else if (raw.dispatcher && typeof raw.dispatcher === 'object') {
    // Back-compat: old `dispatcher` field maps into `advisor`.
    console.warn('[config] `dispatcher` is deprecated; rename to `advisor` in gateway.json');
    out.advisor = {
      agent: raw.dispatcher.agent,
      model: raw.dispatcher.model,
    };
  } else if (raw.planner && typeof raw.planner === 'object' && raw.planner.model) {
    // Back-compat: old `planner.model` becomes advisor model.
    console.warn('[config] `planner` is deprecated; the planner has been removed. Use `advisor` instead.');
    out.advisor = { model: raw.planner.model };
  }
  if (raw.teams && typeof raw.teams === 'object') {
    out.teams = raw.teams as Record<string, TeamConfigRaw>;
  }
  if (raw.plugins && typeof raw.plugins === 'object') {
    out.plugins = {
      browser: { enabled: raw.plugins.browser?.enabled === true },
    };
  }
  if (raw.mcpServers && typeof raw.mcpServers === 'object') {
    const servers: Record<string, ExternalMcpServerConfig> = {};
    for (const [name, value] of Object.entries(raw.mcpServers as Record<string, any>)) {
      if (!value || typeof value !== 'object') continue;
      const transport = value.transport === 'remote' ? 'remote' : value.transport === 'stdio' ? 'stdio' : null;
      if (!transport) continue; // unknown transports are dropped, not guessed
      servers[name] = {
        transport,
        command: typeof value.command === 'string' ? value.command : undefined,
        args: Array.isArray(value.args) ? value.args.map(String) : undefined,
        env: value.env && typeof value.env === 'object'
          ? Object.fromEntries(Object.entries(value.env).map(([k, v]) => [k, String(v)]))
          : undefined,
        url: typeof value.url === 'string' ? value.url : undefined,
        enabled: value.enabled === true,
      };
    }
    out.mcpServers = servers;
  }
  if (raw.voice && typeof raw.voice === 'object') {
    // Inline Voice secrets were an unreleased implementation detail. Drop
    // them completely; Voice now references a credential in apiKeys by name.
    const { apiKey: _inlineApiKey, tts: rawTts, ...voice } = raw.voice as any;
    const { apiKey: _inlineTtsApiKey, ...tts } = (rawTts ?? {}) as any;
    out.voice = {
      ...voice,
      // Migrate the former default so existing installs receive the new,
      // less collision-prone Conversation binding without manual reset.
      ...(voice.converseHotkey === 'Control+Fn' ? { converseHotkey: 'Shift+Fn' } : {}),
      ...(rawTts && typeof rawTts === 'object' ? { tts } : {}),
    } as GatewayConfigJson['voice'];
  }
  if (raw.api && typeof raw.api === 'object') {
    out.api = {
      bindHost: typeof raw.api.bindHost === 'string' && raw.api.bindHost.trim()
        ? raw.api.bindHost.trim()
        : undefined,
      allowedOrigins: Array.isArray(raw.api.allowedOrigins)
        ? raw.api.allowedOrigins.filter((o: unknown): o is string => typeof o === 'string' && !!o.trim())
        : undefined,
    };
  }
  if (raw.notifications && typeof raw.notifications === 'object') {
    out.notifications = { enabled: raw.notifications.enabled };
  }
  if (raw.capture && typeof raw.capture === 'object') {
    out.capture = { hotkey: raw.capture.hotkey };
  }
  if (raw.ui && typeof raw.ui === 'object') {
    out.ui = { launchAtLogin: raw.ui.launchAtLogin, dockless: raw.ui.dockless, zoom: raw.ui.zoom };
  }
  return out;
}
