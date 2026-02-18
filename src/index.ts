import dotenv from 'dotenv';
import { CodingGateway } from './gateway';
import { GatewayConfig } from './types';

dotenv.config();

const config: GatewayConfig = {
  port: parseInt(process.env.PORT || '3000'),
  defaultAgent: (process.env.DEFAULT_AGENT as any) || 'claude-code',
  channels: {
    telegram: process.env.TELEGRAM_BOT_TOKEN ? {
      botToken: process.env.TELEGRAM_BOT_TOKEN,
    } : undefined,
    discord: process.env.DISCORD_BOT_TOKEN ? {
      botToken: process.env.DISCORD_BOT_TOKEN,
    } : undefined,
    imessage: process.env.IMESSAGE_ENABLED === 'true' ? {
      enabled: true,
    } : undefined,
  },
};

async function main() {
  const gateway = new CodingGateway(config);

  // Handle shutdown
  process.on('SIGINT', async () => {
    await gateway.stop();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    await gateway.stop();
    process.exit(0);
  });

  await gateway.start();
}

main().catch(console.error);
