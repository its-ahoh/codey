import * as path from 'path';
import * as fs from 'fs';
import { AgentRequest, AgentResponse, ChannelKind, ChatRoute, FallbackEntry, GatewayConfig, GatewayResponse, UserMessage, CodingAgent, ModelConfig, ChannelType, ChannelConfig, ChatMessage, ToolCallEntry, runManager, ManagerTurn, ManagerHistoryEntry, parseAskUser, parseAsk, PendingTeamState } from '@codey/core';
import { randomUUID } from 'crypto';
import { ConfigManager } from './config';
import { TelegramHandler, DiscordHandler, IMessageHandler, TuiHandler, ChannelHandler } from './channels';
import { AgentFactory } from '@codey/core';
import { Logger } from './logger';
import { ContextManager, ContextWindow } from '@codey/core';
import { MemoryStore } from '@codey/core';
import { TaskPlanner, TaskPlan, PlanStep } from '@codey/core';
import { WorkspaceManager, TeamConfigRaw } from '@codey/core';
import { WorkerManager } from '@codey/core';
import { ChatManager } from './chats';
import { PairingStore, ChannelBinding } from './pairings';
import { summarizePriorHistory } from './summary';
import { buildChatPrompt, assistantPrefixForSelection, RunSemaphore, ChatStreamSink } from './chat-runner';
import { TurnQueue, QueuedMessage, Surface } from './turn-queue';
import { renderQuestion, renderCancelNotice, stripAskMarker } from './team-pause';
import { resolveChoiceDigit } from './digit-mapping';

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
  private pairingStore: PairingStore;
  private configManager?: ConfigManager;
  private chatSemaphore = new RunSemaphore();
  private chatAborts: Map<string, AbortController> = new Map();
  private turnQueue: TurnQueue;
  private chatEventListener: ((ev: any) => void) | undefined;

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
  private static readonly REGEX_TEAM = /\/team\s+(\w+)(?:\s+(--all))?\s+(?!--all\s*$)(.+)/i;
  private static readonly REGEX_AGENT_PROMPT = /\/agent\s+(claude-code|opencode|codex)\s+(.+)/i;
  private static readonly REGEX_AGENT = /\/agent\s+(claude-code|opencode|codex)/i;
  private static readonly REGEX_MODEL_PROMPT = /\/model\s+(\S+)(?:\s+(.+))?/i;
  private static readonly REGEX_MODEL = /\/model\s+(\S+)/i;
  private static readonly REGEX_HELP_COMMAND = /^\/(help|status|clear|reset|model|agents|config)\s*/i;

  /**
   * Canonical default agent. Reads from the on-disk fallback.order[0] via the
   * ConfigManager when available, falling back to a runtime-config hint or
   * 'claude-code'. Centralizing this here keeps every call site consistent
   * after the schema migration that made fallback.order the source of truth.
   */
  getDefaultAgent(): CodingAgent {
    const fromCfg = this.configManager?.getDefaultAgent();
    if (fromCfg) return fromCfg as CodingAgent;
    const fromFallback = this.config.fallback?.order?.[0]?.agent;
    return (fromFallback ?? this.config.defaultAgent ?? 'claude-code') as CodingAgent;
  }

  /**
   * Per-agent default model name. Looks up the first fallback entry for the
   * agent that pins a model. Used to resolve `getDefaultModelConfig` without
   * depending on the now-removed `agents.{}.defaultModel` slot.
   */
  private getDefaultModelName(agent: CodingAgent): string | undefined {
    const fb = this.configManager?.getFallback() ?? this.config.fallback;
    return fb?.order.find(e => e.agent === agent && !!e.model)?.model;
  }

  private getEffectiveModel(agent?: CodingAgent): string {
    const effectiveAgent = agent || this.getDefaultAgent();
    const modelName = this.getDefaultModelName(effectiveAgent);
    if (!modelName) return 'unknown';
    const entry = this.configManager?.getModel(modelName);
    return entry?.model || modelName;
  }

  /**
   * Resolve the ModelConfig the agent adapter should use. Looks up the agent's
   * default model in fallback.order, then expands it via the global catalog
   * so the adapter sees apiType, baseUrl, and apiKey.
   */
  getDefaultModelConfig(agent: CodingAgent): ModelConfig | undefined {
    const modelName = this.getDefaultModelName(agent);
    if (!modelName) return undefined;
    return this.getModelConfig(agent, modelName);
  }

  private getDispatcherAgentAndModel(): { agent: CodingAgent; model?: ModelConfig } {
    const cfg = this.config.dispatcher;
    const agent = (cfg?.agent as CodingAgent | undefined) ?? this.getDefaultAgent();
    const modelName = cfg?.model;
    const model = modelName ? this.getModelConfig(agent, modelName) : this.getDefaultModelConfig(agent);
    return { agent, model };
  }

  private dispatcherRunner = (req: AgentRequest): Promise<AgentResponse> => {
    return this.runWithFallback(req.agent, req);
  };

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
    this.workspaceManager = new WorkspaceManager(wm, workspaceDir || './workspaces', this.logger);
    this.chatManager = new ChatManager(this.workspaceManager.getWorkspacesRoot());
    // Anchor pairings.json to the data root (parent of the workspaces dir),
    // not process.cwd(). In the packaged Mac app cwd can be `/`, which is
    // read-only and produces EROFS on first write.
    const dataRoot = path.dirname(this.workspaceManager.getWorkspacesRoot());
    this.pairingStore = new PairingStore(path.join(dataRoot, 'pairings.json'));
    this.turnQueue = new TurnQueue(async (_chatId, batch) => {
      // No coalescing in this version: process each queued message in order.
      for (const item of batch) {
        if (!item.payload) continue;
        await this.runOneTurn(item.payload.message, item.payload.parsed);
      }
    });
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

  public setChatEventListener(fn: (ev: any) => void): void {
    this.chatEventListener = fn;
  }

  /** Mac calls this to start a pairing flow. Returns a 6-digit code shown in the UI. */
  public startPairing(channel: ChannelKind): string {
    return this.pairingStore.startPairing({ channel });
  }

  public listPairings(): ChannelBinding[] {
    return this.pairingStore.list();
  }

  /** Get the pairing store directly (used by command handlers in later tasks). */
  public getPairingStore(): PairingStore {
    return this.pairingStore;
  }

  /**
   * Mac calls this to attach a channel route to an existing chat.
   * Pushes a one-time summary to the channel after attaching.
   */
  public async linkChat(chatId: string, channel: ChannelKind, channelUserId: string): Promise<void> {
    const binding = this.pairingStore.findByChannelUser(channel, channelUserId);
    if (!binding) throw new Error(`No pairing for ${channel}:${channelUserId}`);

    // 1:1 DM model — channelChatId equals channelUserId. See spec §Identity.
    const channelChatId = channelUserId;
    const route: ChatRoute = { channel, channelUserId, channelChatId, attachedAt: Date.now() };

    this.chatManager.addRoute(chatId, route);
    this.pairingStore.setCurrentChat(channel, channelUserId, chatId);

    const chat = this.chatManager.get(chatId);
    if (!chat) return;
    const summary = summarizePriorHistory(chat);
    const handler = this.handlers.get(channel);
    if (handler?.sendToRoute) {
      try {
        await handler.sendToRoute(route, summary);
      } catch (err) {
        this.logger.warn(`linkChat: failed to push summary to ${channel}: ${(err as Error).message}`);
      }
    }
  }

  public unlinkChat(chatId: string, channel: ChannelKind, channelUserId: string): void {
    const channelChatId = channelUserId;
    this.chatManager.removeRoute(chatId, channel, channelUserId, channelChatId);
  }

  getAgentFactory(): AgentFactory { return this.agentFactory; }

  getWorkingDir(): string { return this.workingDir; }

  getEffectiveModelConfig(): ModelConfig {
    const agent = this.getDefaultAgent();
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
    const defaultAgent = this.getDefaultAgent();
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

  private async handleMessage(messageParam: UserMessage): Promise<void> {
    let message = messageParam;

    // Skip if already processing
    if (this.processingMessages.has(message.id)) {
      return;
    }

    // Pre-rate-limit: detect a paused team waiting on this chat's user.
    // Resume answers must bypass the cooldown — otherwise a quick reply to a
    // worker's question would be dropped silently.
    const pendingChat = this.chatManager.get(message.chatId);
    const pending = pendingChat?.pendingTeam;
    const isSlash = message.text.trimStart().startsWith('/');
    const isPausedAnswer = !!pending && !isSlash;

    // Check rate limit (keyed by Codey chat id when available, else by user id)
    if (!isPausedAnswer) {
      const cooldownKey = this.cooldownKeyFor(message);
      if (!this.checkAndSetRateLimit(cooldownKey, message)) {
        return;
      }
    }

    this.processingMessages.add(message.id);
    this.messagesProcessed++;

    try {
      this.logger.info(`[INPUT] ${message.channel}/${message.username}: ${message.text}`);

      // Digit → option resolution for choice questions (works for both pendingTeam
      // and plain-chat lastAskedOptions). Mutates `message.text` so downstream
      // handling sees the resolved option string.
      const pendingOpts = pendingChat?.pendingTeam?.options ?? pendingChat?.lastAskedOptions?.options;
      if (pendingOpts && pendingOpts.length > 0) {
        const resolved = resolveChoiceDigit(message.text, pendingOpts);
        if (resolved !== null) {
          message = { ...message, text: resolved };
        }
      }

      // Clear lastAskedOptions on ANY user message (button click / digit / free text).
      if (pendingChat?.lastAskedOptions) {
        this.chatManager.clearLastAskedOptions(pendingChat.id);
      }

      if (pending) {
        if (isSlash) {
          try { this.chatManager.setPendingTeam(message.chatId, null); } catch (_) { /* ignore */ }
          await this.sendResponse({
            chatId: message.chatId,
            channel: message.channel,
            text: renderCancelNotice(pending),
          });
          // fall through to normal command handling
        } else {
          try { this.chatManager.setPendingTeam(message.chatId, null); } catch (_) { /* ignore */ }
          await this.resumeTeamFromAnswer(message, pending, message.text);
          return;
        }
      }

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

  private cooldownKeyFor(message: UserMessage): string {
    if (this.isPairableChannel(message.channel)) {
      const binding = this.pairingStore.findByChannelUser(message.channel, message.userId);
      if (binding?.currentChatId) return `chat:${binding.currentChatId}`;
    }
    return `user:${message.userId}`;
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
    const { userId, chatId, channel } = message;

    let codeyChatId: string | undefined;
    if (this.isPairableChannel(channel)) {
      const binding = this.pairingStore.findByChannelUser(channel, userId);
      if (binding?.currentChatId) codeyChatId = binding.currentChatId;
    }

    // Queue key: prefer the Codey chat id; fall back to the channel-derived id
    // so non-paired channels and Mac users still get per-conversation serialization.
    // Note: 'tui' is mapped to 'mac' for queueing purposes (Surface doesn't know 'tui').
    const queueKey = codeyChatId ?? `${channel}-${chatId}`;

    this.turnQueue.submit(queueKey, {
      surface: (channel === 'tui' ? 'mac' : channel) as Surface,
      text: parsed.prompt ?? '',
      userId,
      timestamp: Date.now(),
      payload: { message, parsed },
    });
  }

  private async runOneTurn(message: UserMessage, parsed: ParsedCommand): Promise<void> {
    const { userId, chatId, channel, id: messageId } = message;

    // Channel-side with a linked Codey chat → route through sendToChat so the
    // Codey Chat record is updated and the Mac app sees the events.
    if (this.isPairableChannel(channel)) {
      const binding = this.pairingStore.findByChannelUser(channel, userId);
      if (binding?.currentChatId) {
        await this.runChannelTurnViaChat(message, parsed, binding.currentChatId);
        return;
      }
    }

    // Channel-side: if this user has a paired binding with a current chat,
    // use it for Codey-side state (context window, fan-out lookup). Replies
    // continue to use `chatId` (the channel-side chat id) for routing.
    let codeyChatId: string | undefined;
    if (this.isPairableChannel(channel)) {
      const binding = this.pairingStore.findByChannelUser(channel, userId);
      if (binding?.currentChatId) {
        codeyChatId = binding.currentChatId;
      }
    }

    // Get or create structured context window keyed by conversationId
    const conversationId = message.conversationId
      ?? (codeyChatId ? `chat-${codeyChatId}` : `${message.channel}-${message.chatId}`);
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

    const agent = parsed.agent || this.getDefaultAgent();

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

    // Fan-out: if this message belongs to a Codey chat with multiple routes,
    // send the reply to every other attached route too.
    if (codeyChatId) {
      await this.fanOutToOtherRoutes(codeyChatId, channel, userId, replyText);
    }
  }

  private async runChannelTurnViaChat(
    message: UserMessage,
    parsed: ParsedCommand,
    codeyChatId: string,
  ): Promise<void> {
    const { chatId, channel, userId, id: messageId } = message;

    // Sink: forward `done` to the originating channel + fan out to other routes.
    // Streamed tokens are not relayed to channels (channels only get the final
    // formatted response, matching the existing behavior).
    const sink = (ev: any) => {
      if (ev?.type === 'done' && typeof ev.response === 'string') {
        // Fire-and-forget — channel sends are non-blocking from the sink's view.
        void this.sendResponse({
          chatId,
          channel,
          text: ev.response,
          replyTo: messageId,
        }).then(() => this.fanOutToOtherRoutes(codeyChatId, channel, userId, ev.response));
      } else if (ev?.type === 'error' && typeof ev.message === 'string') {
        void this.sendResponse({
          chatId,
          channel,
          text: `❌ ${ev.message}`,
          replyTo: messageId,
        });
      }
      // Ignore stream/tool_* events for channel surfaces.
    };

    try {
      await this.sendToChat(codeyChatId, parsed.prompt ?? message.text ?? '', sink);
    } catch (err) {
      this.logger.error(`runChannelTurnViaChat failed: ${(err as Error).message}`);
    }
  }

  private async fanOutToOtherRoutes(
    codeyChatId: string,
    originChannel: ChannelType,
    originUserId: string,
    text: string,
  ): Promise<void> {
    const chat = this.chatManager.get(codeyChatId);
    if (!chat?.routes) return;
    for (const route of chat.routes) {
      if (route.channel === originChannel && route.channelUserId === originUserId) continue;
      const handler = this.handlers.get(route.channel);
      if (!handler?.sendToRoute) continue;
      try {
        await handler.sendToRoute(route, text);
      } catch (err) {
        this.logger.warn(`fanOut: failed to send to ${route.channel}: ${(err as Error).message}`);
      }
    }
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
        if (this.isPairableChannel(channel) && args.length > 0) {
          const a = args[0].toLowerCase();
          if (['claude-code', 'opencode', 'codex'].includes(a)) {
            this.pairingStore.updatePrefs(channel, message.userId, { agent: a as 'claude-code' | 'opencode' | 'codex' });
          }
        }
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
      case 'team': {
        const teamName = args[0] || '';
        const forceAll = args.includes('--all');
        const taskArgs = args.slice(1).filter(a => a !== '--all').join(' ');
        await this.runTeamTask(message, teamName, taskArgs || parsed.prompt, { forceAll });
        break;
      }
      case 'teams':
        await this.cmdTeams(chatId, channel);
        break;
      case 'workspace':
      case 'ws':
        await this.cmdWorkspace(args, chatId, channel);
        if (this.isPairableChannel(channel) && args.length > 0) {
          this.pairingStore.updatePrefs(channel, message.userId, { workspace: args.join(' ') });
        }
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
      case 'pair':
        await this.cmdPair(args, message);
        break;
      case 'new':
        await this.cmdNewChat(args, message);
        break;
      case 'list':
        await this.cmdListChats(message);
        break;
      case 'switch':
        await this.cmdSwitchChat(args, message);
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
        `Agent: ${this.getDefaultAgent()}`,
        `Model: ${this.getEffectiveModel()}`,
        `Agents: ${agents}`,
        `Workspace: ${workspace}`,
        `Working dir: ${this.workingDir}`,
        ``,
        `**What I can do**`,
        `- Send any message to get coding help from the active agent`,
        `- /worker <name> <task> — run a specific worker`,
        `- /teams — list teams for this workspace`,
        `- /team <name> [--all] <task> — run a named team. With dispatch:auto the Manager iteratively picks workers and may loop back for revisions; --all bypasses the Manager and runs every member in declared order.`,
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
        `Default Agent: ${this.getDefaultAgent()}\n` +
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
        // Persist via the canonical setter so fallback.order[0] stays in sync;
        // the runtime config gets refreshed on the next applyConfig() event.
        this.configManager?.setDefaultAgent(agentName);
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
        text: `Current agent: **${this.getDefaultAgent()}**\nModel: ${this.getEffectiveModel()}\n\nSwitch with: /agent <name>`,
      });
    }
  }

  private async cmdAgents(chatId: string, channel: ChannelType): Promise<void> {
    const agentsList = this.getEnabledAgents().map(a => {
      const model = this.getEffectiveModel(a);
      const current = a === this.getDefaultAgent() ? ' ← current' : '';
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
        `Agent: ${this.getDefaultAgent()}\n` +
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

  private isPairableChannel(channel: ChannelType): channel is 'telegram' | 'discord' | 'imessage' {
    return channel === 'telegram' || channel === 'discord' || channel === 'imessage';
  }

  private async cmdPair(args: string[], message: UserMessage): Promise<void> {
    const { chatId, channel, userId } = message;
    if (!this.isPairableChannel(channel)) {
      await this.sendResponse({ chatId, channel, text: 'Pairing is only available on Telegram, Discord, or iMessage.' });
      return;
    }
    const code = args[0];
    if (!code || !/^\d{6}$/.test(code)) {
      await this.sendResponse({ chatId, channel, text: 'Usage: /pair <6-digit code from the Mac app>' });
      return;
    }
    const ok = this.pairingStore.completePairing(code, { channel, channelUserId: userId });
    await this.sendResponse({
      chatId,
      channel,
      text: ok
        ? '✅ Paired. Use /new to start a chat, or link an existing chat from the Mac app.'
        : '❌ Invalid or expired code.',
    });
  }

  private async cmdNewChat(args: string[], message: UserMessage): Promise<void> {
    const { chatId, channel, userId } = message;
    if (!this.isPairableChannel(channel)) {
      await this.sendResponse({ chatId, channel, text: '/new is only available on paired channels.' });
      return;
    }
    const binding = this.pairingStore.findByChannelUser(channel, userId);
    if (!binding) {
      await this.sendResponse({ chatId, channel, text: 'You need to /pair first.' });
      return;
    }
    const workspace = binding.prefs?.workspace ?? this.workspaceManager.getCurrentWorkspace();
    const title = args.join(' ').trim() || undefined;
    const chat = this.chatManager.create({ workspaceName: workspace, title });
    if (binding.prefs?.agent || binding.prefs?.model) {
      this.chatManager.updateAgentModel(chat.id, binding.prefs.agent, binding.prefs.model);
    }
    this.chatManager.addRoute(chat.id, {
      channel,
      channelUserId: userId,
      channelChatId: userId,
      attachedAt: Date.now(),
    });
    this.pairingStore.setCurrentChat(channel, userId, chat.id);
    await this.sendResponse({
      chatId,
      channel,
      text: `Started chat "${chat.title}" (${chat.id.slice(0, 8)}). Send messages to continue.`,
    });
  }

  private async cmdListChats(message: UserMessage): Promise<void> {
    const { chatId, channel, userId } = message;
    if (!this.isPairableChannel(channel)) {
      await this.sendResponse({ chatId, channel, text: '/list is only available on paired channels.' });
      return;
    }
    const binding = this.pairingStore.findByChannelUser(channel, userId);
    if (!binding) {
      await this.sendResponse({ chatId, channel, text: 'You need to /pair first.' });
      return;
    }
    const all = this.chatManager.list().filter(c =>
      c.routes?.some(r => r.channel === channel && r.channelUserId === userId)
    );
    if (all.length === 0) {
      await this.sendResponse({ chatId, channel, text: 'No linked chats yet. /new <title> to start one.' });
      return;
    }
    const lines = all.slice(0, 10).map(c => {
      const marker = c.id === binding.currentChatId ? '→' : ' ';
      return `${marker} ${c.id.slice(0, 8)}  ${c.title}`;
    });
    await this.sendResponse({ chatId, channel, text: lines.join('\n') });
  }

  private async cmdSwitchChat(args: string[], message: UserMessage): Promise<void> {
    const { chatId, channel, userId } = message;
    if (!this.isPairableChannel(channel)) {
      await this.sendResponse({ chatId, channel, text: '/switch is only available on paired channels.' });
      return;
    }
    const prefix = args[0];
    if (!prefix) {
      await this.sendResponse({ chatId, channel, text: 'Usage: /switch <chat-id-prefix>' });
      return;
    }
    const binding = this.pairingStore.findByChannelUser(channel, userId);
    if (!binding) {
      await this.sendResponse({ chatId, channel, text: 'You need to /pair first.' });
      return;
    }
    const target = this.chatManager.list().find(c =>
      c.id.startsWith(prefix) &&
      c.routes?.some(r => r.channel === channel && r.channelUserId === userId)
    );
    if (!target) {
      await this.sendResponse({ chatId, channel, text: `No matching linked chat for "${prefix}".` });
      return;
    }
    this.pairingStore.setCurrentChat(channel, userId, target.id);
    await this.sendResponse({ chatId, channel, text: `Switched to "${target.title}".` });
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
/team <name> [--all] <task> — run a named team. With dispatch:auto the Manager iteratively picks workers and may loop back for revisions; --all bypasses the Manager and runs every member in declared order.

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

    // Run all agents in parallel (with per-agent fallback)
    const results = await Promise.allSettled(
      enabledAgents.map(agent =>
        this.runWithFallback(agent, {
          prompt,
          agent,
          model: this.getDefaultModelConfig(agent),
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

  /**
   * Iteratively drives the team Manager. Returns the chronological run result
   * or `{ fallback: true }` when the Manager fails on turn 1 — caller should
   * fall back to running all members in input order.
   *
   * Mid-run Manager failures (turn 2+) end the loop gracefully: the parts
   * collected so far are returned with `fallbackMidRun` set so the caller
   * can annotate the user-visible header.
   */
  private async runManagerLoop(
    team: { members: string[] },
    task: string,
    signal: AbortSignal | undefined,
    chatAgent: CodingAgent | undefined,
    chatModel: ModelConfig | undefined,
    perStep: (msg: { kind: 'route'; step: number; worker: string; reason: string; isRevision: boolean }) => void | Promise<void>,
    runWorker: (worker: string, prompt: string, codingAgent: CodingAgent, modelConfig: ModelConfig | undefined) => Promise<{ success: boolean; output: string; error?: string }>,
  ): Promise<
    | { fallback: true; fallbackReason: string }
    | {
        fallback: false;
        paused?: undefined;
        parts: Array<{ step: number; worker: string; output: string; isRevision: boolean }>;
        finalSummary: string;
        fallbackMidRun?: { reason: string };
      }
    | {
        fallback: false;
        paused: {
          history: ManagerHistoryEntry[];
          lastWorker: string;
          lastOutput: string;
          parts: Array<{ step: number; worker: string; output: string; isRevision: boolean }>;
          seenWorkers: string[];
          step: number;
          askingWorker: string;
          question: string;
          options?: string[];
        };
      }
  > {
    const workerManager = this.workspaceManager.getWorkerManager();
    const members = team.members;
    const cap = Math.max(Math.min(2 * members.length, 12), 4);
    const FORWARD_HOP_CAP = 2;

    const history: ManagerHistoryEntry[] = [];
    let lastWorker: string | null = null;
    let lastOutput: string | null = null;
    const parts: Array<{ step: number; worker: string; output: string; isRevision: boolean }> = [];
    let finalSummary = '';
    let fallbackMidRun: { reason: string } | undefined;

    const { agent: mAgent, model: mModel } = this.getDispatcherAgentAndModel();
    const seenWorkers = new Set<string>();

    // When set, skip the next Manager call and run this worker directly
    // (used when a worker emits `[ASK: <teammate>]: q` to forward).
    let directNext: { worker: string; instruction: string } | null = null;
    // When set, the next Manager turn arbitrates this pending question
    // (used when a worker emits `[ASK_USER]:` or forwards to an unknown target).
    let pendingArbitration: { worker: string; question: string; options?: string[] } | null = null;
    // Number of consecutive direct forwards since the last Manager turn.
    let forwardHops = 0;

    for (let step = 1; step <= cap; step++) {
      if (signal?.aborted) break;

      let turnNext: string;
      let turnInstruction: string;
      let turnReason: string;
      let isRevision: boolean;

      if (directNext) {
        turnNext = directNext.worker;
        turnInstruction = directNext.instruction;
        turnReason = `Forwarded from ${lastWorker ?? 'previous worker'}`;
        isRevision = seenWorkers.has(turnNext);
        directNext = null;
      } else {
        const turn: ManagerTurn = await runManager(
          {
            task,
            members: members.map(n => ({ name: n, hint: workerManager.getDispatchHint(n) })),
            history,
            lastWorker,
            lastOutput,
            pendingQuestion: pendingArbitration ?? undefined,
          },
          { agent: mAgent, model: mModel, runner: this.dispatcherRunner, signal },
        );
        if (turn.fallback) {
          if (parts.length === 0) {
            return { fallback: true, fallbackReason: turn.fallbackReason ?? 'unknown' };
          }
          fallbackMidRun = { reason: turn.fallbackReason ?? 'unknown' };
          break;
        }
        if (lastWorker && turn.summary_of_last) {
          history.push({ worker: lastWorker, summary: turn.summary_of_last });
        }
        if (pendingArbitration && turn.escalateToUser) {
          // Strip the [ASK_USER] marker line from the asker's persisted output
          // so it doesn't leak into the run log when the team finalizes after
          // the user replies.
          const strippedLastOutput = stripAskMarker(lastOutput ?? '');
          const strippedParts = parts.map((p, i) =>
            i === parts.length - 1 && p.worker === pendingArbitration!.worker
              ? { ...p, output: stripAskMarker(p.output) }
              : p,
          );
          return {
            fallback: false,
            paused: {
              history,
              lastWorker: pendingArbitration.worker,
              lastOutput: strippedLastOutput,
              parts: strippedParts,
              seenWorkers: Array.from(seenWorkers),
              step,
              askingWorker: pendingArbitration.worker,
              question: pendingArbitration.question,
              options: pendingArbitration.options,
            },
          };
        }
        if (turn.done || !turn.next) {
          finalSummary = turn.final_summary ?? '';
          break;
        }
        turnNext = turn.next;
        turnInstruction = turn.instruction;
        turnReason = turn.reason ?? '';
        isRevision = seenWorkers.has(turn.next);
        pendingArbitration = null;
        forwardHops = 0;
      }

      await perStep({ kind: 'route', step, worker: turnNext, reason: turnReason, isRevision });

      const codingAgent = (workerManager.getWorkerCodingAgent(turnNext) ?? chatAgent ?? this.getDefaultAgent()) as CodingAgent;
      const workerModelName = workerManager.getWorkerModel(turnNext);
      const modelConfig = workerModelName
        ? this.getModelConfig(codingAgent, workerModelName)
        : chatModel ?? this.getDefaultModelConfig(codingAgent);

      const stepTaskBody = this.composeStepTask(task, turnInstruction, lastWorker, lastOutput);
      // Build a per-step "last did" map from Manager history: latest entry per worker.
      const lastDidByWorker = new Map<string, string>();
      for (const h of history) lastDidByWorker.set(h.worker, h.summary);
      const teamRoster = members
        .filter(n => n !== turnNext)
        .map(n => ({
          name: n,
          hint: workerManager.getDispatchHint(n),
          lastDid: lastDidByWorker.get(n),
        }));
      const prompt = workerManager.buildTeamWorkerPrompt(turnNext, stepTaskBody, teamRoster);

      const response = await runWorker(turnNext, prompt, codingAgent, modelConfig);
      if (!response.success) {
        fallbackMidRun = { reason: `worker ${turnNext} failed: ${response.error ?? 'unknown'}` };
        break;
      }
      parts.push({ step, worker: turnNext, output: response.output, isRevision });
      seenWorkers.add(turnNext);
      lastWorker = turnNext;
      lastOutput = response.output;

      const ask = parseAsk(response.output);
      if (!ask) continue;

      if (ask.kind === 'team') {
        const targetValid = members.includes(ask.target) && ask.target !== turnNext;
        if (targetValid && forwardHops < FORWARD_HOP_CAP) {
          forwardHops += 1;
          // Record the forward in history so the Manager retains visibility of
          // the asking worker's contribution despite skipping the Manager turn.
          history.push({
            worker: turnNext,
            summary: `Asked ${ask.target}: "${ask.question}"`,
          });
          directNext = {
            worker: ask.target,
            instruction: `${turnNext} forwarded a question to you: "${ask.question}". Answer it concisely so the team can continue.`,
          };
          continue;
        }
        // Invalid target or hop cap exceeded → Manager arbitrates.
        pendingArbitration = { worker: turnNext, question: ask.question, options: undefined };
        continue;
      }
      // kind === 'user' → Manager arbitrates whether to route or escalate.
      pendingArbitration = { worker: turnNext, question: ask.question, options: ask.options };
    }

    // Cap exhausted without explicit done — request a final summary.
    // Skip when the user aborted: the inner runner will fail anyway and we
    // shouldn't send a fresh request after cancellation.
    if (!finalSummary && parts.length > 0 && !fallbackMidRun && !signal?.aborted) {
      const closing = await runManager(
        {
          task,
          members: members.map(n => ({ name: n, hint: workerManager.getDispatchHint(n) })),
          history,
          lastWorker,
          lastOutput,
          finalize: true,
        },
        { agent: mAgent, model: mModel, runner: this.dispatcherRunner, signal },
      );
      if (!closing.fallback) finalSummary = closing.final_summary ?? '';
    }

    return { fallback: false, parts, finalSummary, fallbackMidRun };
  }

  private composeStepTask(
    originalTask: string,
    instruction: string,
    lastWorker: string | null,
    lastOutput: string | null,
  ): string {
    const sections: string[] = [];
    if (instruction.trim()) sections.push(instruction.trim());
    sections.push(`Original task: ${originalTask}`);
    if (lastWorker && lastOutput) {
      sections.push(`Previous worker (${lastWorker}) output:\n${lastOutput}`);
    }
    return sections.join('\n\n');
  }

  private formatManagerParts(
    parts: Array<{ step: number; worker: string; output: string; isRevision: boolean }>,
    finalSummary: string,
    truncatePerStep?: number,
  ): string {
    const head = finalSummary ? `🧭 Manager summary: ${finalSummary}\n\n` : '';
    const body = parts
      .map(p => {
        const label = p.isRevision ? `${p.worker} (revision)` : p.worker;
        const out = truncatePerStep ? p.output.substring(0, truncatePerStep) : p.output;
        return `### Step ${p.step}: ${label}\n\n${out}`;
      })
      .join('\n\n---\n\n');
    return head + body;
  }

  private async runTeamTask(
    message: UserMessage,
    teamName: string,
    task: string,
    opts: { forceAll?: boolean } = {},
  ): Promise<void> {
    const { chatId, channel } = message;

    if (!teamName || !task.trim()) {
      const teamList = this.workspaceManager.listTeams();
      await this.sendResponse({
        chatId,
        channel,
        text: `Usage: /team <name> [--all] <task>\n\nTeams on this workspace:\n${teamList}`,
      });
      return;
    }

    const team = this.workspaceManager.getTeam(teamName);
    if (!team) {
      const teamList = this.workspaceManager.listTeams();
      await this.sendResponse({
        chatId,
        channel,
        text: `Team "${teamName}" not found on workspace "${this.workspaceManager.getCurrentWorkspace()}".\n\nAvailable teams:\n${teamList}`,
      });
      return;
    }

    const handler = this.handlers.get(channel);
    const { members, dispatch } = team;

    // Helper to run one worker once, used by both the Manager loop and the
    // legacy "all members in input order" fallback.
    const runOneWorker = async (
      _workerName: string,
      prompt: string,
      codingAgent: CodingAgent,
      modelConfig: ModelConfig | undefined,
    ): Promise<{ success: boolean; output: string; error?: string }> => {
      const onStream = handler?.streamText ? (text: string) => handler.streamText!(text) : undefined;
      const response = await this.runWithFallback(codingAgent, {
        prompt,
        agent: codingAgent,
        model: modelConfig,
        interactive: this.tuiMode,
        onStream,
        context: { workingDir: this.workingDir },
      });
      return response.success
        ? { success: true, output: response.output }
        : { success: false, output: '', error: response.error };
    };

    const useManager = dispatch === 'auto' && !opts.forceAll;

    if (useManager) {
      await this.sendResponse({
        chatId,
        channel,
        text: `🧭 Manager running team **${teamName}**\nTask: ${task.substring(0, 100)}${task.length > 100 ? '...' : ''}`,
      });

      const result = await this.runManagerLoop(
        team,
        task,
        undefined,
        undefined,
        undefined,
        async ({ step, worker, reason, isRevision }) => {
          await this.sendResponse({
            chatId,
            channel,
            text: `🔄 Step ${step}: **${worker}**${isRevision ? ' (revision)' : ''} — ${reason}`,
          });
        },
        runOneWorker,
      );

      if (result.fallback) {
        await this.sendResponse({
          chatId,
          channel,
          text: `⚠️ Auto-routing failed (${result.fallbackReason}), running all members.`,
        });
        await this.runAllMembersInOrder(message, teamName, members, task, runOneWorker);
        return;
      }

      if ('paused' in result && result.paused) {
        const p = result.paused;
        const wm = this.workspaceManager.getWorkerManager();
        const askWorkerName = wm.getWorker(p.askingWorker)?.name ?? p.askingWorker;
        this.persistPendingTeam(message.chatId, {
          mode: 'auto',
          teamName,
          task,
          history: p.history,
          lastWorker: p.lastWorker,
          lastOutput: p.lastOutput,
          partsSoFar: p.parts,
          seenWorkers: p.seenWorkers,
          step: p.step,
          askingWorker: p.askingWorker,
          question: p.question,
          options: p.options,
          askedAt: Date.now(),
        });
        const rendered1 = renderQuestion(askWorkerName, '', p.question, p.options);
        await this.sendResponse({
          chatId: message.chatId,
          channel: message.channel,
          text: rendered1.text,
          choices: rendered1.choices,
        });
        return;
      }

      if (result.fallbackMidRun) {
        await this.sendResponse({
          chatId,
          channel,
          text: `⚠️ Manager halted mid-run: ${result.fallbackMidRun.reason}`,
        });
      }

      const text = this.formatManagerParts(result.parts, result.finalSummary, /*truncatePerStep*/ 500);
      await this.sendResponse({
        chatId,
        channel,
        text: `📊 Team **${teamName}** results\n\n${text}`,
      });
      return;
    }

    // dispatch === 'all' OR forceAll: legacy path
    const headerSuffix = opts.forceAll ? ' [--all override]' : '';
    await this.sendResponse({
      chatId,
      channel,
      text: `👥 Running team **${teamName}** (${members.join(' → ')})${headerSuffix}\nTask: ${task.substring(0, 100)}${task.length > 100 ? '...' : ''}`,
    });
    await this.runAllMembersInOrder(message, teamName, members, task, runOneWorker);
  }

  /**
   * Resume a paused team using the user's answer to a worker's [ASK_USER] question.
   * Caller (handleMessage) is responsible for clearing chat.pendingTeam BEFORE invoking this,
   * so any new pause state we set here is not stomped.
   */
  /**
   * Persist pending-team state on a chat. If the chat doesn't exist (e.g. some
   * channels haven't created a Codey chat record), log a clear warning — the
   * run effectively can't be resumed since we have nowhere to attach the
   * answer.
   */
  private persistPendingTeam(chatId: string, pending: PendingTeamState): boolean {
    try {
      this.chatManager.setPendingTeam(chatId, pending);
      return true;
    } catch (err) {
      this.logger.warn(
        `Cannot persist paused team for chat ${chatId} (${(err as Error).message}); ` +
          `team "${pending.teamName}" surfaced "${pending.question}" but no chat record exists to track the reply.`,
      );
      return false;
    }
  }

  private async resumeTeamFromAnswer(
    message: UserMessage,
    pending: PendingTeamState,
    answer: string,
  ): Promise<void> {
    const team = this.workspaceManager.getTeam(pending.teamName);
    if (!team) {
      await this.sendResponse({
        chatId: message.chatId,
        channel: message.channel,
        text: `Team \`${pending.teamName}\` no longer exists; the paused run was dropped.`,
      });
      return;
    }
    const handler = this.handlers.get(message.channel);
    const runOneWorker = async (
      _workerName: string,
      prompt: string,
      codingAgent: CodingAgent,
      modelConfig: ModelConfig | undefined,
    ): Promise<{ success: boolean; output: string; error?: string }> => {
      const onStream = handler?.streamText ? (text: string) => handler.streamText!(text) : undefined;
      const response = await this.runWithFallback(codingAgent, {
        prompt,
        agent: codingAgent,
        model: modelConfig,
        interactive: this.tuiMode,
        onStream,
        context: { workingDir: this.workingDir },
      });
      return response.success
        ? { success: true, output: response.output }
        : { success: false, output: '', error: response.error };
    };

    if (pending.mode === 'sequential') {
      const wm = this.workspaceManager.getWorkerManager();
      const memberName = team.members[pending.memberIndex];
      const codingAgent = wm.getWorkerCodingAgent(memberName) as CodingAgent;
      const modelConfig = this.getModelConfig(codingAgent, wm.getWorkerModel(memberName));
      const seqRoster = team.members.map(n => ({ name: n, hint: wm.getDispatchHint(n) }));
      const seqNextName = team.members[pending.memberIndex + 1];
      const seqNextWorker = seqNextName
        ? { name: seqNextName, hint: wm.getDispatchHint(seqNextName) }
        : null;
      const reprompt = wm.buildSequentialWorkerPrompt(
        memberName,
        `${pending.carry}\n\n[User answer to your question "${pending.question}"]:\n${answer}`,
        seqRoster,
        seqNextWorker,
      );
      await this.sendResponse({
        chatId: message.chatId,
        channel: message.channel,
        text: `🔄 Resuming **${memberName}** with your answer…`,
      });
      const response = await runOneWorker(memberName, reprompt, codingAgent, modelConfig);
      if (!response.success) {
        await this.sendResponse({
          chatId: message.chatId,
          channel: message.channel,
          text: `❌ Worker **${memberName}** failed on resume: ${response.error}`,
        });
        return;
      }
      const ask = parseAskUser(response.output);
      if (ask) {
        this.persistPendingTeam(message.chatId, {
          mode: 'sequential',
          teamName: pending.teamName,
          task: pending.task,
          memberIndex: pending.memberIndex,
          carry: pending.carry,
          askingWorker: memberName,
          question: ask.question,
          options: ask.options,
          askedAt: Date.now(),
        });
        const rendered2 = renderQuestion(memberName, ask.preamble, ask.question, ask.options);
        await this.sendResponse({
          chatId: message.chatId,
          channel: message.channel,
          text: rendered2.text,
          choices: rendered2.choices,
        });
        return;
      }
      const carryForNext = `Previous worker output:\n${response.output}\n\nYour task: ${pending.task}`;
      const priorResults: string[] = [`**${memberName}**: ${response.output.substring(0, 500)}`];
      await this.runAllMembersInOrder(
        message,
        pending.teamName,
        team.members,
        pending.task,
        runOneWorker,
        { startIndex: pending.memberIndex + 1, startCarry: carryForNext, priorResults },
      );
      return;
    }

    // mode === 'auto'
    const { agent: mAgent, model: mModel } = this.getDispatcherAgentAndModel();
    const wm = this.workspaceManager.getWorkerManager();
    const turn = await runManager(
      {
        task: pending.task,
        members: team.members.map(n => ({ name: n, hint: wm.getDispatchHint(n) })),
        history: pending.history,
        lastWorker: pending.lastWorker,
        lastOutput: pending.lastOutput,
        userClarification: {
          worker: pending.askingWorker,
          question: pending.question,
          answer,
        },
      },
      { agent: mAgent, model: mModel, runner: this.dispatcherRunner },
    );
    if (turn.fallback) {
      await this.sendResponse({
        chatId: message.chatId,
        channel: message.channel,
        text: `⚠️ Manager failed on resume (${turn.fallbackReason}). Paused run dropped.`,
      });
      return;
    }
    const seededHistory: ManagerHistoryEntry[] = [
      ...pending.history,
      { worker: pending.askingWorker, summary: `User clarified: ${pending.question} → ${answer}` },
    ];
    if (turn.done || !turn.next) {
      await this.sendResponse({
        chatId: message.chatId,
        channel: message.channel,
        text: this.formatManagerParts(pending.partsSoFar, turn.final_summary ?? '', 500),
      });
      return;
    }
    const isRevision = pending.seenWorkers.includes(turn.next);
    await this.sendResponse({
      chatId: message.chatId,
      channel: message.channel,
      text: `🔄 Step ${pending.step}: **${turn.next}**${isRevision ? ' (revision)' : ''} — ${turn.reason}`,
    });
    const codingAgent = (wm.getWorkerCodingAgent(turn.next) ?? this.getDefaultAgent()) as CodingAgent;
    const workerModelName = wm.getWorkerModel(turn.next);
    const modelConfig = workerModelName
      ? this.getModelConfig(codingAgent, workerModelName)
      : this.getDefaultModelConfig(codingAgent);
    const stepTaskBody = this.composeStepTask(pending.task, turn.instruction, pending.lastWorker, pending.lastOutput);
    const stepPrompt = wm.buildWorkerPrompt(turn.next, stepTaskBody);
    const response = await runOneWorker(turn.next, stepPrompt, codingAgent, modelConfig);
    if (!response.success) {
      await this.sendResponse({
        chatId: message.chatId,
        channel: message.channel,
        text: `❌ Worker **${turn.next}** failed on resume: ${response.error}`,
      });
      return;
    }
    const ask = parseAskUser(response.output);
    const newParts = [...pending.partsSoFar, { step: pending.step, worker: turn.next, output: response.output, isRevision }];
    const newSeen = Array.from(new Set([...pending.seenWorkers, turn.next]));
    const newHistory = turn.summary_of_last
      ? [...seededHistory, { worker: pending.askingWorker, summary: turn.summary_of_last }]
      : seededHistory;
    if (ask) {
      this.persistPendingTeam(message.chatId, {
        mode: 'auto',
        teamName: pending.teamName,
        task: pending.task,
        history: newHistory,
        lastWorker: turn.next,
        lastOutput: response.output,
        partsSoFar: newParts,
        seenWorkers: newSeen,
        step: pending.step + 1,
        askingWorker: turn.next,
        question: ask.question,
        options: ask.options,
        askedAt: Date.now(),
      });
      const rendered3 = renderQuestion(turn.next, ask.preamble, ask.question, ask.options);
      await this.sendResponse({
        chatId: message.chatId,
        channel: message.channel,
        text: rendered3.text,
        choices: rendered3.choices,
      });
      return;
    }
    const closing = await runManager(
      {
        task: pending.task,
        members: team.members.map(n => ({ name: n, hint: wm.getDispatchHint(n) })),
        history: newHistory,
        lastWorker: turn.next,
        lastOutput: response.output,
        finalize: true,
      },
      { agent: mAgent, model: mModel, runner: this.dispatcherRunner },
    );
    const finalSummary = closing.fallback ? '' : (closing.final_summary ?? '');
    await this.sendResponse({
      chatId: message.chatId,
      channel: message.channel,
      text: this.formatManagerParts(newParts, finalSummary, 500),
    });
  }

  private async runAllMembersInOrder(
    message: UserMessage,
    teamName: string,
    members: string[],
    task: string,
    runOneWorker: (
      workerName: string,
      prompt: string,
      codingAgent: CodingAgent,
      modelConfig: ModelConfig | undefined,
    ) => Promise<{ success: boolean; output: string; error?: string }>,
    opts: { startIndex?: number; startCarry?: string; priorResults?: string[] } = {},
  ): Promise<void> {
    const { chatId, channel } = message;
    const workerManager = this.workspaceManager.getWorkerManager();
    const results: string[] = opts.priorResults ? [...opts.priorResults] : [];
    let currentTask = opts.startCarry ?? task;

    for (let i = opts.startIndex ?? 0; i < members.length; i++) {
      const memberName = members[i];
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
      const roster = members.map(n => ({ name: n, hint: workerManager.getDispatchHint(n) }));
      const nextName = members[i + 1];
      const nextWorker = nextName
        ? { name: nextName, hint: workerManager.getDispatchHint(nextName) }
        : null;
      const prompt = workerManager.buildSequentialWorkerPrompt(
        memberName,
        currentTask,
        roster,
        nextWorker,
      );
      const modelConfig = this.getModelConfig(codingAgent, model);
      const response = await runOneWorker(memberName, prompt, codingAgent, modelConfig);
      if (!response.success) {
        results.push(`**${worker.name}**: ❌ Failed - ${response.error}`);
        break;
      }
      const ask = parseAskUser(response.output);
      if (ask) {
        const pending: PendingTeamState = {
          mode: 'sequential',
          teamName,
          task,
          memberIndex: i,
          carry: currentTask,
          askingWorker: memberName,
          question: ask.question,
          options: ask.options,
          askedAt: Date.now(),
        };
        this.persistPendingTeam(chatId, pending);
        const rendered4 = renderQuestion(worker.name, ask.preamble, ask.question, ask.options);
        await this.sendResponse({
          chatId,
          channel,
          text: rendered4.text,
          choices: rendered4.choices,
        });
        return;
      }
      results.push(`**${worker.name}**: ${response.output.substring(0, 500)}`);
      currentTask = `Previous worker output:\n${response.output}\n\nYour task: ${task}`;
    }

    await this.sendResponse({
      chatId,
      channel,
      text: `📊 Team **${teamName}** results\n\n${results.join('\n\n')}`,
    });
  }

  private async runTeamForChat(
    teamName: string,
    team: { members: string[]; dispatch: 'all' | 'auto' },
    prompt: string,
    workingDir: string,
    sink: ChatStreamSink,
    chatId: string,
    signal?: AbortSignal,
    opts: { forceAll?: boolean } = {},
    chatAgent?: CodingAgent,
    chatModel?: ModelConfig,
  ): Promise<{ response: string; tokens?: number; choices?: string[] }> {
    if (!team || !team.members || team.members.length === 0) {
      throw new Error(`Team not found or empty: ${teamName}`);
    }
    const workerManager = this.workspaceManager.getWorkerManager();

    const runOneWorker = async (
      _workerName: string,
      workerPrompt: string,
      codingAgent: CodingAgent,
      modelConfig: ModelConfig | undefined,
    ): Promise<{ success: boolean; output: string; error?: string }> => {
      const response = await this.runWithFallback(codingAgent, {
        prompt: workerPrompt,
        agent: codingAgent,
        model: modelConfig,
        context: { workingDir },
        onStream: (text: string) => sink({ type: 'stream', chatId, token: text }),
        onStatus: (_update: any) => { /* status forwarded via sink elsewhere */ },
        signal,
      });
      return response?.success
        ? { success: true, output: this.formatAgentResponse(response) }
        : { success: false, output: '', error: response?.error };
    };

    const useManager = team.dispatch === 'auto' && !opts.forceAll;

    if (useManager) {
      const result = await this.runManagerLoop(
        team,
        prompt,
        signal,
        chatAgent,
        chatModel,
        ({ step, worker, reason, isRevision }) => {
          sink({
            type: 'info',
            chatId,
            message: `Step ${step}: ${worker}${isRevision ? ' (revision)' : ''} — ${reason}`,
          });
        },
        runOneWorker,
      );

      if (result.fallback) {
        if (signal?.aborted) {
          return { response: '' };
        }
        sink({ type: 'info', chatId, message: `Auto-routing failed (${result.fallbackReason}), running all members` });
        // fall through to all-members path below
      } else if (result.paused) {
        const p = result.paused;
        const wm = this.workspaceManager.getWorkerManager();
        const askWorkerName = wm.getWorker(p.askingWorker)?.name ?? p.askingWorker;
        this.persistPendingTeam(chatId, {
          mode: 'auto',
          teamName,
          task: prompt,
          history: p.history,
          lastWorker: p.lastWorker,
          lastOutput: p.lastOutput,
          partsSoFar: p.parts,
          seenWorkers: p.seenWorkers,
          step: p.step,
          askingWorker: p.askingWorker,
          question: p.question,
          options: p.options,
          askedAt: Date.now(),
        });
        const rendered5 = renderQuestion(askWorkerName, '', p.question, p.options);
        sink({ type: 'stream', chatId, token: rendered5.text });
        return { response: rendered5.text, choices: rendered5.choices };
      } else {
        if (signal?.aborted) {
          return { response: this.formatManagerParts(result.parts, result.finalSummary) };
        }
        if (result.fallbackMidRun) {
          sink({ type: 'info', chatId, message: `Manager halted mid-run: ${result.fallbackMidRun.reason}` });
        }
        return { response: this.formatManagerParts(result.parts, result.finalSummary) };
      }
    }

    // dispatch === 'all', forceAll, or auto-routing fallback
    let carry = prompt;
    const parts: string[] = [];
    for (let i = 0; i < team.members.length; i++) {
      if (signal?.aborted) break;
      const memberName = team.members[i];
      sink({ type: 'info', chatId, message: `Step ${i + 1}/${team.members.length}: ${memberName}` });
      const seqRoster = team.members.map(n => ({ name: n, hint: workerManager.getDispatchHint(n) }));
      const seqNextName = team.members[i + 1];
      const seqNextWorker = seqNextName
        ? { name: seqNextName, hint: workerManager.getDispatchHint(seqNextName) }
        : null;
      const stepPrompt = workerManager.buildSequentialWorkerPrompt(
        memberName,
        carry,
        seqRoster,
        seqNextWorker,
      );
      const codingAgent = (workerManager.getWorkerCodingAgent(memberName) ?? chatAgent ?? this.getDefaultAgent()) as CodingAgent;
      const workerModel = workerManager.getWorkerModel(memberName);
      const modelConfig = workerModel ? this.getModelConfig(codingAgent, workerModel) : chatModel ?? this.getDefaultModelConfig(codingAgent);
      const response = await runOneWorker(memberName, stepPrompt, codingAgent, modelConfig);
      if (!response.success) {
        parts.push(`### ${memberName}\n\n`);
        break;
      }
      const ask = parseAskUser(response.output);
      if (ask) {
        const askWorkerName = workerManager.getWorker(memberName)?.name ?? memberName;
        this.persistPendingTeam(chatId, {
          mode: 'sequential',
          teamName,
          task: prompt,
          memberIndex: i,
          carry,
          askingWorker: memberName,
          question: ask.question,
          options: ask.options,
          askedAt: Date.now(),
        });
        const rendered6 = renderQuestion(askWorkerName, ask.preamble, ask.question, ask.options);
        sink({ type: 'stream', chatId, token: rendered6.text });
        return { response: parts.length ? parts.join('\n\n---\n\n') + '\n\n' + rendered6.text : rendered6.text, choices: rendered6.choices };
      }
      parts.push(`### ${memberName}\n\n${response.output}`);
      carry = response.output;
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
          agent: this.getDefaultAgent() as CodingAgent, 
          model: undefined, 
          prompt: workerMatch[2] 
        };
      }
      
      // Check for team command
      const teamMatch = text.match(Codey.REGEX_TEAM);
      if (teamMatch) {
        const forceAll = teamMatch[2] === '--all';
        return {
          command: 'team',
          args: [teamMatch[1], ...(forceAll ? ['--all'] : [])],
          agent: this.getDefaultAgent() as CodingAgent,
          model: undefined,
          prompt: teamMatch[3]
        };
      }

      // Check for agent switch
      let agent = this.getDefaultAgent() as CodingAgent;
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
    const agent = (agentMatch ? agentMatch[1] : this.getDefaultAgent()) as CodingAgent;

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
    // Enablement is membership in fallback.order. Order matters: the priority
    // list defines both *which* agents are usable and what to try first.
    const fb = this.configManager?.getFallback() ?? this.config.fallback;
    const seen = new Set<CodingAgent>();
    const out: CodingAgent[] = [];
    for (const e of fb?.order ?? []) {
      if (Codey.ALL_AGENTS.includes(e.agent) && !seen.has(e.agent)) {
        seen.add(e.agent);
        out.push(e.agent);
      }
    }
    return out;
  }

  private async runWithFallback(agent: CodingAgent, request: AgentRequest): Promise<AgentResponse> {
    const response = await this.agentFactory.run(agent, request);
    if (response.success) return response;

    this.logger.error(`Agent ${agent} failed: ${response.error || response.output}`);

    // Fallback is opt-in. When disabled, surface the original failure.
    // Prefer the live configManager so a recent edit doesn't get masked by
    // the snapshot in `this.config`.
    const fb = this.configManager?.getFallback() ?? this.config.fallback;
    if (fb && fb.enabled === false) return response;

    // Prefer the user-configured order; else default to every enabled agent
    // with no specific model (resolved to that agent's defaultModel below).
    const rawOrder: FallbackEntry[] = fb?.order && fb.order.length > 0
      ? fb.order
      : this.getEnabledAgents().map(a => ({ agent: a }));

    // Skip the (agent, model) we just tried so we don't infinite-loop on the
    // same combination. Same agent with a different model is allowed.
    const originalModel = request.model?.model;
    const seen = new Set<string>([`${agent}::${originalModel ?? ''}`]);

    for (const entry of rawOrder) {
      // Agents are now considered "enabled" iff they appear in fallback.order,
      // and `rawOrder` is sourced from fallback.order — so every entry here is
      // by definition enabled. No additional skip needed.
      const resolvedModel = this.resolveFallbackModel(entry);
      if (!resolvedModel) {
        this.logger.warn(`Skipping fallback ${entry.agent}${entry.model ? `(${entry.model})` : ''}: no usable model config`);
        continue;
      }
      const key = `${entry.agent}::${resolvedModel.model}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const label = `${entry.agent}(${resolvedModel.model})`;
      this.logger.warn(`Agent ${agent} failed, trying ${label}...`);
      const fallbackResponse = await this.agentFactory.run(entry.agent, {
        ...request,
        agent: entry.agent,
        model: resolvedModel,
      });
      if (fallbackResponse.success) {
        const fromLabel = originalModel ? `${agent}(${originalModel})` : agent;
        fallbackResponse.output = `[Fallback: ${fromLabel} → ${label}]\n\n${fallbackResponse.output}`;
        return fallbackResponse;
      }
      this.logger.error(`Fallback ${label} also failed: ${fallbackResponse.error || fallbackResponse.output}`);
    }

    // All fallbacks failed, return original error
    return response;
  }

  private resolveFallbackModel(entry: FallbackEntry): ModelConfig | undefined {
    if (!entry.model) return this.getDefaultModelConfig(entry.agent);
    return this.getModelConfig(entry.agent, entry.model);
  }

  private checkRateLimit(userId: string): boolean {
    const lastRequest = this.userCooldowns.get(userId);
    if (!lastRequest) return true;
    return Date.now() - lastRequest >= this.COOLDOWN_MS;
  }

  getModelConfig(agent: CodingAgent, modelName: string): ModelConfig | undefined {
    // 1. Check the global model catalog (has credentials + full config)
    const catalogEntry = this.configManager?.getModel(modelName);
    if (catalogEntry) {
      return {
        provider: catalogEntry.provider ?? (catalogEntry.apiType === 'anthropic' ? 'anthropic' : 'openai'),
        model: catalogEntry.model,
        apiKey: catalogEntry.apiKey,
        baseUrl: catalogEntry.baseUrl,
        apiType: catalogEntry.apiType,
      };
    }

    // 2. Check if model is in the agent's model list
    const agentConfig = this.config.agents?.[agent];
    const provider = agentConfig?.provider || 'anthropic';
    if (agentConfig?.models?.some(m => m.toLowerCase() === modelName.toLowerCase())) {
      return { provider, model: modelName };
    }

    // 3. Infer provider from model name prefix
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

    // Bare model id — still callable, but no credentials attached.
    return { provider: 'unknown', model: modelName };
  }

  private async resolveDirectory(dirPath: string): Promise<DirectoryResolveResult> {
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
  ): Promise<{ response: string; conversationId: string; tokens?: number; durationSec?: number; choices?: string[] }> {
    const agent = this.getDefaultAgent();
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

    const formattedResponse = this.formatAgentResponse(response);
    const httpAsk = parseAskUser(formattedResponse);
    return {
      response: formattedResponse,
      conversationId: ctxId,
      tokens: response.tokens?.total,
      durationSec: response.duration,
      ...(httpAsk.options && httpAsk.options.length >= 2 ? { choices: httpAsk.options } : {}),
    };
  }

  async sendToChat(
    chatId: string,
    userText: string,
    sinkParam: ChatStreamSink,
    attachments?: import('@codey/core').FileAttachment[],
  ): Promise<{ response: string; chatId: string; tokens?: number; durationSec?: number }> {
    const chat = this.chatManager.get(chatId);
    if (!chat) throw new Error(`Chat not found: ${chatId}`);

    // Tee every sink event to the registered global listener so other surfaces
    // (e.g., the Mac app) see channel-driven chat updates too.
    const sink: ChatStreamSink = (ev) => {
      try { sinkParam(ev); } catch { /* swallow */ }
      if (this.chatEventListener) {
        try { this.chatEventListener(ev); } catch { /* swallow */ }
      }
    };

    // Queue if at capacity
    if ((this.chatSemaphore as any).running >= (this.chatSemaphore as any).max) {
      sink({ type: 'queued', chatId, position: this.chatSemaphore.queueLength + 1 });
    }
    await this.chatSemaphore.acquire();

    const abortController = new AbortController();
    this.chatAborts.set(chatId, abortController);

    const started = Date.now();

    // Resolve workspace → workingDir by reading workspace.json from disk.
    // Also pull team config so team-mode chats use the chat's workspace, not
    // whichever workspace WorkspaceManager has loaded as the active one.
    const workspacesRoot = this.workspaceManager.getWorkspacesRoot();
    const wsConfigPath = path.join(workspacesRoot, chat.workspaceName, 'workspace.json');
    let workingDir = this.workingDir;
    let chatWorkspaceTeams: Record<string, TeamConfigRaw> = {};
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
    const prompt = assistantPrefixForSelection(chat) + buildChatPrompt(chat, userText, attachments);

    const userMessage: ChatMessage = {
      id: randomUUID(),
      role: 'user',
      content: userText,
      timestamp: started,
      isComplete: true,
      attachments: attachments && attachments.length > 0 ? attachments : undefined,
    };
    this.chatManager.appendMessage(chatId, userMessage);

    // Per-chat override takes precedence over the gateway default.
    const agent = (chat.agent ?? this.getDefaultAgent()) as CodingAgent;
    const model = chat.model
      ? this.getModelConfig(agent, chat.model)
      : this.getDefaultModelConfig(agent);

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
        // Prefer the team named on the selection. Falling through to teamNames[0]
        // keeps legacy chats (persisted before per-team selection) working.
        const teamName = chat.selection.name && teamNames.includes(chat.selection.name)
          ? chat.selection.name
          : teamNames[0];
        const rawTeam = chatWorkspaceTeams[teamName];
        const rawMembers: string[] = Array.isArray(rawTeam) ? rawTeam : (rawTeam?.members ?? []);
        if (!rawMembers || rawMembers.length === 0) throw new Error(`Team "${teamName}" is empty`);
        // Prefer the active workspace's normalized team (which carries dispatch mode);
        // fall back to building a TeamConfig inline from the chat's raw config.
        const wsTeam = this.workspaceManager.getTeam(teamName);
        const team = wsTeam ?? {
          members: rawMembers,
          dispatch: (Array.isArray(rawTeam) ? 'all' : (rawTeam?.dispatch ?? 'all')) as 'all' | 'auto',
        };
        const r = await this.runTeamForChat(teamName, team, prompt, workingDir, sink, chatId, abortController.signal, {}, agent, model);
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
          signal: abortController.signal,
        });
        output = response?.success ? this.formatAgentResponse(response) : (streamedText || '');
        tokens = (response as any)?.tokens?.total;
      }
      if (abortController.signal.aborted && !output) {
        output = 'Stopped';
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
      const updated = this.chatManager.appendMessage(chatId, assistantMessage);

      // Plain-chat ASK_USER:choice detection. Team flows handled this earlier in
      // their own pause paths. For non-team chats, surface the options to the
      // channel and persist on the chat so the next user reply can be digit-mapped.
      let plainChoices: string[] | undefined;
      if (!updated.pendingTeam) {
        const plainAsk = parseAskUser(output);
        if (plainAsk?.options && plainAsk.options.length >= 2) {
          plainChoices = plainAsk.options;
          const lastMsg = updated.messages[updated.messages.length - 1];
          if (lastMsg && lastMsg.role === 'assistant') {
            lastMsg.choices = plainAsk.options;
            this.chatManager.setLastAskedOptions(chatId, lastMsg.id, plainAsk.options);
          }
        }
      }

      sink({ type: 'done', chatId, response: output, tokens, durationSec, title: updated.title, choices: plainChoices });
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
      if (this.chatAborts.get(chatId) === abortController) {
        this.chatAborts.delete(chatId);
      }
    }
  }

  /**
   * Cancel an in-flight chat turn. Returns true if a run was aborted.
   */
  stopChat(chatId: string): boolean {
    const controller = this.chatAborts.get(chatId);
    if (!controller) return false;
    controller.abort();
    return true;
  }
}
