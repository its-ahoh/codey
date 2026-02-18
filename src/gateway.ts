import { GatewayConfig, GatewayResponse, UserMessage, CodingAgent } from './types';
import { TelegramHandler, DiscordHandler, IMessageHandler } from './channels';
import { AgentFactory } from './agents';

export class CodingGateway {
  private config: GatewayConfig;
  private agentFactory: AgentFactory;
  private handlers: Map<string, any> = new Map();
  private processingMessages: Set<string> = new Set();

  constructor(config: GatewayConfig) {
    this.config = config;
    this.agentFactory = new AgentFactory();
  }

  async start(): Promise<void> {
    console.log('[Gateway] Starting CodingGateway...');

    // Start Telegram
    if (this.config.channels.telegram) {
      const handler = new TelegramHandler();
      handler.onMessage(this.handleMessage.bind(this));
      await handler.start(this.config.channels.telegram);
      this.handlers.set('telegram', handler);
    }

    // Start Discord
    if (this.config.channels.discord) {
      const handler = new DiscordHandler();
      handler.onMessage(this.handleMessage.bind(this));
      await handler.start(this.config.channels.discord);
      this.handlers.set('discord', handler);
    }

    // Start iMessage
    if (this.config.channels.imessage?.enabled) {
      const handler = new IMessageHandler();
      handler.onMessage(this.handleMessage.bind(this));
      await handler.start(this.config.channels.imessage);
      this.handlers.set('imessage', handler);
    }

    console.log(`[Gateway] Started on port ${this.config.port}`);
  }

  async stop(): Promise<void> {
    console.log('[Gateway] Stopping...');
    for (const handler of this.handlers.values()) {
      await handler.stop();
    }
  }

  private async handleMessage(message: UserMessage): Promise<void> {
    // Skip if already processing
    if (this.processingMessages.has(message.id)) {
      return;
    }
    this.processingMessages.add(message.id);

    try {
      console.log(`[Gateway] Received from ${message.channel}/${message.username}: ${message.text.substring(0, 50)}...`);

      // Parse agent selection from message (e.g., "@bot /agent claude-code create a file")
      const { agent, prompt } = this.parseMessage(message.text);

      // Send "typing" indicator
      await this.sendResponse({
        chatId: message.chatId,
        channel: message.channel,
        text: '🤔 Thinking...',
      });

      // Run the coding agent
      const response = await this.agentFactory.run(agent, {
        prompt,
        agent,
        context: {
          workingDir: process.cwd(),
        },
      });

      // Send response back to user
      const replyText = response.success 
        ? response.output 
        : `❌ Error: ${response.error}`;

      await this.sendResponse({
        chatId: message.chatId,
        channel: message.channel,
        text: replyText,
        replyTo: message.id,
      });

    } catch (error) {
      console.error('[Gateway] Error handling message:', error);
      await this.sendResponse({
        chatId: message.chatId,
        channel: message.channel,
        text: `❌ Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
      });
    } finally {
      this.processingMessages.delete(message.id);
    }
  }

  private parseMessage(text: string): { agent: CodingAgent; prompt: string } {
    // Check for agent override: /agent claude-code, /agent opencode, /agent codex
    const agentMatch = text.match(/\/agent\s+(claude-code|opencode|codex)/i);
    const agent = (agentMatch ? agentMatch[1] : this.config.defaultAgent) as CodingAgent;

    // Remove the agent command from the prompt
    let prompt = text.replace(/\/agent\s+(claude-code|opencode|codex)\s*/i, '').trim();
    
    // Remove common prefixes
    prompt = prompt.replace(/^(hey|hi|hello|yo)\s*(bot|assistant)?\s*/i, '').trim();

    return { agent, prompt };
  }

  private async sendResponse(response: GatewayResponse): Promise<void> {
    const handler = this.handlers.get(response.channel);
    if (handler) {
      await handler.sendMessage(response);
    }
  }
}
