import * as path from 'path';
import { AgentRequest, AgentResponse, GatewayConfig, GatewayResponse, UserMessage, CodingAgent, ModelConfig } from './types';
import { TelegramHandler, DiscordHandler, IMessageHandler, TuiHandler, ChannelHandler } from './channels';
import { AgentFactory } from './agents';
import { Logger } from './logger';
import { ConversationManager } from './conversation';
import { WorkspaceManager } from './workspace';

interface ParsedCommand {
  command: string;
  args: string[];
  agent?: CodingAgent;
  model?: ModelConfig;
  prompt: string;
}

interface DirectoryResolveResult {
  success: boolean;
  directory?: string;
  workspace?: string;
  isWorkspaceName?: boolean;
}

export class Codey {
  private config: GatewayConfig;
  private agentFactory: AgentFactory;
  private handlers: Map<string, ChannelHandler> = new Map();
  private processingMessages: Set<string> = new Set();
  private logger: Logger;
  private conversationManager: ConversationManager;
  private workspaceManager: WorkspaceManager;
  
  // Rate limiting: userId -> last request timestamp
  private userCooldowns: Map<string, number> = new Map();
  private readonly COOLDOWN_MS: number;

  // Response chunking
  private readonly MAX_MESSAGE_LENGTH = 2000;

  // Stats
  private messagesProcessed = 0;
  private errors = 0;
  private startTime = Date.now();
  private conversationId?: string;
  private tuiMode = false;
  private workingDir: string = process.cwd();

  // Pre-compiled regex patterns for parseCommand
  private static readonly REGEX_COMMAND = /^\/(\w+)(?:\s+(.*))?$/;
  private static readonly REGEX_WORKER = /\/worker\s+(\w+)\s+(.+)/i;
  private static readonly REGEX_TEAM = /\/team\s+(.+)/i;
  private static readonly REGEX_AGENT_PROMPT = /\/agent\s+(claude-code|opencode|codex)\s+(.+)/i;
  private static readonly REGEX_AGENT = /\/agent\s+(claude-code|opencode|codex)/i;
  private static readonly REGEX_MODEL_PROMPT = /\/model\s+(\S+)(?:\s+(.+))?/i;
  private static readonly REGEX_MODEL = /\/model\s+(\S+)/i;
  private static readonly REGEX_HELP_COMMAND = /^\/(help|status|clear|reset|model|agents|config)\s*/i;

  private getEffectiveModel(agent?: CodingAgent): string {
    const effectiveAgent = agent || this.config.defaultAgent;
    return this.config.agents?.[effectiveAgent]?.defaultModel || 'unknown';
  }

  private getDefaultModelConfig(agent: CodingAgent): ModelConfig | undefined {
    const agentConfig = this.config.agents?.[agent];
    if (!agentConfig?.defaultModel) return undefined;
    const defaultModel = agentConfig.defaultModel;

    // Match by model name or provider/model format
    const found = agentConfig.models?.find(m =>
      m.model === defaultModel || `${m.provider}/${m.model}` === defaultModel
    );
    if (found) return found;

    // Parse provider/model format
    if (defaultModel.includes('/')) {
      const [provider, model] = defaultModel.split('/', 2);
      return { provider: provider as any, model };
    }

    return { provider: 'anthropic', model: defaultModel };
  }

  private conversationCleanupInterval?: NodeJS.Timeout;

  constructor(config: GatewayConfig, logger?: Logger, workspaceDir?: string) {
    this.config = config;
    this.agentFactory = new AgentFactory();
    this.logger = logger || Logger.getInstance();
    this.conversationManager = new ConversationManager();
    this.workspaceManager = new WorkspaceManager(workspaceDir || './workspaces');
    this.COOLDOWN_MS = config.rateLimitMs || 3000; // Default 3 seconds
  }

  private async switchWorkspace(workspaceId: string): Promise<boolean> {
    const success = await this.workspaceManager.switchWorkspace(workspaceId);
    if (success) {
      this.workingDir = this.workspaceManager.getWorkingDir();
      this.resetSession();
      this.logger.setLogFile(this.workspaceManager.getLogPath());
      this.logger.setErrorLogFile(this.workspaceManager.getErrorLogPath());
      this.logger.info(`Switched to workspace: ${workspaceId} (dir: ${this.workingDir})`);
    }
    return success;
  }

  private resetSession(): void {
    this.conversationId = undefined;
    this.agentFactory.resetSessions();
  }

