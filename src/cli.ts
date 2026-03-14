import * as readline from 'readline';
import { ConfigManager } from './config';
import { Logger } from './logger';

export class CLI {
  private config: ConfigManager;
  private logger: Logger;
  private rl: readline.Interface;

  constructor(config: ConfigManager, logger: Logger) {
    this.config = config;
    this.logger = logger;
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
  }

  async prompt(question: string): Promise<string> {
    return new Promise((resolve) => {
      this.rl.question(question, (answer) => {
        resolve(answer);
      });
    });
  }

  async runConfigure(): Promise<void> {
    this.logger.clear();
    this.logger.banner('⚙️  Codey Configuration');

    const config = this.config.get();
    
    this.logger.info('Select an option:\n');
    this.logger.info('1. View current configuration');
    this.logger.info('2. Set default agent');
    this.logger.info('3. Set default model');
    this.logger.info('4. Configure Telegram');
    this.logger.info('5. Configure Discord');
    this.logger.info('6. Set API keys');
    this.logger.info('7. Set log level');
    this.logger.info('8. Enable/disable channel');
    this.logger.info('0. Exit\n');

    const choice = await this.prompt('Enter option: ');

    switch (choice) {
      case '1':
        this.config.printConfig();
        break;
      case '2':
        await this.setAgent();
        break;
      case '3':
        await this.setModel();
        break;
      case '4':
        await this.configureTelegram();
        break;
      case '5':
        await this.configureDiscord();
        break;
      case '6':
        await this.setApiKeys();
        break;
      case '7':
        await this.setLogLevel();
        break;
      case '8':
        await this.toggleChannel();
        break;
      case '0':
        this.logger.info('Exiting...');
        process.exit(0);
      default:
        this.logger.error('Invalid option');
    }
  }

  private async setAgent(): Promise<void> {
    this.logger.info('\nAvailable agents:');
    this.logger.info('1. claude-code');
    this.logger.info('2. opencode');
    this.logger.info('3. codex');

    const choice = await this.prompt('\nSelect agent (1-3): ');
    const agents = ['claude-code', 'opencode', 'codex'];
    const agent = agents[parseInt(choice) - 1];

    if (agent) {
      this.config.setDefaultAgent(agent);
      this.logger.info(`✅ Default agent set to: ${agent}`);
    } else {
      this.logger.error('Invalid selection');
    }
  }

  private async setModel(): Promise<void> {
    const agent = this.config.getDefaultAgent();
    const agentConfig = this.config.getAgentConfig(agent);

    this.logger.info(`\nAvailable models for ${agent}:`);
    agentConfig?.models.forEach((m, i) => {
      this.logger.info(`${i + 1}. ${m.model} (${m.provider})`);
    });

    const choice = await this.prompt('\nSelect model: ');
    const model = agentConfig?.models[parseInt(choice) - 1]?.model;

    if (model) {
      this.config.setDefaultModel(model);
      this.logger.info(`✅ Default model set to: ${model}`);
    } else {
      this.logger.error('Invalid selection');
    }
  }

  private async configureTelegram(): Promise<void> {
    const token = await this.prompt('Enter Telegram bot token: ');
    if (token.trim()) {
      this.config.setTelegramToken(token.trim());
      const enable = await this.prompt('Enable Telegram? (y/n): ');
      if (enable.toLowerCase() === 'y') {
        this.config.enableChannel('telegram');
      }
      this.logger.info('✅ Telegram configured');
    }
  }

  private async configureDiscord(): Promise<void> {
    const token = await this.prompt('Enter Discord bot token: ');
    if (token.trim()) {
      this.config.setDiscordToken(token.trim());
      const enable = await this.prompt('Enable Discord? (y/n): ');
      if (enable.toLowerCase() === 'y') {
        this.config.enableChannel('discord');
      }
      this.logger.info('✅ Discord configured');
    }
  }

  private async setApiKeys(): Promise<void> {
    this.logger.info('\n1. Anthropic API Key');
    this.logger.info('2. OpenAI API Key');
    this.logger.info('3. Google API Key');

    const choice = await this.prompt('\nSelect provider: ');
    const providers: Record<string, 'anthropic' | 'openai' | 'google'> = {
      '1': 'anthropic',
      '2': 'openai',
      '3': 'google',
    };

    const provider = providers[choice];
    if (provider) {
      const key = await this.prompt('Enter API key: ');
      if (key.trim()) {
        this.config.setApiKey(provider, key.trim());
        this.logger.info(`✅ ${provider} API key set`);
      }
    }
  }

