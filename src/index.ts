import dotenv from 'dotenv';
import { ConfigManager } from './config';
import { Logger } from './logger';
import { handleCommand } from './cli';
import { GatewayConfig } from './types';
import { Codey } from './gateway';
import { HealthServer, HealthStatusType } from './health';

dotenv.config();

// Parse CLI arguments
const args = process.argv.slice(2);

// Initialize logger and config
const configManager = new ConfigManager();
const config = configManager.get();
const logger = Logger.getInstance(config.dev.logLevel, config.dev.logFile);

// Check if running a CLI command
if (args[0] === 'tui') {
  startTui().catch((err) => {
    logger.error(`Failed to start TUI: ${err.message}`);
    process.exit(1);
  });
} else if (args.length > 0) {
  handleCommand(args, configManager, logger).then(() => {
    process.exit(0);
  }).catch((err) => {
    logger.error(err.message);
    process.exit(1);
  });
} else {
  startGateway();
}

function startGateway(): void {
  // Build GatewayConfig from JSON config
  const gatewayConfig: GatewayConfig = {
    port: configManager.getPort(),
    defaultAgent: configManager.getDefaultAgent() as any,
    agents: config.agents as any,
    channels: {
      telegram: config.channels.telegram?.enabled ? { 
        botToken: config.channels.telegram.botToken, 
        notifyChatId: config.channels.telegram.notifyChatId 
      } : undefined,
      discord: config.channels.discord?.enabled ? { botToken: config.channels.discord.botToken } : undefined,
      imessage: config.channels.imessage?.enabled ? { enabled: true } : undefined,
    },
  };

  // Pass API keys via environment
  if (config.apiKeys.anthropic) {
    process.env.ANTHROPIC_API_KEY = config.apiKeys.anthropic;
  }
  if (config.apiKeys.openai) {
    process.env.OPENAI_API_KEY = config.apiKeys.openai;
  }
  if (config.apiKeys.google) {
    process.env.GOOGLE_API_KEY = config.apiKeys.google;
  }

  async function main() {
    logger.banner('🚀 Codey');
    logger.info(`Starting on port ${configManager.getPort()}`);
    logger.info(`Default agent: ${configManager.getDefaultAgent()}`);
    logger.info(`Default model: ${configManager.getDefaultModel()}`);
    logger.info(`Log level: ${configManager.getLogLevel()}`);

    const gateway = new Codey(gatewayConfig, logger, './workspaces');

    // Start health server on port + 1
    const healthPort = configManager.getPort() + 1;
    const healthServer = new HealthServer(healthPort, (): any => gateway.getHealthStatus());
    await healthServer.start();

    // Handle shutdown
    process.on('SIGINT', async () => {
      logger.info('Shutting down...');
      await healthServer.stop();
      await gateway.stop();
      process.exit(0);
    });

    process.on('SIGTERM', async () => {
      logger.info('Shutting down...');
      await healthServer.stop();
      await gateway.stop();
      process.exit(0);
    });

    await gateway.start();
  }

  main().catch((err) => {
    logger.error(`Failed to start: ${err.message}`);
    process.exit(1);
  });
}

async function startTui(): Promise<void> {
  const gatewayConfig: GatewayConfig = {
    port: configManager.getPort(),
    defaultAgent: configManager.getDefaultAgent() as any,
    agents: config.agents as any,
    channels: {},
  };

  if (config.apiKeys.anthropic) {
    process.env.ANTHROPIC_API_KEY = config.apiKeys.anthropic;
  }
  if (config.apiKeys.openai) {
    process.env.OPENAI_API_KEY = config.apiKeys.openai;
  }
  if (config.apiKeys.google) {
    process.env.GOOGLE_API_KEY = config.apiKeys.google;
  }

  const gateway = new Codey(gatewayConfig, logger, './workspaces');

  // Set working directory from CLI arg: npm run tui -- /path/to/project
  const tuiDir = args[1];
  if (tuiDir) {
    const path = require('path');
    const fs = require('fs');
    const resolved = path.resolve(tuiDir);
    if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
      await gateway.setWorkingDir(resolved);
    } else {
      logger.error(`Directory not found: ${resolved}`);
      process.exit(1);
    }
  }

  process.on('SIGINT', async () => {
    await gateway.stop();
    process.exit(0);
  });

  logger.banner('🤖 Codey TUI');
  logger.info(`Agent: ${configManager.getDefaultAgent()}`);
  logger.info(`Model: ${configManager.getDefaultModel()}`);
  logger.info(`Working dir: ${tuiDir ? require('path').resolve(tuiDir) : process.cwd()}`);

  await gateway.startTui();
}
