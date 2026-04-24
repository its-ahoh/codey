import dotenv from 'dotenv';
import { ConfigManager } from './config';
import { Logger } from './logger';
import { handleCommand } from './cli';
import { GatewayConfig } from '@codey/core';
import { Codey } from './gateway';
import { ApiServer, HealthStatusType } from './health';
import { assertNoLegacyLayout } from './startup-guard';

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
    models: config.models,
    fallback: config.fallback,
    channels: {
      telegram: config.channels.telegram?.enabled ? {
        botToken: config.channels.telegram.botToken,
        notifyChatId: config.channels.telegram.notifyChatId
      } : undefined,
      discord: config.channels.discord?.enabled ? { botToken: config.channels.discord.botToken } : undefined,
      imessage: config.channels.imessage?.enabled ? { enabled: true } : undefined,
    },
  };

  async function main() {
    assertNoLegacyLayout('./workspaces');
    const { WorkerManager } = await import('@codey/core');
    const workerManager = new WorkerManager('./workers');
    await workerManager.loadWorkers();
    logger.banner('🚀 Codey');
    logger.info(`Starting on port ${configManager.getPort()}`);
    logger.info(`Default agent: ${configManager.getDefaultAgent()}`);
    logger.info(`Default model: ${configManager.getDefaultModel()}`);
    logger.info(`Models in catalog: ${configManager.listModels().length}`);
    logger.info(`Fallback: ${configManager.getFallback().enabled ? 'on' : 'off'} (${configManager.getFallback().order.join(' → ')})`);
    logger.info(`Log level: ${configManager.getLogLevel()}`);

    const gateway = new Codey(gatewayConfig, logger, './workspaces', configManager, workerManager);

    // Start API server on the gateway port
    const apiServer = new ApiServer(configManager.getPort(), (): any => gateway.getHealthStatus(), configManager);
    await apiServer.start();

    // Apply config changes to the running gateway at runtime
    configManager.on('change', (updated) => {
      const newConfig: GatewayConfig = {
        port: updated.gateway.port,
        defaultAgent: updated.gateway.defaultAgent as any,
        agents: updated.agents as any,
        models: updated.models,
        fallback: updated.fallback,
        channels: gatewayConfig.channels, // channels require restart
      };
      gateway.applyConfig(newConfig);
    });

    // Handle shutdown
    process.on('SIGINT', async () => {
      logger.info('Shutting down...');
      await apiServer.stop();
      await gateway.stop();
      process.exit(0);
    });

    process.on('SIGTERM', async () => {
      logger.info('Shutting down...');
      await apiServer.stop();
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
  assertNoLegacyLayout('./workspaces');
  const { WorkerManager } = await import('@codey/core');
  const workerManager = new WorkerManager('./workers');
  await workerManager.loadWorkers();
  const gatewayConfig: GatewayConfig = {
    port: configManager.getPort(),
    defaultAgent: configManager.getDefaultAgent() as any,
    agents: config.agents as any,
    models: config.models,
    fallback: config.fallback,
    channels: {},
  };

  const gateway = new Codey(gatewayConfig, logger, './workspaces', configManager, workerManager);

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