  private async setLogLevel(): Promise<void> {
    this.logger.info('\n1. debug');
    this.logger.info('2. info');
    this.logger.info('3. warn');
    this.logger.info('4. error');

    const choice = await this.prompt('\nSelect log level: ');
    const levels: Record<string, 'debug' | 'info' | 'warn' | 'error'> = {
      '1': 'debug',
      '2': 'info',
      '3': 'warn',
      '4': 'error',
    };

    const level = levels[choice];
    if (level) {
      this.config.setLogLevel(level);
      this.logger.info(`✅ Log level set to: ${level}`);
    }
  }

  private async toggleChannel(): Promise<void> {
    this.logger.info('\n1. Telegram');
    this.logger.info('2. Discord');
    this.logger.info('3. iMessage');

    const choice = await this.prompt('\nSelect channel: ');
    const channels: Record<string, 'telegram' | 'discord' | 'imessage'> = {
      '1': 'telegram',
      '2': 'discord',
      '3': 'imessage',
    };

    const channel = channels[choice];
    if (channel) {
      const action = await this.prompt('(e)nable or (d)isable? ');
      if (action.toLowerCase() === 'e') {
        this.config.enableChannel(channel);
        this.logger.info(`✅ ${channel} enabled`);
      } else if (action.toLowerCase() === 'd') {
        this.config.disableChannel(channel);
        this.logger.info(`✅ ${channel} disabled`);
      }
    }
  }

  close(): void {
    this.rl.close();
  }
}

// CLI Commands
export async function handleCommand(args: string[], config: ConfigManager, logger: Logger): Promise<void> {
  const command = args[0];

  switch (command) {
    case 'configure':
    case 'config':
    case 'cfg':
      const cli = new CLI(config, logger);
      await cli.runConfigure();
      cli.close();
      break;

    case 'status':
      config.printConfig();
      break;

    case 'set-agent':
      if (args[1]) {
        config.setDefaultAgent(args[1]);
        logger.info(`Default agent set to: ${args[1]}`);
      } else {
        logger.error('Usage: set-agent <agent-name>');
      }
      break;

    case 'set-model':
      if (args[1]) {
        config.setDefaultModel(args[1]);
        logger.info(`Default model set to: ${args[1]}`);
      } else {
        logger.error('Usage: set-model <model-name>');
      }
      break;

    case 'set-telegram':
      if (args[1]) {
        config.setTelegramToken(args[1]);
        config.enableChannel('telegram');
        logger.info('Telegram configured and enabled');
      } else {
        logger.error('Usage: set-telegram <bot-token>');
      }
      break;

    case 'set-discord':
      if (args[1]) {
        config.setDiscordToken(args[1]);
        config.enableChannel('discord');
        logger.info('Discord configured and enabled');
      } else {
        logger.error('Usage: set-discord <bot-token>');
      }
      break;

    case 'set-key':
      if (args[1] && args[2]) {
        const provider = args[1] as 'anthropic' | 'openai' | 'google';
        config.setApiKey(provider, args[2]);
        logger.info(`${provider} API key set`);
      } else {
        logger.error('Usage: set-key <anthropic|openai|google> <api-key>');
      }
      break;

    case 'set-loglevel':
      if (args[1]) {
        config.setLogLevel(args[1] as 'debug' | 'info' | 'warn' | 'error');
        logger.info(`Log level set to: ${args[1]}`);
      } else {
        logger.error('Usage: set-loglevel <debug|info|warn|error>');
      }
      break;

    case 'enable':
      if (args[1]) {
        config.enableChannel(args[1] as 'telegram' | 'discord' | 'imessage');
        logger.info(`${args[1]} enabled`);
      } else {
        logger.error('Usage: enable <telegram|discord|imessage>');
      }
      break;

    case 'disable':
      if (args[1]) {
        config.disableChannel(args[1] as 'telegram' | 'discord' | 'imessage');
        logger.info(`${args[1]} disabled`);
      } else {
        logger.error('Usage: disable <telegram|discord|imessage>');
      }
      break;

    case 'help':
    case '--help':
    case '-h':
      showHelp();
      break;

    default:
      logger.error(`Unknown command: ${command}`);
      showHelp();
  }
}

function showHelp(): void {
  console.log(`
╔════════════════════════════════════════════════════════════╗
║                         Codey CLI                             ║
╠════════════════════════════════════════════════════════════╣
║  configure / config / cfg   Open interactive configurator   ║
║  status                     Show current configuration      ║
║  set-agent <name>           Set default agent               ║
║  set-model <name>           Set default model               ║
║  set-telegram <token>      Set Telegram bot token          ║
║  set-discord <token>       Set Discord bot token           ║
║  set-key <provider> <key>  Set API key                      ║
║  set-loglevel <level>      Set log level                   ║
║  enable <channel>          Enable a channel                 ║
║  disable <channel>         Disable a channel               ║
║  help                       Show this help                  ║
╚════════════════════════════════════════════════════════════╝
  `);
}