  async start(): Promise<void> {
    this.startTime = Date.now();
    this.logger.info('Starting Codey...');

    // Load workspace and workers
    await this.workspaceManager.load();
    this.workingDir = this.workspaceManager.getWorkingDir();
    this.logger.setLogFile(this.workspaceManager.getLogPath());
    this.logger.setErrorLogFile(this.workspaceManager.getErrorLogPath());

    // Start Telegram
    if (this.config.channels.telegram) {
      const handler = new TelegramHandler();
      handler.onMessage(this.handleMessage.bind(this));
      await handler.start(this.config.channels.telegram);
      this.handlers.set('telegram', handler);
      this.logger.info('Telegram handler started');
    }

    // Start Discord
    if (this.config.channels.discord) {
      const handler = new DiscordHandler();
      handler.onMessage(this.handleMessage.bind(this));
      await handler.start(this.config.channels.discord);
      this.handlers.set('discord', handler);
      this.logger.info('Discord handler started');
    }

    // Start iMessage
    if (this.config.channels.imessage?.enabled) {
      const handler = new IMessageHandler();
      handler.onMessage(this.handleMessage.bind(this));
      await handler.start(this.config.channels.imessage);
      this.handlers.set('imessage', handler);
      this.logger.info('iMessage handler started');
    }

    // Start conversation cleanup interval
    this.conversationCleanupInterval = setInterval(() => {
      const cleaned = this.conversationManager.cleanup();
      if (cleaned > 0) {
        this.logger.debug(`Cleaned up ${cleaned} expired conversations`);
      }
    }, 60000); // Every minute

    this.logger.info(`Started on port ${this.config.port}`);

    // Send startup notification to all active channels
    await this.sendStartupNotification();
  }

  private async sendStartupNotification(): Promise<void> {
    const channels = [...this.handlers.keys()].join(', ') || 'none';
    const agents = this.getEnabledAgents().join(', ');
    const defaultAgent = this.config.defaultAgent;
    const workspace = this.workspaceManager.getCurrentWorkspace();
    const workingDir = this.workingDir;

    const text = [
      `Codey is online`,
      ``,
      `Agent: ${defaultAgent}`,
      `Active agents: ${agents}`,
      `Channels: ${channels}`,
      `Workspace: ${workspace}`,
      `Working dir: ${workingDir}`,
      `Port: ${this.config.port}`,
    ].join('\n');

    for (const [, handler] of this.handlers) {
      try {
        await handler.sendStartupMessage?.(text);
      } catch (error) {
        // Ignore errors on startup notification
        this.logger.error(`Error sending startup notification to ${handler.name}: ${error}`);
      }
    }
  }

  async setWorkingDir(dir: string): Promise<void> {
    this.workingDir = dir;
    const ws = await this.workspaceManager.findOrCreateByDir(dir);
    this.resetSession();
    this.logger.info(`Workspace for ${dir}: ${ws}`);
  }

  async startTui(): Promise<void> {
    this.startTime = Date.now();
    this.tuiMode = true;
    this.logger.info('Starting Codey in TUI mode...');

    await this.workspaceManager.load();
    if (this.workingDir === process.cwd()) {
      this.workingDir = this.workspaceManager.getWorkingDir();
    }
    this.logger.setLogFile(this.workspaceManager.getLogPath());
    this.logger.setErrorLogFile(this.workspaceManager.getErrorLogPath());

    const handler = new TuiHandler();
    handler.onMessage(this.handleMessage.bind(this));
    await handler.start();
    this.handlers.set('tui', handler);

    this.logger.info('TUI mode active');
  }

  async stop(): Promise<void> {
    this.logger.info('Stopping...');
    if (this.conversationCleanupInterval) {
      clearInterval(this.conversationCleanupInterval);
      this.conversationCleanupInterval = undefined;
    }
    for (const handler of this.handlers.values()) {
      await handler.stop();
    }
  }

  getHealthStatus() {
    return {
      status: this.errors > 10 ? 'degraded' : 'healthy',
      uptime: Math.floor((Date.now() - this.startTime) / 1000),
      timestamp: new Date().toISOString(),
      channels: {
        telegram: this.handlers.has('telegram'),
        discord: this.handlers.has('discord'),
        imessage: this.handlers.has('imessage'),
      },
      stats: {
        messagesProcessed: this.messagesProcessed,
        activeConversations: 0, // Could track this
        errors: this.errors,
      },
    };
  }

