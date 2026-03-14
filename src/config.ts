import * as fs from 'fs';
import * as path from 'path';

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
    logFile?: string;
  };
}

export interface AgentConfig {
  enabled: boolean;
  defaultModel: string;
  models: { provider: string; model: string }[];
}

export class ConfigManager {
  private config: GatewayConfigJson;
  private configPath: string;

  constructor(configPath?: string) {
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
          defaultModel: 'claude-sonnet-4-20250514',
          models: [
            { provider: 'anthropic', model: 'claude-sonnet-4-20250514' },
            { provider: 'anthropic', model: 'claude-opus-4-20250514' },
          ],
        },
        'opencode': {
          enabled: true,
          defaultModel: 'gpt-4.1',
          models: [
            { provider: 'openai', model: 'gpt-4.1' },
            { provider: 'openai', model: 'gpt-4o' },
          ],
        },
        'codex': {
          enabled: true,
          defaultModel: 'gpt-5-codex',
          models: [
            { provider: 'openai', model: 'gpt-5-codex' },
          ],
        },
      },
      apiKeys: {},
      dev: {
        logLevel: 'info',
      },
    };
  }

  save(): void {
    try {
      fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2));
      console.log('[Config] Saved to', this.configPath);
    } catch (error) {
      console.error('[Config] Error saving config:', error);
    }
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
    const agent = this.config.gateway.defaultAgent;
    const agentConfig = this.config.agents[agent as keyof typeof this.config.agents];
    return agentConfig?.defaultModel || 'claude-sonnet-4-6';
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

  // API Keys
  getApiKey(provider: 'anthropic' | 'openai' | 'google'): string | undefined {
    return this.config.apiKeys[provider];
  }

  setApiKey(provider: 'anthropic' | 'openai' | 'google', key: string): void {
    this.config.apiKeys[provider] = key;
    this.save();
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
    console.log(`\nAPI Keys:`);
    console.log(`  Anthropic: ${this.config.apiKeys.anthropic ? '✅ set' : '❌'}`);
    console.log(`  OpenAI: ${this.config.apiKeys.openai ? '✅ set' : '❌'}`);
    console.log(`  Google: ${this.config.apiKeys.google ? '✅ set' : '❌'}`);
    console.log(`\nDev:`);
    console.log(`  Log Level: ${this.config.dev.logLevel}`);
    console.log('─'.repeat(40) + '\n');
  }
}
