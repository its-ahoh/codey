import * as path from 'path';
import * as fs from 'fs';
import { AgentRequest, AgentResponse, GatewayConfig, GatewayResponse, UserMessage, CodingAgent, ModelConfig, ChannelType, ChannelConfig, ChatMessage, ToolCallEntry } from '@codey/core';
import { randomUUID } from 'crypto';
import { ConfigManager } from './config';
import { TelegramHandler, DiscordHandler, IMessageHandler, TuiHandler, ChannelHandler } from './channels';
import { AgentFactory } from '@codey/core';
import { Logger } from './logger';
import { ContextManager, ContextWindow } from '@codey/core';
import { MemoryStore } from '@codey/core';
import { TaskPlanner, TaskPlan, PlanStep } from '@codey/core';
import { WorkspaceManager } from '@codey/core';
import { WorkerManager } from '@codey/core';
import { ChatManager } from './chats';
import { buildChatPrompt, assistantPrefixForSelection, RunSemaphore, ChatStreamSink } from './chat-runner';

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
  private contextManager: ContextManager;
  private planner: TaskPlanner;
  private workspaceManager: WorkspaceManager;
  private chatManager: ChatManager;
  private configManager?: ConfigManager;
  private chatSemaphore = new RunSemaphore();

  // Rate limiting: userId -> last request timestamp
  private userCooldowns: Map<string, number> = new Map();
  private readonly COOLDOWN_MS: number;

  // Response chunking
  private readonly MAX_MESSAGE_LENGTH = 2000;

  // Stats
  private messagesProcessed = 0;
  private errors = 0;
  private startTime = Date.now();
  private tuiMode = false;
  private workingDir: string = process.cwd();

  // Pre-compiled regex patterns for parseCommand
  private static readonly REGEX_COMMAND = /^\/(\w+)(?:\s+(.*))?$/;
  private static readonly REGEX_WORKER = /\/worker\s+(\w+)\s+(.+)/i;
  private static readonly REGEX_TEAM = /\/team\s+(\w+)\s+(.+)/i;
  private static readonly REGEX_AGENT_PROMPT = /\/agent\s+(claude-code|opencode|codex)\s+(.+)/i;
  private static readonly REGEX_AGENT = /\/agent\s+(claude-code|opencode|codex)/i;
  private static readonly REGEX_MODEL_PROMPT = /\/model\s+(\S+)(?:\s+(.+))?/i;
  private static readonly REGEX_MODEL = /\/model\s+(\S+)/i;
  private static readonly REGEX_HELP_COMMAND = /^\/(help|status|clear|reset|model|agents|config)\s*/i;

  private getEffectiveModel(agent?: CodingAgent): string {
    const effectiveAgent = agent || this.config.defaultAgent;
    const modelName = this.config.agents?.[effectiveAgent]?.defaultModel;
    if (!modelName) return 'unknown';
    const entry = this.configManager?.getModel(modelName);
    return entry?.model || modelName;
  }

  /**
   * Resolve the ModelConfig the agent adapter should use. The agent's
   * defaultModel names a ModelEntry in the global catalog; we copy its
   * apiType, baseUrl, and apiKey through so the adapter can set the
   * right env vars when spawning the CLI.
   */
  getDefaultModelConfig(agent: CodingAgent): ModelConfig | undefined {
    const agentConfig = this.config.agents?.[agent];
    const modelName = agentConfig?.defaultModel;
    if (!modelName) return undefined;
    const entry = this.configManager?.getModel(modelName);
    if (!entry) {
      // Bare model id — still callable, but no credentials attached.
      return { provider: 'unknown', model: modelName };
    }
    return {
      provider: entry.provider ?? (entry.apiType === 'anthropic' ? 'anthropic' : 'openai'),
      model: entry.model,
      apiKey: entry.apiKey,
      baseUrl: entry.baseUrl,
      apiType: entry.apiType,
    };
  }

  private conversationCleanupInterval?: NodeJS.Timeout;

  constructor(config: GatewayConfig, logger?: Logger, workspaceDir?: string, configManager?: ConfigManager, workerManager?: WorkerManager) {
    this.config = config;
    this.configManager = configManager;
    this.agentFactory = new AgentFactory();
    this.logger = logger || Logger.getInstance();
    this.contextManager = new ContextManager({
      maxTokenBudget: config.context?.maxTokenBudget ?? 12000,
      maxTurns: config.context?.maxTurns ?? 30,
      ttlMs: (config.context?.ttlMinutes ?? 60) * 60 * 1000,
      persistDir: './workspaces',
    });
    const restored = this.contextManager.load();
    if (restored > 0) {
      this.logger.info(`Restored ${restored} archived conversation(s) from disk`);
    }
    // Planner uses its own Anthropic key: prefer an anthropic-apiType model
    // in the catalog that has an apiKey set, else fall back to env.
    const anthropicEntry = this.configManager?.listModels().find(m => m.apiType === 'anthropic' && !!m.apiKey);
    const plannerApiKey = anthropicEntry?.apiKey || process.env.ANTHROPIC_API_KEY;
    this.planner = new TaskPlanner({
      enabled: config.planner?.enabled !== false,
      plannerModel: config.planner?.model || 'claude-sonnet-4-20250514',
      maxPlanTokens: config.planner?.maxTokens || 1500,
      minPromptLength: config.planner?.minPromptLength || 80,
      apiKey: plannerApiKey,
    });
    const wm = workerManager || new WorkerManager('./workers');
    this.workspaceManager = new WorkspaceManager(wm, workspaceDir || './workspaces');
    this.chatManager = new ChatManager(this.workspaceManager.getWorkspacesRoot());
    this.COOLDOWN_MS = config.rateLimitMs || 3000; // Default 3 seconds
  }

  /** Apply runtime config changes (e.g. from the API). */
  async applyConfig(config: GatewayConfig): Promise<void> {
    const prevChannels = this.config.channels;
    this.config = config;
    this.logger.info(`[Config] Applied: agent=${config.defaultAgent}, model=${this.getEffectiveModel()}`);
    await this.reconcileChannels(prevChannels, config.channels);
  }

  /**
   * Start, stop, or restart channel handlers to match the desired config.
   * A channel is restarted when its config payload changes (e.g. token edit).
   */
  private async reconcileChannels(prev: ChannelConfig, next: ChannelConfig): Promise<void> {
    await this.reconcileChannel('telegram', prev.telegram, next.telegram, () => new TelegramHandler());
    await this.reconcileChannel('discord',  prev.discord,  next.discord,  () => new DiscordHandler());
    const prevIm = prev.imessage?.enabled ? prev.imessage : undefined;
    const nextIm = next.imessage?.enabled ? next.imessage : undefined;
    await this.reconcileChannel('imessage', prevIm, nextIm, () => new IMessageHandler());
  }

  private async reconcileChannel(
    name: 'telegram' | 'discord' | 'imessage',
    prev: any | undefined,
    next: any | undefined,
    factory: () => ChannelHandler,
  ): Promise<void> {
    const same = JSON.stringify(prev ?? null) === JSON.stringify(next ?? null);
    if (same && (next ? this.handlers.has(name) : !this.handlers.has(name))) return;

    const existing = this.handlers.get(name);
    if (existing) {
      try { await existing.stop(); }
      catch (e) { this.logger.error(`Failed to stop ${name} handler: ${e}`); }
      this.handlers.delete(name);
      this.logger.info(`${name} handler stopped`);
    }

    if (next) {
      try {
        const handler = factory();
        handler.onMessage(this.handleMessage.bind(this));
        await handler.start(next);
        this.handlers.set(name, handler);
        this.logger.info(`${name} handler started`);
      } catch (e) {
        this.logger.error(`Failed to start ${name} handler: ${e}`);
      }
    }
  }

  getWorkspaceList(): string[] {
    return this.workspaceManager.listWorkspaces();
  }

  getWorkspaceManager(): WorkspaceManager { return this.workspaceManager; }
  getChatManager(): ChatManager { return this.chatManager; }

  getAgentFactory(): AgentFactory { return this.agentFactory; }

  getWorkingDir(): string { return this.workingDir; }

  getEffectiveModelConfig(): ModelConfig {
    const agent = this.config.defaultAgent;
    return this.getDefaultModelConfig(agent) || {
      provider: 'anthropic',
      model: this.getEffectiveModel(agent),
    };
  }

  async switchWorkspaceByName(name: string): Promise<boolean> {
    return this.switchWorkspace(name);
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
    this.agentFactory.resetSessions();
    this.contextManager.clearAllSessionAnchors();
  }

  /**
   * Decide how to call the agent for this turn. Resume mode: the same agent
   * already has a warm CLI session for this conversation → send only the
   * current prompt, attach the agent's resume flag. Bootstrap mode: cold
   * start, agent change, or no warm anchor → build a full-history prompt.
   *
   * claude-code lets us pre-allocate a UUID and pin it via `--session-id`,
   * so we know the id before the run. codex and opencode generate the id
   * themselves; the adapters surface it via `response.sessionId` and the
   * gateway records it in `commitSessionAnchor` post-run.
   */
  private prepareAgentTurn(
    ctxWindow: ContextWindow,
    agent: CodingAgent,
    rawPrompt: string,
    memoryContext: string | undefined,
  ): { prompt: string; resumeSessionId?: string; newSessionId?: string } {
    const anchor = ctxWindow.sessionAnchor;
    if (anchor && anchor.agent === agent) {
      return { prompt: rawPrompt, resumeSessionId: anchor.sessionId };
    }
    const bootstrap: { prompt: string; newSessionId?: string } = {
      prompt: this.contextManager.buildPrompt(ctxWindow.id, rawPrompt, memoryContext),
    };
    if (agent === 'claude-code') {
      // claude-code accepts a pre-allocated UUID via `--session-id`.
      bootstrap.newSessionId = randomUUID();
    }
    return bootstrap;
  }

  /**
   * After a turn completes, persist or invalidate the session anchor.
   *
   * - claude-code success → store the pre-allocated `newSessionId`.
   * - codex / opencode success → store the id the CLI emitted on the run
   *   (returned via `response.sessionId`).
   * - Resume run that succeeded → leave the existing anchor alone.
   * - Run by a different agent than the current anchor → drop the anchor so
   *   the next turn for the previous agent re-bootstraps with the
   *   cross-agent history.
   */
  private async commitSessionAnchor(
    ctxWindow: ContextWindow,
    agent: CodingAgent,
    response: AgentResponse,
    newSessionId: string | undefined,
    resumed: boolean,
  ): Promise<void> {
    if (!response.success) return;

    if (resumed) {
      // Anchor already correct — nothing to do.
      return;
    }

    const anchorId = newSessionId ?? response.sessionId;
    if (anchorId) {
      await this.contextManager.setSessionAnchor(ctxWindow.id, {
        agent,
        sessionId: anchorId,
      });
    } else if (ctxWindow.sessionAnchor && ctxWindow.sessionAnchor.agent !== agent) {
      // Different agent ran successfully but didn't surface a session id —
      // invalidate the stale anchor so a later turn re-bootstraps.
      await this.contextManager.clearSessionAnchor(ctxWindow.id);
    }
  }

  async start(): Promise<void> {
    this.startTime = Date.now();
    this.logger.info('Starting Codey...');

    // Load workspace and workers
    await this.workspaceManager.load();
    this.workingDir = this.workspaceManager.getWorkingDir();
    this.logger.setLogFile(this.workspaceManager.getLogPath());
    this.logger.setErrorLogFile(this.workspaceManager.getErrorLogPath());

    // Start configured channels (telegram/discord/imessage)
    await this.reconcileChannels({}, this.config.channels);

    // Start context cleanup interval
    this.conversationCleanupInterval = setInterval(() => {
      const ctxCleaned = this.contextManager.cleanup();
      if (ctxCleaned > 0) {
        this.logger.debug(`Cleaned up ${ctxCleaned} expired context windows`);
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
    this.contextManager.shutdown();
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

    // Get or create structured context window keyed by conversationId
    const conversationId = message.conversationId ?? `${message.channel}-${message.chatId}`;
    const ctxWindow = await this.contextManager.getOrCreate(conversationId);

    // Build memory context from workspace memory store
    const memoryStore = this.workspaceManager.getMemoryStore();
    const memoryContext = (this.config.memory?.enabled !== false)
      ? memoryStore.buildContext(parsed.prompt)
      : undefined;

    // Skip empty prompts
    if (!parsed.prompt.trim()) {
      await this.sendResponse({
        chatId,
        channel,
        text: 'Please provide a prompt for the coding agent.',
      });
      return;
    }

    const agent = parsed.agent || this.config.defaultAgent;

    // ── Task planning ─────────────────────────────────────────
    const plan = await this.planner.plan(parsed.prompt, memoryContext);

    if (plan && plan.needsPlanning && plan.steps.length > 0) {
      // Execute as a planned multi-step task
      await this.executePlannedTask(message, parsed, plan, ctxWindow.id, agent);
      return;
    }

    // ── Single-step execution (default path) ──────────────────
    const handler = this.handlers.get(channel);
    const onStream = handler?.streamText ? (text: string) => handler.streamText!(text) : undefined;
    const streamed = { active: false };

    let prep = this.prepareAgentTurn(ctxWindow, agent, parsed.prompt, memoryContext);
    const buildRequest = (p: typeof prep): AgentRequest => ({
      prompt: p.prompt,
      agent,
      model: parsed.model || this.getDefaultModelConfig(agent),
      timeout: this.tuiMode ? 1800000 : undefined, // 30 min for TUI
      interactive: this.tuiMode,
      onStream: onStream ? (text: string) => { streamed.active = true; onStream(text); } : undefined,
      context: { workingDir: this.workingDir },
      resumeSessionId: p.resumeSessionId,
      newSessionId: p.newSessionId,
    });

    const initialResume = prep.resumeSessionId;
    let response = await this.runWithFallback(agent, buildRequest(prep));

    // Resume failed (CLI may have GC'd the session) — drop the anchor and
    // retry once with a full-history bootstrap so we recover transparently.
    if (!response.success && prep.resumeSessionId) {
      this.logger.warn(`[${agent}] Resume of ${prep.resumeSessionId} failed; retrying with bootstrap`);
      await this.contextManager.clearSessionAnchor(ctxWindow.id);
      prep = this.prepareAgentTurn(ctxWindow, agent, parsed.prompt, memoryContext);
      response = await this.runWithFallback(agent, buildRequest(prep));
    }

    const resumed = !!initialResume && !!prep.resumeSessionId;
    await this.commitSessionAnchor(ctxWindow, agent, response, prep.newSessionId, resumed);

    // Save to structured context
    await this.contextManager.addUserTurn(ctxWindow.id, parsed.prompt);
    const meta = ContextManager.extractMeta(response, agent);
    if (response.success) {
      await this.contextManager.addAssistantTurn(ctxWindow.id, response.output, meta);
    }

    // Auto-extract memories from the interaction
    if (this.config.memory?.autoExtract !== false && response.success) {
      memoryStore.extractFromInteraction({
        userPrompt: parsed.prompt,
        agentOutput: response.output,
        toolCalls: meta.toolCalls?.map(tc => ({
          tool: tc.tool,
          input: tc.input,
          output: tc.output,
          status: tc.status,
        })),
        filesChanged: meta.filesChanged?.map(fc => ({
          path: fc.path,
          action: fc.action,
        })),
      });
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

  /**
   * Execute a task that the planner has decomposed into multiple steps.
   * Reports progress to the user after each step completes.
   */
  private async executePlannedTask(
    message: UserMessage,
    parsed: ParsedCommand,
    plan: TaskPlan,
    ctxWindowId: string,
    agent: CodingAgent,
  ): Promise<void> {
    const { chatId, channel, id: messageId } = message;
    const handler = this.handlers.get(channel);
    const onStream = handler?.streamText ? (text: string) => handler.streamText!(text) : undefined;

    // Notify user of the plan
    await this.sendResponse({
      chatId,
      channel,
      text: `\ud83d\udcdd **Task Plan**\n${TaskPlanner.formatPlanSummary(plan)}`,
    });

    // Record user turn in context
    await this.contextManager.addUserTurn(ctxWindowId, parsed.prompt);

    // Build the agent runner function
    const runAgent = async (stepPrompt: string): Promise<AgentResponse> => {
      // Get current memory context for each step
      const memoryStore = this.workspaceManager.getMemoryStore();
      const memoryContext = (this.config.memory?.enabled !== false)
        ? memoryStore.buildContext(stepPrompt)
        : undefined;

      // Build context-aware prompt for this step
      const fullPrompt = this.contextManager.buildPrompt(ctxWindowId, stepPrompt, memoryContext);

      return this.runWithFallback(agent, {
        prompt: fullPrompt,
        agent,
        model: parsed.model || this.getDefaultModelConfig(agent),
        timeout: this.tuiMode ? 1800000 : undefined,
        interactive: this.tuiMode,
        onStream,
        context: {
          workingDir: this.workingDir,
        },
      });
    };

    // Progress callback
    const onProgress = async (step: PlanStep, stepIndex: number, totalSteps: number): Promise<void> => {
      const progressText = TaskPlanner.formatStepProgress(step, stepIndex, totalSteps);
      await this.sendResponse({
        chatId,
        channel,
        text: progressText,
      });

      // Record completed steps in context
      if (step.status === 'done' && step.output) {
        const meta = ContextManager.extractMeta({
          states: [], // Individual step states are not available here
          duration: step.duration,
        }, agent);
        await this.contextManager.addAssistantTurn(
          ctxWindowId,
          `[Step ${step.id}: ${step.title}] ${step.output.substring(0, 500)}`,
          meta,
        );
      }
    };

    // Execute the plan
    const result = await this.planner.executePlan(plan, runAgent, onProgress);

    const summaryOutput = result.outputs.join('\n\n---\n\n');

    // Auto-extract memories
    const memoryStore = this.workspaceManager.getMemoryStore();
    if (this.config.memory?.autoExtract !== false && result.success) {
      memoryStore.extractFromInteraction({
        userPrompt: parsed.prompt,
        agentOutput: summaryOutput.substring(0, 2000),
      });
    }

    // Send final summary
    const finalSummary = TaskPlanner.formatPlanSummary(result.plan);
    await this.sendResponse({
      chatId,
      channel,
      text: `\ud83c\udfc1 **Task Complete**\n${finalSummary}`,
      replyTo: messageId,
    });
  }

  private formatAgentResponse(response: AgentResponse): string {
    if (!response.success) {
      return `❌ Error: ${response.error}`;
    }

    // Summarise tool activity if any states were captured
    let toolSummary = '';
    if (response.states && response.states.length > 0) {
      // Deduplicate: count how many times each tool was used
      const toolCounts = new Map<string, number>();
      for (const s of response.states) {
        if (s.status === 'done') {
          toolCounts.set(s.source, (toolCounts.get(s.source) || 0) + 1);
        }
      }
      if (toolCounts.size > 0) {
        const parts = Array.from(toolCounts.entries()).map(
          ([name, count]) => count > 1 ? `${name} x${count}` : name
        );
        toolSummary = `\n🔧 Tools: ${parts.join(', ')}`;
      }
    }

    return response.output + toolSummary;
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
        await this.cmdClear(message.userId, chatId, channel);
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
        await this.runTeamTask(message, args[0] || '', args.slice(1).join(' ') || parsed.prompt);
        break;
      case 'teams':
        await this.cmdTeams(chatId, channel);
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
      case 'memory':
      case 'mem':
        await this.cmdMemory(args, message);
        break;
      case 'plan':
        await this.cmdPlan(args, chatId, channel);
        break;
      case 'remember':
        await this.cmdRemember(args, message);
        break;
      default:
        return;
    }
  }

  private async cmdStart(chatId: string, channel: ChannelType): Promise<void> {
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
        `- /teams — list teams for this workspace`,
        `- /team <name> <task> — run a named team in sequence`,
        `- /parallel <prompt> — run all agents in parallel`,
        `- /agent <name> — switch agent (${agents})`,
        `- /workspace <name> — switch workspace`,
        `- /model <name> — change model`,
        `- /status — view gateway status`,
        `- /help — full command list`,
      ].join('\n'),
    });
  }

  private async cmdHelp(chatId: string, channel: ChannelType): Promise<void> {
    await this.sendResponse({
      chatId,
      channel,
      text: this.getHelpText(),
    });
  }

  private async cmdStatus(chatId: string, channel: ChannelType): Promise<void> {
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

  private async cmdClear(userId: string, chatId: string, channel: ChannelType): Promise<void> {
    const conversationId = `${channel}-${chatId}`;
    await this.contextManager.clear(conversationId);
    await this.sendResponse({
      chatId,
      channel,
      text: '🗑️ Conversation history cleared.',
    });
  }

  private async cmdReset(chatId: string, channel: ChannelType): Promise<void> {
    this.resetSession();
    await this.sendResponse({
      chatId,
      channel,
      text: '🔄 Conversation reset. Starting fresh.',
    });
  }

  private async cmdModel(args: string[], chatId: string, channel: ChannelType): Promise<void> {
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

  private async cmdAgent(args: string[], chatId: string, channel: ChannelType): Promise<void> {
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

  private async cmdAgents(chatId: string, channel: ChannelType): Promise<void> {
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

  private async cmdConfig(chatId: string, channel: ChannelType): Promise<void> {
    await this.sendResponse({
      chatId,
      channel,
      text: `📋 Current Settings\n\n` +
        `Agent: ${this.config.defaultAgent}\n` +
        `Model: ${this.getEffectiveModel()}\n\n` +
        `Configure via CLI: npm run configure`,
    });
  }


  private async cmdWorkers(chatId: string, channel: ChannelType): Promise<void> {
    await this.sendResponse({
      chatId,
      channel,
      text: `👥 Available Workers\n\n${this.workspaceManager.getWorkerManager().listWorkers()}`,
    });
  }

  private async cmdTeams(chatId: string, channel: ChannelType): Promise<void> {
    await this.sendResponse({
      chatId,
      channel,
      text: `👥 Teams on workspace **${this.workspaceManager.getCurrentWorkspace()}**\n\n${this.workspaceManager.listTeams()}`,
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

  private async cmdWorkspace(args: string[], chatId: string, channel: ChannelType): Promise<void> {
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

  private async cmdWorkspaces(chatId: string, channel: ChannelType): Promise<void> {
    const workspacesList = this.workspaceManager.listWorkspaces().join(', ');
    await this.sendResponse({
      chatId,
      channel,
      text: `📁 Available workspaces:\n\n${workspacesList}\n\nSwitch with: /workspace <name>`,
    });
  }

  private async cmdCwd(args: string[], chatId: string, channel: ChannelType): Promise<void> {
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

  private async cmdMemory(args: string[], message: UserMessage): Promise<void> {
    const { chatId, channel } = message;
    const memoryStore = this.workspaceManager.getMemoryStore();

    if (args.length === 0 || args[0] === 'list') {
      const memories = memoryStore.getRecent(10);
      if (memories.length === 0) {
        await this.sendResponse({ chatId, channel, text: 'No memories stored for this workspace.' });
        return;
      }
      const lines = memories.map(m =>
        `- [${m.type}] **${m.label}**: ${m.content.substring(0, 100)}${m.content.length > 100 ? '...' : ''}`
      );
      await this.sendResponse({
        chatId,
        channel,
        text: `\ud83e\udde0 Workspace Memories (${memories.length})\n\n${lines.join('\n')}`,
      });
    } else if (args[0] === 'search' && args.length > 1) {
      const query = args.slice(1).join(' ');
      const results = memoryStore.search(query);
      if (results.length === 0) {
        await this.sendResponse({ chatId, channel, text: `No memories matching "${query}".` });
        return;
      }
      const lines = results.map(m => `- [${m.type}] **${m.label}**: ${m.content.substring(0, 100)}`);
      await this.sendResponse({
        chatId,
        channel,
        text: `\ud83d\udd0d Memory search: "${query}"\n\n${lines.join('\n')}`,
      });
    } else if (args[0] === 'clear') {
      const all = memoryStore.getAll();
      for (const m of all) memoryStore.remove(m.id);
      await this.sendResponse({ chatId, channel, text: '\ud83d\uddd1\ufe0f All workspace memories cleared.' });
    } else {
      await this.sendResponse({
        chatId,
        channel,
        text: 'Usage:\n/memory - List recent memories\n/memory search <query> - Search memories\n/memory clear - Clear all memories\n/remember <text> - Add a memory',
      });
    }
  }

  private async cmdRemember(args: string[], message: UserMessage): Promise<void> {
    const { chatId, channel } = message;
    if (args.length === 0) {
      await this.sendResponse({
        chatId,
        channel,
        text: 'Usage: /remember <something to remember>\n\nExample: /remember This project uses PostgreSQL 15 with pgvector',
      });
      return;
    }

    const content = args.join(' ');
    const memoryStore = this.workspaceManager.getMemoryStore();
    const entry = memoryStore.add({
      type: 'fact',
      content,
      label: content.substring(0, 60),
      tags: ['user'],
      source: 'user',
    });

    await this.sendResponse({
      chatId,
      channel,
      text: `\ud83e\udde0 Remembered: ${entry.content}`,
    });
  }

  private async cmdPlan(args: string[], chatId: string, channel: ChannelType): Promise<void> {
    if (args.length === 0) {
      const enabled = this.config.planner?.enabled !== false;
      await this.sendResponse({
        chatId,
        channel,
        text: `\ud83d\udcdd Task Planner: ${enabled ? 'enabled' : 'disabled'}\n\n` +
          `The planner automatically decomposes complex tasks into steps.\n` +
          `Use /plan on to enable, /plan off to disable.`,
      });
      return;
    }

    if (args[0] === 'on') {
      this.planner.updateConfig({ enabled: true });
      await this.sendResponse({ chatId, channel, text: '\u2705 Task planner enabled.' });
    } else if (args[0] === 'off') {
      this.planner.updateConfig({ enabled: false });
      await this.sendResponse({ chatId, channel, text: '\u274c Task planner disabled.' });
    } else {
      await this.sendResponse({
        chatId,
        channel,
        text: 'Usage: /plan [on|off]',
      });
    }
  }

  private getHelpText(): string {
    return `\ud83e\udd16 Codey Commands

\ud83d\udc65 Workers
/workers - List all workers in the global library
/worker <name> <task> - Run a specific worker
/teams - List teams declared on this workspace
/team <name> <task> - Run a named team in sequence

\ud83e\udd16 Agents (legacy)
/parallel <prompt> - Run all agents in parallel
/all <prompt> - Run all agents in parallel
/agent <name> - Switch agent

\ud83e\udde0 Memory
/memory - List recent memories
/memory search <query> - Search memories
/memory clear - Clear all memories
/remember <text> - Save a memory

\ud83d\udcdd Planning
/plan - Show planner status
/plan on/off - Enable/disable task decomposition

\u2699\ufe0f Settings
/help - Show this message
/status - Show gateway status
/cwd [path] - Show/set working directory
/clear - Clear conversation history
/reset - Start a new conversation
/model [name] - Show/set model
/config - Show current config

Example: /worker architect design a REST API
Example: /team review audit this PR
Example: /remember This project uses Redis for caching
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
      text: `👷 Running worker: **${worker.name}** (${worker.personality.role})\n\nAgent: ${codingAgent}\nModel: ${model}\nTask: ${task.substring(0, 100)}${task.length > 100 ? '...' : ''}`,
    });

    // Build prompt with worker context
    const prompt = this.workspaceManager.getWorkerManager().buildWorkerPrompt(workerName, task);

    // Run with worker's coding agent and model
    const modelConfig = this.getModelConfig(codingAgent, model);

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

    const replyText = response.success
      ? `✅ **${worker.name}** completed:\n\n${response.output}`
      : `❌ **${worker.name}** failed: ${response.error}`;

    await this.sendResponse({
      chatId,
      channel,
      text: replyText,
    });
  }

  private async runTeamTask(message: UserMessage, teamName: string, task: string): Promise<void> {
    const { chatId, channel } = message;

    if (!teamName || !task.trim()) {
      const teamList = this.workspaceManager.listTeams();
      await this.sendResponse({
        chatId,
        channel,
        text: `Usage: /team <name> <task>\n\nTeams on this workspace:\n${teamList}`,
      });
      return;
    }

    const members = this.workspaceManager.getTeam(teamName);
    if (!members) {
      const teamList = this.workspaceManager.listTeams();
      await this.sendResponse({
        chatId,
        channel,
        text: `Team "${teamName}" not found on workspace "${this.workspaceManager.getCurrentWorkspace()}".\n\nAvailable teams:\n${teamList}`,
      });
      return;
    }

    const workerManager = this.workspaceManager.getWorkerManager();

    await this.sendResponse({
      chatId,
      channel,
      text: `👥 Running team **${teamName}** (${members.join(' → ')})\nTask: ${task.substring(0, 100)}${task.length > 100 ? '...' : ''}`,
    });

    let currentTask = task;
    const results: string[] = [];

    for (const memberName of members) {
      const worker = workerManager.getWorker(memberName);
      if (!worker) {
        results.push(`**${memberName}**: ❌ not found in global library`);
        break;
      }

      const codingAgent = workerManager.getWorkerCodingAgent(memberName) as CodingAgent;
      const model = workerManager.getWorkerModel(memberName);

      await this.sendResponse({
        chatId,
        channel,
        text: `🔄 Worker **${worker.name}** is working...`,
      });

      const prompt = workerManager.buildWorkerPrompt(memberName, currentTask);
      const modelConfig = this.getModelConfig(codingAgent, model);
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
        currentTask = `Previous worker output:\n${response.output}\n\nYour task: ${task}`;
      } else {
        results.push(`**${worker.name}**: ❌ Failed - ${response.error}`);
        break;
      }
    }

    await this.sendResponse({
      chatId,
      channel,
      text: `📊 Team **${teamName}** results\n\n${results.join('\n\n')}`,
    });
  }

  private async runTeamForChat(
    teamName: string,
    members: string[],
    prompt: string,
    workingDir: string,
    sink: ChatStreamSink,
    chatId: string,
  ): Promise<{ response: string; tokens?: number }> {
    if (!members || members.length === 0) {
      throw new Error(`Team not found or empty: ${teamName}`);
    }
    const workerManager = this.workspaceManager.getWorkerManager();
    let carry = prompt;
    const parts: string[] = [];
    for (let i = 0; i < members.length; i++) {
      const memberName = members[i];
      sink({ type: 'info', chatId, message: `Step ${i + 1}/${members.length}: ${memberName}` });
      const stepPrompt = workerManager.buildWorkerPrompt(memberName, carry);
      const codingAgent = (workerManager.getWorkerCodingAgent(memberName) ?? this.config.defaultAgent) as CodingAgent;
      const workerModel = workerManager.getWorkerModel(memberName);
      const modelConfig = this.getModelConfig(codingAgent, workerModel);
      const response = await this.runWithFallback(codingAgent, {
        prompt: stepPrompt,
        agent: codingAgent,
        model: modelConfig,
        context: { workingDir },
        onStream: (text: string) => sink({ type: 'stream', chatId, token: text }),
        onStatus: (_update: any) => { /* status forwarded via sink elsewhere */ },
      });
      const output = response?.success ? this.formatAgentResponse(response) : '';
      parts.push(`### ${memberName}\n\n${output}`);
      carry = output;
    }
    return { response: parts.join('\n\n---\n\n') };
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
      const teamMatch = text.match(/\/team\s+(\w+)\s+(.+)/i);
      if (teamMatch) {
        return {
          command: 'team',
          args: [teamMatch[1]],
          agent: this.config.defaultAgent as CodingAgent,
          model: undefined,
          prompt: teamMatch[2]
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

    // Fallback is opt-in. When disabled, surface the original failure.
    const fb = this.config.fallback;
    if (fb && fb.enabled === false) return response;

    // Prefer the user-configured order; else fall back to all enabled agents.
    const ordered = (fb?.order && fb.order.length > 0 ? fb.order : this.getEnabledAgents())
      .filter(a => a !== agent)
      .filter(a => this.config.agents?.[a]?.enabled !== false);
    for (const fallbackAgent of ordered) {
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
    const provider = agentConfig?.provider || 'anthropic';

    // Check if model is in the agent's model list
    if (agentConfig?.models?.some(m => m.toLowerCase() === modelName.toLowerCase())) {
      return { provider, model: modelName };
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

  // Handle prompt via HTTP API
  async processPromptHttp(
    prompt: string,
    sse?: (event: string, data: string) => void,
    conversationId?: string,
  ): Promise<{ response: string; conversationId: string; tokens?: number; durationSec?: number }> {
    const agent = this.config.defaultAgent;
    const model = this.getDefaultModelConfig(agent);

    // Use existing context window if provided, otherwise create a new one
    const ctxWindow = await this.contextManager.getOrCreate(conversationId ?? 'api-default');
    const ctxId = ctxWindow.id;

    // Emit conversation ID back to client on first message of a new conversation
    if (!conversationId && sse) {
      sse('conversationId', ctxId);
    }

    // Build memory context
    const memoryStore = this.workspaceManager.getMemoryStore();
    const memoryContext = (this.config.memory?.enabled !== false)
      ? memoryStore.buildContext(prompt)
      : undefined;

    const onStream = sse ? (text: string) => sse('stream', text) : undefined;
    const onStatus = sse ? (update: any) => sse('status', update) : undefined;

    // ── Task planning ─────────────────────────────────────────
    const plan = await this.planner.plan(prompt, memoryContext);

    if (plan && plan.needsPlanning && plan.steps.length > 0) {
      const planSummary = TaskPlanner.formatPlanSummary(plan);
      sse?.('plan', planSummary);

      await this.contextManager.addUserTurn(ctxWindow.id, prompt);

      const runAgent = async (stepPrompt: string): Promise<AgentResponse> => {
        const stepMemory = memoryStore.buildContext(stepPrompt);
        const stepFullPrompt = this.contextManager.buildPrompt(ctxWindow.id, stepPrompt, stepMemory);
        return this.runWithFallback(agent, {
          prompt: stepFullPrompt,
          agent,
          model,
          context: { workingDir: this.workingDir },
          onStream,
          onStatus,
        });
      };

      const onProgress = async (step: PlanStep, stepIndex: number, totalSteps: number): Promise<void> => {
        sse?.('status', JSON.stringify({
          type: step.status === 'running' ? 'info' : 'info',
          message: TaskPlanner.formatStepProgress(step, stepIndex, totalSteps),
        }));
        if (step.status === 'done' && step.output) {
          await this.contextManager.addAssistantTurn(ctxWindow.id, `[Step ${step.id}: ${step.title}] ${step.output.substring(0, 500)}`);
        }
      };

      const result = await this.planner.executePlan(plan, runAgent, onProgress);
      const summary = result.outputs.join('\n\n---\n\n');
      if (result.success) {
        memoryStore.extractFromInteraction({ userPrompt: prompt, agentOutput: summary.substring(0, 2000) });
      }
      sse?.('done', TaskPlanner.formatPlanSummary(result.plan));
      return { response: summary, conversationId: ctxId };
    }

    // ── Single-step execution ─────────────────────────────────
    let prep = this.prepareAgentTurn(ctxWindow, agent, prompt, memoryContext);
    const buildHttpRequest = (p: typeof prep): AgentRequest => ({
      prompt: p.prompt,
      agent,
      model,
      context: { workingDir: this.workingDir },
      onStream,
      onStatus,
      resumeSessionId: p.resumeSessionId,
      newSessionId: p.newSessionId,
    });

    const initialResume = prep.resumeSessionId;
    let response = await this.runWithFallback(agent, buildHttpRequest(prep));

    if (!response.success && prep.resumeSessionId) {
      this.logger.warn(`[${agent}] Resume of ${prep.resumeSessionId} failed; retrying with bootstrap`);
      await this.contextManager.clearSessionAnchor(ctxWindow.id);
      prep = this.prepareAgentTurn(ctxWindow, agent, prompt, memoryContext);
      response = await this.runWithFallback(agent, buildHttpRequest(prep));
    }

    const resumed = !!initialResume && !!prep.resumeSessionId;
    await this.commitSessionAnchor(ctxWindow, agent, response, prep.newSessionId, resumed);

    // Store turn in context
    await this.contextManager.addUserTurn(ctxWindow.id, prompt);
    const meta = ContextManager.extractMeta(response, agent);
    if (response.success) {
      await this.contextManager.addAssistantTurn(ctxWindow.id, response.output, meta);
    }

    // Auto-extract memories
    if (this.config.memory?.autoExtract !== false && response.success) {
      memoryStore.extractFromInteraction({
        userPrompt: prompt,
        agentOutput: response.output,
        toolCalls: meta.toolCalls?.map(tc => ({ tool: tc.tool, input: tc.input, output: tc.output, status: tc.status })),
        filesChanged: meta.filesChanged?.map(fc => ({ path: fc.path, action: fc.action })),
      });
    }

    return {
      response: this.formatAgentResponse(response),
      conversationId: ctxId,
      tokens: response.tokens?.total,
      durationSec: response.duration,
    };
  }

  async sendToChat(
    chatId: string,
    userText: string,
    sink: ChatStreamSink,
  ): Promise<{ response: string; chatId: string; tokens?: number; durationSec?: number }> {
    const chat = this.chatManager.get(chatId);
    if (!chat) throw new Error(`Chat not found: ${chatId}`);

    // Queue if at capacity
    if ((this.chatSemaphore as any).running >= (this.chatSemaphore as any).max) {
      sink({ type: 'queued', chatId, position: this.chatSemaphore.queueLength + 1 });
    }
    await this.chatSemaphore.acquire();

    const started = Date.now();

    // Resolve workspace → workingDir by reading workspace.json from disk.
    // Also pull team config so team-mode chats use the chat's workspace, not
    // whichever workspace WorkspaceManager has loaded as the active one.
    const workspacesRoot = this.workspaceManager.getWorkspacesRoot();
    const wsConfigPath = path.join(workspacesRoot, chat.workspaceName, 'workspace.json');
    let workingDir = this.workingDir;
    let chatWorkspaceTeams: Record<string, string[]> = {};
    if (fs.existsSync(wsConfigPath)) {
      try {
        const wsConfig = JSON.parse(fs.readFileSync(wsConfigPath, 'utf-8'));
        if (wsConfig.workingDir) workingDir = wsConfig.workingDir;
        if (wsConfig.teams && typeof wsConfig.teams === 'object') chatWorkspaceTeams = wsConfig.teams;
      } catch { /* use default */ }
    } else {
      this.chatSemaphore.release();
      const msg = `Workspace not found: ${chat.workspaceName}`;
      sink({ type: 'error', chatId, message: msg });
      throw new Error(msg);
    }

    // Build the prompt from the existing chat history + the new user turn,
    // BEFORE persisting the user message. Persisting first would cause
    // buildChatPrompt to see the new turn in the tail AND get it appended
    // again as `User: ${userText}`, doubling the user message in the prompt.
    const prompt = assistantPrefixForSelection(chat) + buildChatPrompt(chat, userText);

    const userMessage: ChatMessage = {
      id: randomUUID(),
      role: 'user',
      content: userText,
      timestamp: started,
      isComplete: true,
    };
    this.chatManager.appendMessage(chatId, userMessage);

    const agent = this.config.defaultAgent;
    const model = this.getDefaultModelConfig(agent);

    const toolCalls: ToolCallEntry[] = [];
    let streamedText = '';

    const onStream = (text: string) => {
      streamedText += text;
      sink({ type: 'stream', chatId, token: text });
    };
    const onStatus = (update: any) => {
      try {
        const parsed = typeof update === 'string' ? JSON.parse(update) : update;
        const entry: ToolCallEntry = {
          id: randomUUID(),
          type: parsed.type ?? 'info',
          tool: parsed.tool,
          message: parsed.message ?? '',
          input: parsed.input,
          output: parsed.output,
        };
        toolCalls.push(entry);
        if (entry.type === 'tool_start') {
          sink({ type: 'tool_start', chatId, tool: entry.tool, message: entry.message, input: entry.input });
        } else if (entry.type === 'tool_end') {
          sink({ type: 'tool_end', chatId, tool: entry.tool, message: entry.message, output: entry.output });
        } else {
          sink({ type: 'info', chatId, message: entry.message });
        }
      } catch { /* non-JSON status */ }
    };

    try {
      let output = '';
      let tokens: number | undefined;
      if (chat.selection.type === 'team') {
        // Resolve the team from the chat's workspace.json (read above), not from
        // the active workspace, so a chat in workspace B uses B's team config
        // even if WorkspaceManager has loaded A. Worker prompt bodies still come
        // from WorkerManager's loaded workers/ dir (a known limitation when the
        // active workspace differs from the chat's).
        const teamNames = Object.keys(chatWorkspaceTeams);
        if (teamNames.length === 0) throw new Error(`No teams configured in workspace "${chat.workspaceName}"`);
        const teamName = teamNames[0];
        const members = chatWorkspaceTeams[teamName];
        if (!members || members.length === 0) throw new Error(`Team "${teamName}" is empty`);
        const r = await this.runTeamForChat(teamName, members, prompt, workingDir, sink, chatId);
        output = r.response;
        tokens = r.tokens;
      } else {
        const response = await this.runWithFallback(agent, {
          prompt,
          agent,
          model,
          context: { workingDir },
          onStream,
          onStatus,
        });
        output = response?.success ? this.formatAgentResponse(response) : (streamedText || '');
        tokens = (response as any)?.tokens?.total;
      }

      const durationSec = Math.round((Date.now() - started) / 1000);
      const assistantMessage: ChatMessage = {
        id: randomUUID(),
        role: 'assistant',
        content: output,
        timestamp: Date.now(),
        toolCalls,
        isComplete: true,
        tokens,
        durationSec,
      };
      this.chatManager.appendMessage(chatId, assistantMessage);

      sink({ type: 'done', chatId, response: output, tokens, durationSec });
      return { response: output, chatId, tokens, durationSec };
    } catch (err) {
      const message = `Error: ${(err as Error).message}`;
      const assistantMessage: ChatMessage = {
        id: randomUUID(),
        role: 'assistant',
        content: message,
        timestamp: Date.now(),
        toolCalls,
        isComplete: true,
      };
      this.chatManager.appendMessage(chatId, assistantMessage);
      sink({ type: 'error', chatId, message });
      throw err;
    } finally {
      this.chatSemaphore.release();
    }
  }
}