  private async handleMessage(message: UserMessage): Promise<void> {
    // Skip if already processing
    if (this.processingMessages.has(message.id)) {
      return;
    }

    // Check rate limit
    if (!this.checkAndSetRateLimit(message.userId, message)) {
      return;
    }

    this.processingMessages.add(message.id);
    this.messagesProcessed++;

    try {
      this.logger.info(`[INPUT] ${message.channel}/${message.username}: ${message.text}`);

      // Parse command
      const parsed = this.parseCommand(message.text);

      // Handle built-in commands
      if (parsed.command) {
        await this.handleCommand(message, parsed);
        return;
      }

      // Process as prompt
      await this.processPrompt(message, parsed);

    } catch (error) {
      this.errors++;
      this.logger.error(`Error handling message: ${error}`);
      await this.sendResponse({
        chatId: message.chatId,
        channel: message.channel,
        text: `❌ Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
      });
    } finally {
      this.processingMessages.delete(message.id);
    }
  }

  private checkAndSetRateLimit(userId: string, message: UserMessage): boolean {
    if (this.checkRateLimit(userId)) {
      this.userCooldowns.set(userId, Date.now());
      return true;
    }
    
    this.sendResponse({
      chatId: message.chatId,
      channel: message.channel,
      text: '⏳ Please wait a moment before sending another request.',
    });
    return false;
  }

  private async processPrompt(message: UserMessage, parsed: ParsedCommand): Promise<void> {
    const { userId, chatId, channel, id: messageId } = message;

    // Get or create conversation
    const conversation = this.conversationManager.getOrCreate(
      userId,
      channel,
      this.conversationId
    );
    this.conversationId = conversation.id;

    // Build prompt with context
    const prompt = this.conversationManager.buildPrompt(conversation.id, parsed.prompt);

    // Skip empty prompts
    if (!prompt.trim()) {
      await this.sendResponse({
        chatId,
        channel,
        text: 'Please provide a prompt for the coding agent.',
      });
      return;
    }

    // Run the coding agent (with fallback on failure)
    const agent = parsed.agent || this.config.defaultAgent;
    const handler = this.handlers.get(channel);
    const onStream = handler?.streamText ? (text: string) => handler.streamText!(text) : undefined;
    const streamed = { active: false };
    const response = await this.runWithFallback(agent, {
      prompt,
      agent,
      model: parsed.model || this.getDefaultModelConfig(agent),
      timeout: this.tuiMode ? 1800000 : undefined, // 30 min for TUI
      interactive: this.tuiMode,
      onStream: onStream ? (text: string) => { streamed.active = true; onStream(text); } : undefined,
      context: {
        workingDir: this.workingDir,
      },
    });

    // Save to conversation history
    this.conversationManager.addMessage(conversation.id, 'user', parsed.prompt);
    if (response.success) {
      this.conversationManager.addMessage(conversation.id, 'assistant', response.output);
    }

    this.logger.info(`[OUTPUT] ${channel}/${message.username}: ${response.success ? '(streamed)' : response.error}${response.tokens ? ` [${response.tokens.total} tokens]` : ''}${response.duration ? ` [${response.duration}s]` : ''}`);

    // Format and send response
    const replyText = this.formatAgentResponse(response);
    
    await this.sendResponse({
      chatId,
      channel,
      text: replyText,
      replyTo: messageId,
    });
  }

  private formatAgentResponse(response: AgentResponse): string {
    if (!response.success) {
      return `❌ Error: ${response.error}`;
    }

    const tokenInfo = response.tokens
      ? `\n\n📊 Tokens: ${response.tokens.total.toLocaleString()} (in: ${response.tokens.input}, out: ${response.tokens.output})`
      : '';
    const durationInfo = response.duration
      ? `\n⏱️ Time: ${response.duration}s`
      : '';

    return response.output + tokenInfo + durationInfo;
  }

  private async handleCommand(message: UserMessage, parsed: ParsedCommand): Promise<void> {
    const { command, args } = parsed;
    const chatId = message.chatId;
    const channel = message.channel;

    switch (command) {
      case 'start':
        await this.cmdStart(chatId, channel);
        break;
      case 'help':
        await this.cmdHelp(chatId, channel);
        break;
      case 'status':
        await this.cmdStatus(chatId, channel);
        break;
      case 'clear':
        await this.cmdClear(chatId, channel);
        break;
      case 'reset':
        await this.cmdReset(chatId, channel);
        break;
      case 'model':
        await this.cmdModel(args, chatId, channel);
        break;
      case 'agent':
        await this.cmdAgent(args, chatId, channel);
        break;
      case 'agents':
        await this.cmdAgents(chatId, channel);
        break;
      case 'parallel':
      case 'all':
        await this.runParallelAgents(message, parsed.prompt);
        break;
      case 'config':
        await this.cmdConfig(chatId, channel);
        break;
      case 'workers':
        await this.cmdWorkers(chatId, channel);
        break;
      case 'worker':
        await this.cmdWorker(args, message, parsed.prompt);
        break;
      case 'team':
        await this.runTeamTask(message, parsed.prompt);
        break;
      case 'workspace':
      case 'ws':
        await this.cmdWorkspace(args, chatId, channel);
        break;
      case 'workspaces':
      case 'wss':
        await this.cmdWorkspaces(chatId, channel);
        break;
      case 'cwd':
      case 'dir':
        await this.cmdCwd(args, chatId, channel);
        break;
      default:
        return;
    }
  }

  private async cmdStart(chatId: string, channel: string): Promise<void> {
    const agents = this.getEnabledAgents().join(', ');
    const workspace = this.workspaceManager.getCurrentWorkspace();
    await this.sendResponse({
      chatId,
      channel,
      text: [
        `Welcome to Codey!`,
        ``,
        `Codey routes your prompts to coding agents that can read, write, and refactor code in your projects.`,
        ``,
        `**Current Config**`,
        `Agent: ${this.config.defaultAgent}`,
        `Model: ${this.getEffectiveModel()}`,
        `Agents: ${agents}`,
        `Workspace: ${workspace}`,
        `Working dir: ${this.workingDir}`,
        ``,
        `**What I can do**`,
        `- Send any message to get coding help from the active agent`,
        `- /worker <name> <task> — run a specific worker`,
        `- /team <task> — run workers in sequence`,
        `- /parallel <prompt> — run all agents in parallel`,
        `- /agent <name> — switch agent (${agents})`,
        `- /workspace <name> — switch workspace`,
        `- /model <name> — change model`,
        `- /status — view gateway status`,
        `- /help — full command list`,
      ].join('\n'),
    });
  }

  private async cmdHelp(chatId: string, channel: string): Promise<void> {
    await this.sendResponse({
      chatId,
      channel,
      text: this.getHelpText(),
    });
  }

  private async cmdStatus(chatId: string, channel: string): Promise<void> {
    const status = this.getHealthStatus();
    await this.sendResponse({
      chatId,
      channel,
      text: `📊 Gateway Status\n\n` +
        `Uptime: ${this.formatUptime(status.uptime)}\n` +
        `Messages: ${status.stats.messagesProcessed}\n` +
        `Errors: ${status.stats.errors}\n` +
        `Default Agent: ${this.config.defaultAgent}\n` +
        `Default Model: ${this.getEffectiveModel()}`,
    });
  }

  private async cmdClear(chatId: string, channel: string): Promise<void> {
    if (this.conversationId) {
      this.conversationManager.clear(this.conversationId);
    }
    await this.sendResponse({
      chatId,
      channel,
      text: '🗑️ Conversation history cleared.',
    });
  }

  private async cmdReset(chatId: string, channel: string): Promise<void> {
    this.resetSession();
    await this.sendResponse({
      chatId,
      channel,
      text: '🔄 Conversation reset. Starting fresh.',
    });
  }

  private async cmdModel(args: string[], chatId: string, channel: string): Promise<void> {
    if (args.length > 0) {
      const model = args.join(' ');
      await this.sendResponse({
        chatId,
        channel,
        text: `Model override is set per-session. Your next prompt will use: ${model}\n\n` +
          `To change default model permanently, use: /config set-model ${model}`,
      });
    } else {
      await this.sendResponse({
        chatId,
        channel,
        text: `Current default model: ${this.getEffectiveModel()}`,
      });
    }
  }

  private async cmdAgent(args: string[], chatId: string, channel: string): Promise<void> {
    if (args.length > 0) {
      const agentName = args[0].toLowerCase();
      const validAgents: CodingAgent[] = ['claude-code', 'opencode', 'codex'];
      if (validAgents.includes(agentName as CodingAgent)) {
        this.config.defaultAgent = agentName as CodingAgent;
        this.resetSession();
        const model = this.getEffectiveModel(agentName as CodingAgent);
        await this.sendResponse({
          chatId,
          channel,
          text: `✅ Switched to agent: **${agentName}**\nModel: ${model}`,
        });
      } else {
        await this.sendResponse({
          chatId,
          channel,
          text: `Unknown agent: ${agentName}\n\nAvailable: claude-code, opencode, codex`,
        });
      }
    } else {
      await this.sendResponse({
        chatId,
        channel,
        text: `Current agent: **${this.config.defaultAgent}**\nModel: ${this.getEffectiveModel()}\n\nSwitch with: /agent <name>`,
      });
    }
  }

  private async cmdAgents(chatId: string, channel: string): Promise<void> {
    const agentsList = this.getEnabledAgents().map(a => {
      const model = this.getEffectiveModel(a);
      const current = a === this.config.defaultAgent ? ' ← current' : '';
      return `${a} (${model})${current}`;
    }).join('\n');
    await this.sendResponse({
      chatId,
      channel,
      text: `Available agents:\n${agentsList}\n\nSwitch with: /agent <name>`,
    });
  }

  private async cmdConfig(chatId: string, channel: string): Promise<void> {
    await this.sendResponse({
      chatId,
      channel,
      text: `📋 Current Settings\n\n` +
        `Agent: ${this.config.defaultAgent}\n` +
        `Model: ${this.getEffectiveModel()}\n\n` +
        `Configure via CLI: npm run configure`,
    });
  }

  private async cmdWorkers(chatId: string, channel: string): Promise<void> {
    await this.sendResponse({
      chatId,
      channel,
      text: `👥 Available Workers\n\n${this.workspaceManager.getWorkerManager().listWorkers()}`,
    });
  }

  private async cmdWorker(args: string[], message: UserMessage, prompt: string): Promise<void> {
    const { chatId, channel } = message;
    if (args.length > 0) {
      const workerName = args[0];
      const task = args.slice(1).join(' ');
      await this.runWorker(message, workerName, task || prompt);
    } else {
      await this.sendResponse({
        chatId,
        channel,
        text: `Usage: /worker <name> <task>\n\nAvailable workers:\n${this.workspaceManager.getWorkerManager().listWorkers()}`,
      });
    }
  }

  private async cmdWorkspace(args: string[], chatId: string, channel: string): Promise<void> {
    if (args.length > 0) {
      const workspaceArg = args.join(' ');
      const result = await this.resolveDirectory(workspaceArg);
      
      if (result.success && result.workspace) {
        await this.sendResponse({
          chatId,
          channel,
          text: `✅ Switched to workspace: **${result.workspace}**\nDir: ${result.directory}\n\nWorkers:\n${this.workspaceManager.getWorkerManager().listWorkers()}`,
        });
      } else if (result.isWorkspaceName) {
        const success = await this.switchWorkspace(workspaceArg);
        if (success) {
          this.workingDir = this.workspaceManager.getWorkingDir();
          await this.sendResponse({
            chatId,
            channel,
            text: `✅ Switched to workspace: **${workspaceArg}**\nDir: ${this.workingDir}\n\nWorkers:\n${this.workspaceManager.getWorkerManager().listWorkers()}`,
          });
        } else {
          const list = this.workspaceManager.listWorkspaces().join(', ');
          await this.sendResponse({
            chatId,
            channel,
            text: `Workspace "${workspaceArg}" not found.\n\nAvailable workspaces: ${list}`,
          });
        }
      } else {
        const list = this.workspaceManager.listWorkspaces().join(', ');
        await this.sendResponse({
          chatId,
          channel,
          text: `Directory or workspace "${workspaceArg}" not found.\n\nAvailable workspaces: ${list}`,
        });
      }
    } else {
      await this.sendResponse({
        chatId,
        channel,
        text: `📁 Current workspace: **${this.workspaceManager.getCurrentWorkspace()}**\nDir: ${this.workingDir}\n\nWorkers:\n${this.workspaceManager.getWorkerManager().listWorkers()}`,
      });
    }
  }

  private async cmdWorkspaces(chatId: string, channel: string): Promise<void> {
    const workspacesList = this.workspaceManager.listWorkspaces().join(', ');
    await this.sendResponse({
      chatId,
      channel,
      text: `📁 Available workspaces:\n\n${workspacesList}\n\nSwitch with: /workspace <name>`,
    });
  }

  private async cmdCwd(args: string[], chatId: string, channel: string): Promise<void> {
    if (args.length > 0) {
      const targetDir = args.join(' ');
      const result = await this.resolveDirectory(targetDir);
      if (result.success) {
        await this.sendResponse({
          chatId,
          channel,
          text: `📂 Working directory set to: ${result.directory}\n📁 Workspace: **${result.workspace}**`,
        });
      } else {
        await this.sendResponse({
          chatId,
          channel,
          text: `Directory not found: ${result.directory}`,
        });
      }
    } else {
      await this.sendResponse({
        chatId,
        channel,
        text: `📂 Working directory: ${this.workingDir}`,
      });
    }
  }

  private getHelpText(): string {
    return `🤖 Codey Commands

👥 Workers
/workers - List all workers
/worker <name> <task> - Run a specific worker
/team <task> - Run workers in sequence

🤖 Agents (legacy)
/parallel <prompt> - Run all agents in parallel
/all <prompt> - Run all agents in parallel
/agent <name> - Switch agent

⚙️ Settings
/help - Show this message
/status - Show gateway status
/cwd [path] - Show/set working directory
/clear - Clear conversation history
/reset - Start a new conversation
/model [name] - Show/set model
/config - Show current config

Example: /worker architect design a REST API
Example: /team build a todo app
Example: /parallel create a hello world app
Example: /model gpt-4.1 write a Python script`;
  }

  private async runParallelAgents(message: UserMessage, prompt: string): Promise<void> {
    const { chatId, channel } = message;

    if (!prompt.trim()) {
      await this.sendResponse({
        chatId,
        channel,
        text: 'Please provide a prompt. Example: /parallel create a hello world app',
      });
      return;
    }

    // Send "running" message
    await this.sendResponse({
      chatId,
      channel,
      text: `🚀 Running all agents in parallel...\n\nPrompt: ${prompt.substring(0, 100)}${prompt.length > 100 ? '...' : ''}`,
    });

    // Get enabled agents
    const enabledAgents: CodingAgent[] = ['claude-code', 'opencode', 'codex'];

    // Run all agents in parallel
    const results = await Promise.allSettled(
      enabledAgents.map(agent => 
        this.agentFactory.run(agent, {
          prompt,
          agent,
          context: { workingDir: this.workingDir },
        })
      )
    );

    // Format results
    let responseText = `📊 Parallel Results (${enabledAgents.length} agents)\n\n`;
    
    for (let i = 0; i < enabledAgents.length; i++) {
      const agent = enabledAgents[i];
      const result = results[i] as PromiseSettledResult<any>;
      
      responseText += `─── ${agent.toUpperCase()} ───\n`;
      
      if (result.status === 'fulfilled') {
        const res = result.value;
        if (res.success) {
          // Truncate long responses
          const output = res.output.length > 800 
            ? res.output.substring(0, 800) + '...\n_(truncated)_' 
            : res.output;
          responseText += output + '\n\n';
        } else {
          responseText += `❌ Error: ${res.error}\n\n`;
        }
      } else {
        responseText += `❌ Failed: ${result.reason}\n\n`;
      }
    }

    await this.sendResponse({
      chatId,
      channel,
      text: responseText,
    });
  }

  private async runWorker(message: UserMessage, workerName: string, task: string): Promise<void> {
    const { chatId, channel } = message;
    const worker = this.workspaceManager.getWorkerManager().getWorker(workerName);

    if (!worker) {
      await this.sendResponse({
        chatId,
        channel,
        text: `Worker "${workerName}" not found.\n\nAvailable workers:\n${this.workspaceManager.getWorkerManager().listWorkers()}`,
      });
      return;
    }

    if (!task.trim()) {
      await this.sendResponse({
        chatId,
        channel,
        text: `Usage: /worker ${workerName} <task>\n\nExample: /worker ${workerName} design a REST API`,
      });
      return;
    }

    // Get worker config from JSON
    const codingAgent = this.workspaceManager.getWorkerManager().getWorkerCodingAgent(workerName) as CodingAgent;
    const model = this.workspaceManager.getWorkerManager().getWorkerModel(workerName);

    await this.sendResponse({
      chatId,
      channel,
      text: `👷 Running worker: **${worker.name}** (${worker.role})\n\nAgent: ${codingAgent}\nModel: ${model}\nTask: ${task.substring(0, 100)}${task.length > 100 ? '...' : ''}`,
    });

    // Build prompt with worker context
    const prompt = this.workspaceManager.getWorkerManager().buildWorkerPrompt(workerName, task);

    // Run with worker's coding agent and model
    const modelConfig: ModelConfig = {
      provider: codingAgent === 'claude-code' ? 'anthropic' : 'openai',
      model: model,
    };

    const handler = this.handlers.get(channel);
    const onStream = handler?.streamText ? (text: string) => handler.streamText!(text) : undefined;

    const response = await this.runWithFallback(codingAgent, {
      prompt,
      agent: codingAgent,
      model: modelConfig,
      interactive: this.tuiMode,
      onStream,
      context: { workingDir: this.workingDir },
    });

    const tokenInfo = response.tokens
      ? `\n\n📊 Tokens: ${response.tokens.total.toLocaleString()} (in: ${response.tokens.input}, out: ${response.tokens.output})`
      : '';
    const durationInfo = response.duration
      ? `\n⏱️ Time: ${response.duration}s`
      : '';

    const replyText = response.success
      ? `✅ **${worker.name}** completed:\n\n${response.output}${tokenInfo}${durationInfo}`
      : `❌ **${worker.name}** failed: ${response.error}`;

    await this.sendResponse({
      chatId,
      channel,
      text: replyText,
    });
  }

  private async runTeamTask(message: UserMessage, task: string): Promise<void> {
    const { chatId, channel } = message;

    if (!task.trim()) {
      await this.sendResponse({
        chatId,
        channel,
        text: `Usage: /team <task>\n\nThis runs workers in sequence based on their relationships.`,
      });
      return;
    }

    const workers = this.workspaceManager.getWorkerManager().getAllWorkers();
    if (workers.length === 0) {
      await this.sendResponse({
        chatId,
        channel,
        text: 'No workers configured. Add markdown files to the workspace workers/ folder.',
      });
      return;
    }

    await this.sendResponse({
      chatId,
      channel,
      text: `👥 Running team task: ${task.substring(0, 100)}${task.length > 100 ? '...' : ''}`,
    });

    // Run each worker in sequence
    let currentTask = task;
    let results: string[] = [];

    for (const worker of workers) {
      const codingAgent = this.workspaceManager.getWorkerManager().getWorkerCodingAgent(worker.name) as CodingAgent;
      const model = this.workspaceManager.getWorkerManager().getWorkerModel(worker.name);

      await this.sendResponse({
        chatId,
        channel,
        text: `🔄 Worker **${worker.name}** is working...`,
      });

      const prompt = this.workspaceManager.getWorkerManager().buildWorkerPrompt(worker.name, currentTask);
      const modelConfig: ModelConfig = {
        provider: codingAgent === 'claude-code' ? 'anthropic' : 'openai',
        model: model,
      };

      const handler = this.handlers.get(channel);
      const onStream = handler?.streamText ? (text: string) => handler.streamText!(text) : undefined;

      const response = await this.runWithFallback(codingAgent, {
        prompt,
        agent: codingAgent,
        model: modelConfig,
        interactive: this.tuiMode,
        onStream,
        context: { workingDir: this.workingDir },
      });

      if (response.success) {
        results.push(`**${worker.name}**: ${response.output.substring(0, 500)}`);
        // Pass output to next worker as context
        currentTask = `Previous worker output:\n${response.output}\n\nYour task: ${task}`;
      } else {
        results.push(`**${worker.name}**: ❌ Failed - ${response.error}`);
        break;
      }
    }

    await this.sendResponse({
      chatId,
      channel,
      text: `📊 Team Results\n\n${results.join('\n\n')}`,
    });
  }

  private formatUptime(seconds: number): string {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    return `${h}h ${m}m ${s}s`;
  }

  private parseCommand(text: string): ParsedCommand {
    // First check for commands
    const commandMatch = text.match(/^\/(\w+)(?:\s+(.*))?$/);
    
    if (commandMatch) {
      const command = commandMatch[1].toLowerCase();
      const argsStr = commandMatch[2] || '';
      const args = argsStr.split(/\s+/).filter(Boolean);
      
      // Check for worker command: /worker architect design something
      const workerMatch = text.match(/\/worker\s+(\w+)\s+(.+)/i);
      if (workerMatch) {
        return { 
          command: 'worker', 
          args: [workerMatch[1]], 
          agent: this.config.defaultAgent as CodingAgent, 
          model: undefined, 
          prompt: workerMatch[2] 
        };
      }
      
      // Check for team command
      const teamMatch = text.match(/\/team\s+(.+)/i);
      if (teamMatch) {
        return { 
          command: 'team', 
          args: [], 
          agent: this.config.defaultAgent as CodingAgent, 
          model: undefined, 
          prompt: teamMatch[1] 
        };
      }

      // Check for agent switch
      let agent = this.config.defaultAgent as CodingAgent;
      let model: ModelConfig | undefined;
      let prompt = '';

      // Check if combined with prompt
      const promptMatch = text.match(/\/agent\s+(claude-code|opencode|codex)\s+(.+)/i);
      if (promptMatch) {
        agent = promptMatch[1] as CodingAgent;
        prompt = promptMatch[2];
      }

      const modelMatch = text.match(/\/model\s+(\S+)(?:\s+(.+))?/i);
      if (modelMatch) {
        model = this.getModelConfig(agent, modelMatch[1]);
        if (modelMatch[2]) {
          prompt = promptMatch ? prompt : modelMatch[2];
        }
      }

      return { command, args, agent, model, prompt };
    }

    // Not a command - parse agent/model from anywhere in text
    const agentMatch = text.match(/\/agent\s+(claude-code|opencode|codex)/i);
    const agent = (agentMatch ? agentMatch[1] : this.config.defaultAgent) as CodingAgent;

    const modelMatch = text.match(/\/model\s+(\S+)/i);
    let model: ModelConfig | undefined;
    if (modelMatch) {
      model = this.getModelConfig(agent, modelMatch[1]);
    }

    // Remove inline commands from prompt, but preserve the rest
    let prompt = text
      .replace(/\/agent\s+(claude-code|opencode|codex)\s*/i, '')
      .replace(/\/model\s+\S+\s*/i, '')
      .replace(/^\/(help|status|clear|reset|model|agents|config)\s*/i, '')
      .trim();

    return { command: '', args: [], agent, model, prompt };
  }

  private static readonly ALL_AGENTS: CodingAgent[] = ['claude-code', 'opencode', 'codex'];

  private getEnabledAgents(): CodingAgent[] {
    return Codey.ALL_AGENTS.filter(a => {
      const agentConfig = this.config.agents?.[a];
      return agentConfig?.enabled !== false;
    });
  }

  private async runWithFallback(agent: CodingAgent, request: AgentRequest): Promise<AgentResponse> {
    const response = await this.agentFactory.run(agent, request);
    if (response.success) return response;

    this.logger.error(`Agent ${agent} failed: ${response.error || response.output}`);

    // Try remaining enabled agents in order, using each agent's own default model
    const fallbacks = this.getEnabledAgents().filter(a => a !== agent);
    for (const fallbackAgent of fallbacks) {
      this.logger.warn(`Agent ${agent} failed, trying ${fallbackAgent}...`);
      const fallbackResponse = await this.agentFactory.run(fallbackAgent, {
        ...request,
        agent: fallbackAgent,
        model: this.getDefaultModelConfig(fallbackAgent),
      });
      if (fallbackResponse.success) {
        fallbackResponse.output = `[Fallback: ${agent} → ${fallbackAgent}]\n\n${fallbackResponse.output}`;
        return fallbackResponse;
      }
      this.logger.error(`Fallback agent ${fallbackAgent} also failed: ${fallbackResponse.error || fallbackResponse.output}`);
    }

    // All agents failed, return original error
    return response;
  }

  private checkRateLimit(userId: string): boolean {
    const lastRequest = this.userCooldowns.get(userId);
    if (!lastRequest) return true;
    return Date.now() - lastRequest >= this.COOLDOWN_MS;
  }

  private getModelConfig(agent: CodingAgent, modelName: string): ModelConfig | undefined {
    const agentConfig = this.config.agents?.[agent];
    if (agentConfig?.models) {
      const found = agentConfig.models.find(m => m.model.toLowerCase() === modelName.toLowerCase());
      if (found) return found;
    }

    const modelLower = modelName.toLowerCase();
    
    if (modelLower.startsWith('claude-') || modelLower.startsWith('claude/')) {
      return { provider: 'anthropic', model: modelName };
    }
    if (modelLower.startsWith('gpt-') || modelLower.startsWith('o') || modelLower.startsWith('chatgpt-')) {
      return { provider: 'openai', model: modelName };
    }
    if (modelLower.startsWith('gemini-') || modelLower.startsWith('google/')) {
      return { provider: 'google', model: modelName };
    }

    return undefined;
  }

  private async resolveDirectory(dirPath: string): Promise<DirectoryResolveResult> {
    const fs = require('fs');
    const resolvedDir = path.resolve(dirPath);

    if (fs.existsSync(resolvedDir) && fs.statSync(resolvedDir).isDirectory()) {
      const workspace = await this.workspaceManager.findOrCreateByDir(resolvedDir);
      this.workingDir = resolvedDir;
      return { success: true, directory: resolvedDir, workspace };
    }

    // Check if it's a workspace name
    const workspaces = this.workspaceManager.listWorkspaces();
    const isWorkspaceName = workspaces.some(ws => ws.toLowerCase() === dirPath.toLowerCase());

    return { success: false, isWorkspaceName };
  }

  private async sendResponse(response: GatewayResponse): Promise<void> {
    const handler = this.handlers.get(response.channel);
    if (!handler) return;

    try {
      // Auto-chunking for long messages
      if (response.text.length > this.MAX_MESSAGE_LENGTH) {
        await this.sendResponseWithChunking(response);
      } else {
        await handler.sendMessage(response);
      }
    } catch (error) {
      this.logger.error(`Error sending response: ${error}`);
    }
  }

  private async sendResponseWithChunking(response: GatewayResponse): Promise<void> {
    const { chatId, channel, text, replyTo } = response;
    
    if (text.length <= this.MAX_MESSAGE_LENGTH) {
      await this.sendResponse({ chatId, channel, text, replyTo });
      return;
    }

    const chunks = this.splitIntoChunks(text, this.MAX_MESSAGE_LENGTH);
    
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const isLast = i === chunks.length - 1;
      const header = i > 0 ? `[${i + 1}/${chunks.length}]\n` : '';
      const footer = !isLast ? `\n\n_(continued...)_` : '';
      
      await this.sendResponse({
        chatId,
        channel,
        text: header + chunk + footer,
        replyTo: isLast ? replyTo : undefined,
      });
    }
  }

  private splitIntoChunks(text: string, maxLength: number): string[] {
    const chunks: string[] = [];
    const lines = text.split('\n');
    let currentChunk = '';

    for (const line of lines) {
      if (currentChunk.length + line.length + 1 > maxLength && currentChunk.length > 0) {
        chunks.push(currentChunk);
        currentChunk = '';
      }
      currentChunk += (currentChunk ? '\n' : '') + line;
    }

    if (currentChunk) {
      chunks.push(currentChunk);
    }

    return chunks;
  }
}
