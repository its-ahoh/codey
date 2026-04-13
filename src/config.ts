import * as fs from 'fs';
import * as path from 'path';
import { EventEmitter } from 'events';

// Configuration types
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
  agents: {
    'claude-code'?: {
      enabled?: boolean;
      provider?: 'anthropic' | 'openai' | 'google';
      defaultModel?: string;
      models?: string[];
    };
    'opencode'?: {
      enabled?: boolean;
      provider?: 'anthropic' | 'openai' | 'google';
      defaultModel?: string;
      models?: string[];
    };
    'codex'?: {
      enabled?: boolean;
      provider?: 'anthropic' | 'openai' | 'google';
      defaultModel?: string;
      models?: string[];
    };
  };
  profiles?: Profile[];
  activeProfile?: string;
  dev: {
    logLevel: 'debug' | 'info' | 'warn' | 'error';
    logFile?: string;
  };
}

export interface ProviderCredentials {
  apiKey: string;
  baseUrl?: string;
}

export interface Profile {
  name: string;
  anthropic?: ProviderCredentials;
  openai?: ProviderCredentials;
  google?: { apiKey: string; baseUrl?: string };
}

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
        return JSON.parse(data);
      }
    } catch (error) {
      console.error('[Config] Error loading config:', error);
    }
    return this.getDefaultConfig();
  }

  private getDefaultConfig(): GatewayConfigJson {
    return {
      gateway: {
        port: 3000,
        defaultAgent: 'claude-code',
      },
      channels: {
        telegram: { enabled: false, botToken: '' },
        discord: { enabled: false, botToken: '' },
        imessage: { enabled: false },
      },
      agents: {
        'claude-code': {
          enabled: true,
          provider: 'anthropic',
          defaultModel: 'claude-sonnet-4-20250514',
          models: [
            'claude-sonnet-4-20250514',
            'claude-opus-4-20250514',
          ],
        },
        'opencode': {
          enabled: true,
          provider: 'openai',
          defaultModel: 'gpt-4.1',
          models: [
            'gpt-4.1',
            'gpt-4o',
          ],
        },
        'codex': {
          enabled: true,
          provider: 'openai',
          defaultModel: 'gpt-5-codex',
          models: [
            'gpt-5-codex',
          ],
        },
      },
      dev: {
        logLevel: 'info',
      },
    };
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

  /** Bulk update from external source (e.g. API). Merges, saves, and emits change. */
  update(partial: Partial<GatewayConfigJson>): void {
    if (partial.gateway) {
      Object.assign(this.config.gateway, partial.gateway);
    }
    if (partial.channels) {
      Object.assign(this.config.channels, partial.channels);
    }
    if (partial.agents) {
      Object.assign(this.config.agents, partial.agents);
    }
    if (partial.dev) {
      Object.assign(this.config.dev, partial.dev);
    }
    if (partial.profiles !== undefined) {
      this.config.profiles = partial.profiles;
    }
    if (partial.activeProfile !== undefined) {
      this.config.activeProfile = partial.activeProfile;
    }
    this.save();
  }

  get(): GatewayConfigJson {
    return this.config;
  }

  // Gateway settings
  getPort(): number {
    return this.config.gateway.port;
  }

  getDefaultAgent(): string {
    return this.config.gateway.defaultAgent;
  }

  getDefaultModel(): string {
    return this.getActiveProfileModel() || 'claude-sonnet-4-6';
  }

  private getActiveProfileModel(): string | undefined {
    const agent = this.config.gateway.defaultAgent;
    const agentConfig = this.config.agents[agent as keyof typeof this.config.agents];
    return agentConfig?.defaultModel;
  }

  setDefaultAgent(agent: string): void {
    this.config.gateway.defaultAgent = agent;
    this.save();
  }

  setDefaultModel(model: string): void {
    const agent = this.config.gateway.defaultAgent;
    this.setAgentModel(agent, model);
  }

  // Channel settings
  getTelegramConfig() {
    return this.config.channels.telegram;
  }

  getDiscordConfig() {
    return this.config.channels.discord;
  }

  setTelegramToken(token: string): void {
    if (!this.config.channels.telegram) {
      this.config.channels.telegram = { enabled: false, botToken: '' };
    }
    this.config.channels.telegram.botToken = token;
    this.save();
  }

  setDiscordToken(token: string): void {
    if (!this.config.channels.discord) {
      this.config.channels.discord = { enabled: false, botToken: '' };
    }
    this.config.channels.discord.botToken = token;
    this.save();
  }

  enableChannel(channel: 'telegram' | 'discord' | 'imessage'): void {
    if (channel === 'telegram' && this.config.channels.telegram) {
      this.config.channels.telegram.enabled = true;
    } else if (channel === 'discord' && this.config.channels.discord) {
      this.config.channels.discord.enabled = true;
    } else if (channel === 'imessage') {
      if (!this.config.channels.imessage) {
        this.config.channels.imessage = { enabled: true };
      } else {
        this.config.channels.imessage.enabled = true;
      }
    }
    this.save();
  }

  disableChannel(channel: 'telegram' | 'discord' | 'imessage'): void {
    if (channel === 'telegram' && this.config.channels.telegram) {
      this.config.channels.telegram.enabled = false;
    } else if (channel === 'discord' && this.config.channels.discord) {
      this.config.channels.discord.enabled = false;
    } else if (channel === 'imessage' && this.config.channels.imessage) {
      this.config.channels.imessage.enabled = false;
    }
    this.save();
  }

  // Profiles
  getActiveProfileObj(): Profile | undefined {
    if (!this.config.activeProfile || !this.config.profiles) return undefined;
    return this.config.profiles.find(p => p.name === this.config.activeProfile);
  }

  getActiveProfile(): string {
    return this.config.activeProfile || 'default';
  }

  setActiveProfile(name: string): boolean {
    if (!this.config.profiles?.find(p => p.name === name)) return false;
    this.config.activeProfile = name;
    this.save();
    return true;
  }

  getProfiles(): Profile[] {
    return this.config.profiles || [];
  }

  addProfile(profile: Profile): void {
    if (!this.config.profiles) this.config.profiles = [];
    const existing = this.config.profiles.findIndex(p => p.name === profile.name);
    if (existing >= 0) {
      this.config.profiles[existing] = profile;
    } else {
      this.config.profiles.push(profile);
    }
    if (!this.config.activeProfile) {
      this.config.activeProfile = profile.name;
    }
    this.save();
  }

  removeProfile(name: string): boolean {
    if (!this.config.profiles) return false;
    const idx = this.config.profiles.findIndex(p => p.name === name);
    if (idx < 0) return false;
    this.config.profiles.splice(idx, 1);
    if (this.config.activeProfile === name) {
      this.config.activeProfile = this.config.profiles[0]?.name || undefined;
    }
    this.save();
    return true;
  }

  // Agent config
  getAgentConfig(agent: string) {
    return this.config.agents[agent as keyof typeof this.config.agents];
  }

  setAgentModel(agent: string, model: string): void {
    const agentConfig = this.config.agents[agent as keyof typeof this.config.agents];
    if (agentConfig) {
      agentConfig.defaultModel = model;
      this.save();
    }
  }

  // Dev settings
  getLogLevel(): string {
    return this.config.dev.logLevel;
  }

  setLogLevel(level: 'debug' | 'info' | 'warn' | 'error'): void {
    this.config.dev.logLevel = level;
    this.save();
  }

  // Print current config
  printConfig(): void {
    console.log('\n📋 Current Configuration:');
    console.log('─'.repeat(40));
    console.log(`Gateway:`);
    console.log(`  Default Agent: ${this.config.gateway.defaultAgent}`);
    console.log(`  Default Model: ${this.getDefaultModel()}`);
    console.log(`  Port: ${this.config.gateway.port}`);
    console.log(`\nChannels:`);
    console.log(`  Telegram: ${this.config.channels.telegram?.enabled ? '✅' : '❌'}`);
    console.log(`  Discord: ${this.config.channels.discord?.enabled ? '✅' : '❌'}`);
    console.log(`  iMessage: ${this.config.channels.imessage?.enabled ? '✅' : '❌'}`);
    const profile = this.getActiveProfileObj();
    console.log(`\nAPI Keys (from active profile: ${this.config.activeProfile || 'default'}):`);
    if (profile?.anthropic) {
      console.log(`  Anthropic: ✅ [${profile.name}] ${profile.anthropic.baseUrl || 'api.anthropic.com'}`);
    } else {
      console.log(`  Anthropic: ❌`);
    }
    if (profile?.openai) {
      console.log(`  OpenAI: ✅ [${profile.name}] ${profile.openai.baseUrl || 'api.openai.com'}`);
    } else {
      console.log(`  OpenAI: ❌`);
    }
    if (profile?.google) {
      console.log(`  Google: ✅ [${profile.name}]`);
    } else {
      console.log(`  Google: ❌`);
    }
    if (this.config.profiles && this.config.profiles.length > 0) {
      console.log(`\nProfiles (${this.config.activeProfile || 'default'} active):`);
      for (const p of this.config.profiles) {
        const mark = p.name === this.config.activeProfile ? '👉' : '  ';
        const anthropic = p.anthropic ? ` anthropic ✅` : '';
        const openai = p.openai ? ` openai ✅` : '';
        console.log(`  ${mark} ${p.name}${anthropic}${openai}`);
      }
    }
    console.log(`\nDev:`);
    console.log(`  Log Level: ${this.config.dev.logLevel}`);
    console.log('─'.repeat(40) + '\n');
  }
}
