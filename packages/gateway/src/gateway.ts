import * as path from 'path';
import * as fs from 'fs';
import { AgentRequest, AgentResponse, AideOptions, ChannelKind, Chat, ChatCompaction, ChatRoute, FallbackEntry, GatewayConfig, GatewayResponse, UserMessage, CodingAgent, ModelConfig, ChannelType, ChannelConfig, ChatMessage, ToolCallEntry, runAdvisor, summarizeChatMessages, generateChatTitle, generateTaskBrief, TaskBrief, AdvisorTurn, AdvisorHistoryEntry, parseAskUser, parseAsk, PendingTeamState, discussionDir, controlPath, summaryPath, topicPath, opinionPath, initDiscussionDir, TeamBlackboard, WorkerAnchor, lastParagraphPreview, parseAskAdvisor, stripAskAdvisor, buildSoloAdvisorPrompt, buildSoloAdvisorFollowupPrompt, SoloAdvisorInput, SoloAdvisorFollowupInput, TeamGraph, validateGraph, startRun, advance, resolveEdge, outgoingEdges, eligibleEdges, runJudge, JudgeInput, JudgeDecision, TeamGraphEdge, GraphRunState, SkillEntry, RunTrace, DistillDeps, DistillResult, matchSkill, confirmMatch, applySkill, distillCandidate, evolveSkill } from '@codey/core';
import { randomUUID } from 'crypto';
import { ConfigManager } from './config';
import { TelegramHandler, DiscordHandler, IMessageHandler, TuiHandler, ChannelHandler } from './channels';
import { AgentFactory } from '@codey/core';
import { Logger } from './logger';
import { ContextManager, ContextWindow } from '@codey/core';
import { MemoryStore } from '@codey/core';
import { WorkspaceManager, TeamConfigRaw, TeamConfig, DEFAULT_PARALLEL_SETTINGS } from '@codey/core';
import { WorkerManager } from '@codey/core';
import { ChatManager } from './chats';
import { PairingStore, ChannelBinding } from './pairings';
import { summarizePriorHistory } from './summary';
import { buildChatPrompt, buildChatBootstrapPrompt, buildChatResumePrompt, buildQuickQuestionPrompt, assistantPrefixForSelection, RunSemaphore, ChatStreamSink, READ_ONLY_TOOLS, QQStreamEvent, QQHistoryEntry, SOLO_ADVISOR_INSTRUCTION } from './chat-runner';
import { TurnQueue, QueuedMessage, Surface } from './turn-queue';
import { renderQuestion, renderCancelNotice, stripAskMarker } from './team-pause';
import { resolveChoiceDigit } from './digit-mapping';
import { ParallelTeamRunner, ParallelFinalEvent } from './parallel-team';
import { ChannelEmitter, ChatEmitter, TeamEmitter } from './team-emitter';
import { WorkerMessageEmitter } from './worker-message-emitter';

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

/** Max advisor escalation rounds per single-agent turn (solo advisor). */
const SOLO_ADVISOR_MAX_ROUNDS = 2;

/** Explicit `/skill <name> <task>` invocation. Threaded per-turn: handleMessage
 *  attaches it to the queued turn's payload, runOneTurn reads it from the
 *  payload, and (for channel-linked chats) it rides into sendToChat on the
 *  `origin` argument. Carrying it WITH the turn — instead of a chat-keyed
 *  map — means two queued `/skill` messages from the same chat can never
 *  swap invokes. */
export interface SkillInvoke {
  skill: SkillEntry;
  task: string;
}

export class Codey {
  private config: GatewayConfig;
  private agentFactory: AgentFactory;
  private handlers: Map<string, ChannelHandler> = new Map();
  private processingMessages: Set<string> = new Set();
  private logger: Logger;
  private contextManager: ContextManager;
  private workspaceManager: WorkspaceManager;
  private chatManager: ChatManager;
  private pairingStore: PairingStore;
  private configManager?: ConfigManager;
  private chatSemaphore = new RunSemaphore();
  /** In-flight Quick Question runs, keyed by parent chatId, for cancellation. */
  private qqAborts = new Map<string, AbortController>();
  private chatAborts: Map<string, AbortController> = new Map();
  private parallelResumes = new Map<string, (answer: string) => Promise<void>>();
  private activeParallelRuns = new Map<string, ParallelTeamRunner>();
  private turnQueue: TurnQueue;
  private chatEventListener: ((ev: any) => void) | undefined;
  private pairingEventListener: ((ev: { type: 'completed'; channel: ChannelKind; channelUserId: string }) => void) | undefined;

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

  /** Pending skill suggestions for the channel surface, keyed `${channel}:${chatId}`.
   *  (Chat-surface suggestions are persisted on the Chat via ChatManager instead.) */
  private pendingSkillSuggestions = new Map<string, DistillResult>();
  private skillRunCounter = 0;
  private lastSkillDistillTime = 0;
  private static SKILL_DISTILL_COOLDOWN_MS = 300_000; // 5 min
  private static SKILL_GC_EVERY_N_RUNS = 20;
  private static SKILL_EVOLVE_EVERY_N_USES = 3;

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

  private getSkipPermissions(): boolean {
    return this.configManager?.getSkipPermissions() ?? true;
  }

  /** Worker session TTL — after this, the next call re-bootstraps so a
   *  long-warm session doesn't drift from the latest workspace memory. */
  private static WORKER_SESSION_TTL_MS = 30 * 60 * 1000;

  /**
   * Stable conversationId used for worker session anchors. Distinct from
   * the chat's own conversationId so a `/team` run doesn't clobber the
   * chat anchor; suffixed with the team or worker name so different teams
   * keep their own session caches.
   */
  private workerConversationId(
    baseConvId: string,
    scope: { team?: string; worker?: string },
  ): string {
    if (scope.team) return `${baseConvId}-team-${scope.team}`;
    if (scope.worker) return `${baseConvId}-worker-${scope.worker}`;
    return baseConvId;
  }

  /**
   * Run one worker step, transparently using a warm `--resume` session
   * when available. Falls back to a cold bootstrap (sending the full
   * personality+memory+blackboard prompt) on the first call, when the
   * agent changes, when the session is past its TTL, or when a resume
   * attempt fails.
   *
   * Caller supplies a `buildBootstrapPrompt` closure that returns the
   * full cold-start prompt (personality + memory + blackboard + task).
   * For the warm path we send a much smaller resume prompt containing
   * only the blackboard delta since this session's last turn + the new
   * task body.
   */
  private async runWorkerStep(opts: {
    conversationId: string;
    workerName: string;
    task: string;
    blackboard: TeamBlackboard;
    codingAgent: CodingAgent;
    modelConfig: ModelConfig | undefined;
    buildBootstrapPrompt: () => string;
    onStream?: (text: string) => void;
    onThinking?: (text: string) => void;
    onStatus?: (update: any) => void;
    signal?: AbortSignal;
    workingDir?: string;
    interactive?: boolean;
    skipPermissions?: boolean;
  }): Promise<{ response: AgentResponse; usedResume: boolean }> {
    const ctxWindow = await this.contextManager.getOrCreate(opts.conversationId);
    const existing = this.contextManager.getWorkerAnchor(ctxWindow.id, opts.workerName);
    const ttlElapsed = existing
      ? Date.now() - existing.bootstrappedAt > Codey.WORKER_SESSION_TTL_MS
      : false;

    const wm = this.workspaceManager.getWorkerManager();
    const baseReq = {
      agent: opts.codingAgent,
      model: opts.modelConfig,
      context: { workingDir: opts.workingDir ?? this.workingDir },
      onStream: opts.onStream,
      onThinking: opts.onThinking,
      onStatus: opts.onStatus,
      signal: opts.signal,
      interactive: opts.interactive,
      skipPermissions: opts.skipPermissions,
    } as const;

    // ── Warm path: anchor exists, same agent, within TTL ─────────
    if (existing && existing.agent === opts.codingAgent && !ttlElapsed) {
      const delta = opts.blackboard.renderDeltaForWorker(opts.workerName, existing.blackboardSeenCount);
      const resumePrompt = wm.buildResumeWorkerPrompt(opts.task, delta || undefined);
      const resp = await this.runWithFallback(opts.codingAgent, {
        ...baseReq,
        prompt: resumePrompt,
        resumeSessionId: existing.sessionId,
      });
      if (resp.success) {
        // Update the seen-count snapshot so the next turn's delta is correct.
        await this.contextManager.setWorkerAnchor(ctxWindow.id, opts.workerName, {
          ...existing,
          blackboardSeenCount: opts.blackboard.totalCount(),
        });
        return { response: resp, usedResume: true };
      }
      // Resume failed — drop anchor and fall through to bootstrap.
      this.logger.warn(`[worker:${opts.workerName}] resume of ${existing.sessionId} failed; bootstrapping fresh`);
      await this.contextManager.clearWorkerAnchor(ctxWindow.id, opts.workerName);
    } else if (existing && existing.agent !== opts.codingAgent) {
      // Different agent now — old anchor is unusable; drop it.
      await this.contextManager.clearWorkerAnchor(ctxWindow.id, opts.workerName);
    } else if (existing && ttlElapsed) {
      // TTL expired — drop and re-bootstrap to pick up newer memory.
      this.logger.info(`[worker:${opts.workerName}] session TTL elapsed; bootstrapping fresh`);
      await this.contextManager.clearWorkerAnchor(ctxWindow.id, opts.workerName);
    }

    // ── Cold path: bootstrap full prompt ─────────────────────────
    const newSessionId = opts.codingAgent === 'claude-code' ? randomUUID() : undefined;
    const resp = await this.runWithFallback(opts.codingAgent, {
      ...baseReq,
      prompt: opts.buildBootstrapPrompt(),
      newSessionId,
    });
    if (resp.success) {
      const sid = newSessionId ?? resp.sessionId;
      if (sid) {
        const anchor: WorkerAnchor = {
          agent: opts.codingAgent,
          sessionId: sid,
          workerName: opts.workerName,
          blackboardSeenCount: opts.blackboard.totalCount(),
          bootstrappedAt: Date.now(),
        };
        await this.contextManager.setWorkerAnchor(ctxWindow.id, opts.workerName, anchor);
      }
    }
    return { response: resp, usedResume: false };
  }

  /**
   * Prefix a worker / team prompt with the workspace memory context relevant
   * to the given query. Used everywhere workers run so they get the same
   * `## Project Memory` block the main chat path already gets.
   */
  /**
   * Build the combined memory context block (user-global first, then
   * workspace-scoped). Returns empty string when memory is disabled or
   * neither store has anything relevant.
   */
  private buildMergedMemoryContext(query: string, forWorker?: string): string {
    if (this.config.memory?.enabled === false) return '';
    const sections: string[] = [];
    const globalCtx = this.workspaceManager.getGlobalMemoryStore().buildContext(
      query, undefined, undefined, forWorker,
    );
    if (globalCtx) {
      // Re-label so the agent can distinguish global vs workspace facts.
      sections.push(globalCtx.replace(/^## Project Memory/, '## User-Global Memory'));
    }
    const workspaceCtx = this.workspaceManager.getMemoryStore().buildContext(
      query, undefined, undefined, forWorker,
    );
    if (workspaceCtx) sections.push(workspaceCtx);
    return sections.join('\n\n');
  }

  private wrapPromptWithMemory(prompt: string, query: string, forWorker?: string): string {
    const ctx = this.buildMergedMemoryContext(query, forWorker);
    return ctx ? `${ctx}\n\n${prompt}` : prompt;
  }

  /**
   * Run the auto-extract heuristic on a worker step's response so insights
   * from worker runs flow into the same memory store the main chat uses.
   * Tagged with the worker name so they can be distinguished from chat
   * extractions later.
   */
  /**
   * Persist a team's accumulated `[DECISION]` markers to the workspace
   * memory store so future runs can recall what was decided. Skipped when
   * memory is disabled. Idempotent thanks to MemoryStore dedup.
   */
  /**
   * Persist the Advisor's final summary from a parallel discussion as a
   * `decision` memory entry so future runs on the same topic can recall
   * what was concluded. Best-effort — skipped when summary is empty.
   */
  private persistDiscussionSummary(
    teamName: string,
    topic: string,
    ev: ParallelFinalEvent,
  ): void {
    if (this.config.memory?.autoExtract === false) return;
    const summary = (ev.summary ?? '').replace(/^#\s+Summary\s*/i, '').trim();
    if (!summary) return;
    const oneLineTopic = topic.replace(/\s+/g, ' ').trim().slice(0, 80);
    this.workspaceManager.getMemoryStore().add({
      type: 'decision',
      content: summary,
      label: `Discussion (${teamName}): ${oneLineTopic}`,
      tags: ['discussion', teamName, `reason:${ev.reason}`],
      source: 'team',
    });
  }

  private persistBlackboardDecisions(
    blackboard: TeamBlackboard,
    teamName: string,
  ): void {
    if (this.config.memory?.autoExtract === false) return;
    if (blackboard.decisions.length === 0) return;
    const store = this.workspaceManager.getMemoryStore();
    for (const d of blackboard.decisions) {
      store.add({
        type: 'decision',
        content: d.text,
        label: `Team ${teamName} / ${d.worker}`,
        tags: ['team', teamName, `worker:${d.worker}`],
        source: 'team',
        // Decisions are intentionally workspace-wide: other workers should be
        // able to see what's been decided. If we ever want per-worker scoping
        // for decisions, surface it as an opt-in marker.
      });
    }
  }

  private extractWorkerMemories(
    workerName: string,
    task: string,
    agent: CodingAgent,
    response: AgentResponse,
  ): void {
    if (this.config.memory?.autoExtract === false || !response.success) return;
    const meta = ContextManager.extractMeta(response, agent);
    this.workspaceManager.getMemoryStore().extractFromInteraction({
      userPrompt: `[worker:${workerName}] ${task}`,
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

  /**
   * Per-agent default model name. Looks up the first fallback entry for the
   * agent that pins a model. When no entry pins a model for this agent, falls
   * back to the first model in the global catalog so fallback entries without
   * a pinned model don't get silently skipped.
   */
  private getDefaultModelName(agent: CodingAgent): string | undefined {
    const fb = this.configManager?.getFallback() ?? this.config.fallback;
    const pinned = fb?.order.find(e => e.agent === agent && !!e.model)?.model;
    if (pinned) return pinned;
    // No model pinned for this agent in the fallback order — pick the first
    // catalog model as a last resort. (The adapter may later reject it if the
    // apiType doesn't match, but that's still better than silently skipping
    // the entire fallback entry.)
    const catalog = this.configManager?.listModels() ?? this.config.models;
    return catalog?.[0]?.model;
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

  private getAdvisorAgentAndModel(): { agent: CodingAgent; model?: ModelConfig } {
    const cfg = this.config.advisor;
    const agent = (cfg?.agent as CodingAgent | undefined) ?? this.getDefaultAgent();
    const modelName = cfg?.model;
    const model = modelName ? this.getModelConfig(agent, modelName) : this.getDefaultModelConfig(agent);
    return { agent, model };
  }

  private advisorRunner = (req: AgentRequest): Promise<AgentResponse> => {
    return this.runWithFallback(req.agent, req);
  };

  /** Run the stronger advisor model for a stuck single agent. Returns plain-text
   *  guidance, or null on failure/timeout (caller degrades to the agent's reply). */
  private async runSoloAdvisor(
    input: SoloAdvisorInput,
    workingDir: string,
    signal?: AbortSignal,
  ): Promise<string | null> {
    const { agent, model } = this.getAdvisorAgentAndModel();
    try {
      const resp = await this.runWithFallback(agent, {
        prompt: buildSoloAdvisorPrompt(input),
        agent,
        model,
        context: { workingDir },
        onStream: () => {},
        onThinking: () => {},
        onStatus: () => {},
        signal,
      });
      if (!resp?.success) return null;
      const text = this.formatAgentResponse(resp).trim();
      return text.length > 0 ? text : null;
    } catch {
      return null;
    }
  }

  /** Resolve the agent + model for Aide (housekeeping) calls. Falls back to defaults. */
  private getAideAgentAndModel(): { agent: CodingAgent; model?: ModelConfig } {
    const cfg = this.config.aide;
    const agent = (cfg?.agent as CodingAgent | undefined) ?? this.getDefaultAgent();
    const modelName = cfg?.model;
    const model = modelName ? this.getModelConfig(agent, modelName) : this.getDefaultModelConfig(agent);
    return { agent, model };
  }

  private aideRunner = (req: AgentRequest): Promise<AgentResponse> => {
    return this.runWithFallback(req.agent, req);
  };

  /**
   * Build AideOptions for an outside caller (e.g. ChatManager triggering an
   * async summarization). Reads `aide` config live so user edits take effect
   * without a gateway restart.
   */
  public getAideOptions(signal?: AbortSignal): AideOptions {
    const { agent, model } = this.getAideAgentAndModel();
    return { agent, model, runner: this.aideRunner, signal };
  }

  /**
   * Compaction job invoked by ChatManager when a chat's unsummarized tail
   * grows past the trigger. Folds the head of `chat.messages` into a rolling
   * summary via the Aide, leaving a recent tail untouched so the next turn
   * still has fresh transcript to anchor on.
   */
  private async runChatCompaction(chat: Chat): Promise<ChatCompaction | null> {
    const KEEP_TAIL = 40;
    const already = chat.compaction?.summarizedUpTo ?? 0;
    const cutoff = chat.messages.length - KEEP_TAIL;
    if (cutoff <= already) return null;
    const toFold = chat.messages.slice(already, cutoff);
    if (toFold.length === 0) return null;

    const opts = this.getAideOptions();
    const summary = await summarizeChatMessages(toFold, chat.compaction?.summary, opts);
    if (!summary.trim()) return null;

    return {
      summary,
      summarizedUpTo: cutoff,
      model: opts.model?.model ?? '(default)',
      updatedAt: Date.now(),
    };
  }

  /** True when the user has explicitly configured an Aide agent or model. */
  private isAideConfigured(): boolean {
    const cfg = this.config.aide;
    return Boolean(cfg?.agent || cfg?.model);
  }

  /**
   * Generate a chat title via the Aide, swallowing any error. Returns '' on
   * failure so the caller keeps the truncated fallback title.
   */
  private async generateChatTitleSafe(firstUserMessage: string): Promise<string> {
    try {
      return await generateChatTitle(firstUserMessage, this.getAideOptions());
    } catch (err) {
      this.logger.warn(`Aide title generation failed: ${(err as Error).message}`);
      return '';
    }
  }

  /**
   * Generate (and cache) the Task HUD brief for a chat on demand. Returns null
   * when the Aide is not configured, the chat is missing, or generation fails —
   * callers keep showing whatever was cached.
   */
  public async generateTaskBrief(chatId: string): Promise<TaskBrief | null> {
    if (!this.isAideConfigured()) return null;
    const chat = this.chatManager.get(chatId);
    if (!chat) return null;
    try {
      const brief = await generateTaskBrief(chat, this.getAideOptions());
      this.chatManager.setTaskBrief(chatId, brief);
      return brief;
    } catch (err) {
      this.logger.warn(`Aide task-brief generation failed: ${(err as Error).message}`);
      return null;
    }
  }

  private conversationCleanupInterval?: NodeJS.Timeout;

  constructor(config: GatewayConfig, logger?: Logger, workspaceDir?: string, configManager?: ConfigManager, workerManager?: WorkerManager) {
    this.config = config;
    this.configManager = configManager;
    this.agentFactory = new AgentFactory();
    // Plumb per-agent env vars from the live config into every adapter spawn.
    // Read via configManager so renderer edits take effect on the next request.
    this.agentFactory.setAgentEnvProvider((a) => {
      const slot = this.configManager?.getAgentConfig(a);
      return slot?.env;
    });
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
    const wm = workerManager || new WorkerManager('./workers');
    this.workspaceManager = new WorkspaceManager(wm, workspaceDir || './workspaces', this.logger);
    this.chatManager = new ChatManager(this.workspaceManager.getWorkspacesRoot());
    this.chatManager.setCompactionRunner((chat) => this.runChatCompaction(chat));
    // Anchor pairings.json to the data root (parent of the workspaces dir),
    // not process.cwd(). In the packaged Mac app cwd can be `/`, which is
    // read-only and produces EROFS on first write.
    const dataRoot = path.dirname(this.workspaceManager.getWorkspacesRoot());
    this.pairingStore = new PairingStore(path.join(dataRoot, 'pairings.json'));
    this.turnQueue = new TurnQueue(async (_chatId, batch) => {
      // No coalescing in this version: process each queued message in order.
      for (const item of batch) {
        if (!item.payload) continue;
        await this.runOneTurn(item.payload.message, item.payload.parsed, item.payload.skillInvoke);
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

      const removedRoutes = this.chatManager.clearRoutesForChannel(name);
      const removedPairings = this.pairingStore.clearChannel(name);
      this.logger.info(`${name} handler stopped — cleared ${removedRoutes} route(s), ${removedPairings} pairing(s)`);
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

  public setPairingEventListener(
    fn: (ev: { type: 'completed'; channel: ChannelKind; channelUserId: string }) => void,
  ): void {
    this.pairingEventListener = fn;
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
  public async linkChat(chatId: string, channel: ChannelKind, channelUserId: string): Promise<Chat> {
    const binding = this.pairingStore.findByChannelUser(channel, channelUserId);
    if (!binding) throw new Error(`No pairing for ${channel}:${channelUserId}`);

    const route: ChatRoute = { channel, channelUserId, channelChatId: binding.channelChatId, attachedAt: Date.now() };

    const existing = this.chatManager.get(chatId);
    const alreadyLinked = !!existing?.routes?.some(r =>
      r.channel === channel &&
      r.channelUserId === channelUserId
    );

    const updated = this.chatManager.addRoute(chatId, route);
    this.pairingStore.setCurrentChat(channel, channelUserId, chatId);

    if (!alreadyLinked) {
      const effectiveAgent = (updated.agent ?? this.getDefaultAgent()) as CodingAgent;
      const effectiveModel = updated.model
        ?? this.getDefaultModelConfig(effectiveAgent)?.model
        ?? this.getEffectiveModel(effectiveAgent);
      const summary = summarizePriorHistory(updated, {
        defaultAgent: effectiveAgent,
        defaultModel: effectiveModel,
      });
      const handler = this.handlers.get(channel);
      if (handler?.sendToRoute) {
        try {
          await handler.sendToRoute(route, summary);
        } catch (err) {
          this.logger.warn(`linkChat: failed to push summary to ${channel}: ${(err as Error).message}`);
        }
      }
    }
    return updated;
  }

  public unlinkChat(chatId: string, channel: ChannelKind, channelUserId: string): Chat {
    return this.chatManager.removeRoute(chatId, channel, channelUserId);
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
   * Drop warm CLI sessions for a worker (or all workers when name omitted)
   * across every conversation. Call after editing/deleting a worker's
   * personality so the next run rebuilds with the latest definition rather
   * than `--resume`-ing into a session bootstrapped with the old one.
   */
  /**
   * Snapshot every warm worker anchor on a conversation. Used at team
   * pause time so resume can re-warm without re-bootstrapping.
   */
  private snapshotWorkerAnchors(conversationId: string): Record<string, WorkerAnchor> | undefined {
    const win = this.contextManager.getWindow(conversationId);
    const anchors = win?.workerAnchors;
    if (!anchors || Object.keys(anchors).length === 0) return undefined;
    // Shallow clone to keep the snapshot immune to later in-memory mutation.
    return Object.fromEntries(Object.entries(anchors).map(([k, v]) => [k, { ...v }]));
  }

  /** Restore previously snapshotted worker anchors onto a conversation. */
  private async rehydrateWorkerAnchors(
    conversationId: string,
    snapshot: Record<string, WorkerAnchor> | undefined,
  ): Promise<void> {
    if (!snapshot) return;
    for (const [name, anchor] of Object.entries(snapshot)) {
      await this.contextManager.setWorkerAnchor(conversationId, name, anchor);
    }
  }

  invalidateWorkerSessions(workerName?: string): void {
    if (workerName) {
      this.contextManager.clearWorkerAnchorEverywhere(workerName);
    } else {
      // No specific worker — drop all worker anchors on every window.
      for (const id of this.contextManager.listConversationIds()) {
        void this.contextManager.clearAllWorkerAnchorsForWindow(id);
      }
    }
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

  private resolveChatWorkingDir(chat: Chat): string {
    if (chat.workingDirOverride) {
      if (fs.existsSync(chat.workingDirOverride)) return chat.workingDirOverride;
      this.logger.warn(`Chat ${chat.id} workingDirOverride=${chat.workingDirOverride} is gone; falling back to workspace dir`);
    }
    const workspacesRoot = this.workspaceManager.getWorkspacesRoot();
    const wsConfigPath = path.join(workspacesRoot, chat.workspaceName, 'workspace.json');
    if (fs.existsSync(wsConfigPath)) {
      try {
        const wsConfig = JSON.parse(fs.readFileSync(wsConfigPath, 'utf-8'));
        if (wsConfig.workingDir) return wsConfig.workingDir;
      } catch { /* fall through */ }
    }
    return this.workingDir;
  }

  private async sendStartupNotification(): Promise<void> {
    const linkedChats = this.chatManager.list().filter(c => c.routes && c.routes.length > 0);

    for (const chat of linkedChats) {
      const workingDir = this.resolveChatWorkingDir(chat);
      const text = [
        `Codey is online`,
        ``,
        `Chat: ${chat.title}`,
        `Workspace: ${chat.workspaceName}`,
        `Working dir: ${workingDir}`,
      ].join('\n');

      for (const route of chat.routes!) {
        const handler = this.handlers.get(route.channel);
        if (!handler?.sendToRoute) continue;
        try {
          await handler.sendToRoute(route, text);
        } catch (error) {
          this.logger.error(`Error sending startup notification to ${route.channel}:${route.channelChatId}: ${error}`);
        }
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

      // ── Pending skill suggestion (channel surface) ──────────
      // Precedence mirrors the chat surface (sendToChat): a paused team's
      // question wins — when `pending` is set this message is the user's
      // answer to the team, so leave the suggestion persisted for later.
      // Slash turns also leave it pending rather than silently dropping it;
      // any other non-yes/no reply still clears it below.
      const pendingSkillKey = `${message.channel}:${message.chatId}`;
      const pendingSkill = this.pendingSkillSuggestions.get(pendingSkillKey);
      if (pendingSkill && !pending && !isSlash) {
        const reply = message.text.trim().toLowerCase();
        const renameMatch = reply.match(/^rename\s+([a-z][a-z0-9-]{2,29})$/);
        if (reply === 'yes' || renameMatch) {
          const name = renameMatch ? renameMatch[1] : pendingSkill.name;
          this.workspaceManager.getSkillStore().add({
            name,
            description: pendingSkill.description,
            whenToUse: pendingSkill.whenToUse,
            steps: pendingSkill.steps,
            sourceRunId: 'user-confirmed',
          });
          this.pendingSkillSuggestions.delete(pendingSkillKey);
          await this.sendResponse({
            chatId: message.chatId,
            channel: message.channel,
            text: `✅ Skill **${name}** saved! Use \`/skills\` to see all.`,
          });
          return;
        }
        if (reply === 'no') {
          this.workspaceManager.getSkillStore().rejectSuggestion(pendingSkill.name, pendingSkill.description);
          this.pendingSkillSuggestions.delete(pendingSkillKey);
          await this.sendResponse({
            chatId: message.chatId,
            channel: message.channel,
            text: `Got it — I won't suggest "${pendingSkill.name}" again.`,
          });
          return;
        }
        // Any other reply: drop the suggestion and fall through to normal handling.
        this.pendingSkillSuggestions.delete(pendingSkillKey);
      }

      // ── Explicit skill invocation: /skill <name> <task> ─────
      // Captures the invoke into a local carried WITH this turn (through
      // processPrompt → queue payload → runOneTurn), and rewrites the message
      // to the RAW task, so context/memory record the user's text and the run
      // path applies the skill exactly once — even with autoApply off.
      // Subcommands are excluded — parseCommand handles those.
      let skillInvoke: SkillInvoke | undefined;
      const invokeMatch = message.text.match(/^\/skill\s+(?!forget\b|restore\b|rollback\b|history\b)(\S+)\s+([\s\S]+)/i);
      if (invokeMatch) {
        if (!this.configManager?.getSkillsConfig()?.enabled) {
          await this.sendResponse({
            chatId: message.chatId,
            channel: message.channel,
            text: 'Skills are disabled.',
          });
          return;
        }
        const task = invokeMatch[2].trim();
        if (task.startsWith('/')) {
          await this.sendResponse({
            chatId: message.chatId,
            channel: message.channel,
            text: 'Usage: /skill <name> <task> — the task can\'t start with "/".',
          });
          return;
        }
        const name = invokeMatch[1].toLowerCase();
        const skill = this.workspaceManager.getSkillStore().getActive()
          .find(s => s.name === name);
        if (!skill) {
          await this.sendResponse({
            chatId: message.chatId,
            channel: message.channel,
            text: `Skill "${name}" not found. Use /skills to list active skills.`,
          });
          return;
        }
        skillInvoke = { skill, task };
        message = { ...message, text: task }; // raw task; run path applies the skill
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
          const handler = this.handlers.get(message.channel);
          const emitter = new ChannelEmitter(
            (r) => this.sendResponse(r),
            handler?.streamText ? (t: string) => handler.streamText!(t) : undefined,
            message.chatId, message.channel,
          );
          await this.resumeTeamFromAnswer(
            message.chatId,
            `${message.channel}-${message.chatId}`,
            pending,
            message.text,
            emitter,
          );
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
      await this.processPrompt(message, parsed, skillInvoke);

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

  /** Resolve which Codey Chat this channel message belongs to. */
  private resolveChatId(channel: ChannelType, userId: string): string | undefined {
    if (!this.isPairableChannel(channel)) return undefined;
    const byRoute = this.chatManager.findByRoute(channel, userId);
    if (byRoute) return byRoute.id;
    // 2. Per-user pairing `currentChatId` — multi-Chat /switch shortcut.
    const binding = this.pairingStore.findByChannelUser(channel, userId);
    if (binding?.currentChatId) return binding.currentChatId;
    return undefined;
  }

  private async processPrompt(
    message: UserMessage,
    parsed: ParsedCommand,
    skillInvoke?: SkillInvoke,
  ): Promise<void> {
    const { userId, chatId, channel } = message;

    const codeyChatId = this.resolveChatId(channel as ChannelType, userId);

    // Queue key: prefer the Codey chat id; fall back to the channel-derived id
    // so non-paired channels and Mac users still get per-conversation serialization.
    // Note: 'tui' is mapped to 'mac' for queueing purposes (Surface doesn't know 'tui').
    const queueKey = codeyChatId ?? `${channel}-${chatId}`;

    this.turnQueue.submit(queueKey, {
      surface: (channel === 'tui' ? 'mac' : channel) as Surface,
      text: parsed.prompt ?? '',
      userId,
      timestamp: Date.now(),
      payload: { message, parsed, skillInvoke },
    });
  }

  private async runOneTurn(
    message: UserMessage,
    parsed: ParsedCommand,
    skillInvoke?: SkillInvoke,
  ): Promise<void> {
    const { userId, chatId, channel, id: messageId } = message;

    const codeyChatId = this.resolveChatId(channel as ChannelType, userId);

    // Channel-side with a linked Codey chat → route through sendToChat so the
    // Codey Chat record is updated and the Mac app sees the events.
    if (codeyChatId) {
      await this.runChannelTurnViaChat(message, parsed, codeyChatId, skillInvoke);
      return;
    }

    // Get or create structured context window keyed by conversationId
    const conversationId = message.conversationId
      ?? (codeyChatId ? `chat-${codeyChatId}` : `${message.channel}-${message.chatId}`);
    const ctxWindow = await this.contextManager.getOrCreate(conversationId);

    // Build memory context — merges user-global + workspace stores.
    const memoryStore = this.workspaceManager.getMemoryStore();
    const memoryContext = this.buildMergedMemoryContext(parsed.prompt) || undefined;

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

    // ── Single-step execution (default path) ──────────────────
    const handler = this.handlers.get(channel);
    const onStream = handler?.streamText ? (text: string) => handler.streamText!(text) : undefined;
    const streamed = { active: false };

    // ── Skill matching (pre-run) ──────────────────────────
    // Explicit `/skill <name> <task>` invoke (carried on this turn's queue
    // payload by handleMessage — works even with autoApply off) takes
    // precedence; otherwise high-confidence match → apply directly;
    // borderline → LLM confirm gate.
    let appliedSkill: SkillEntry | null = null;
    const skillsCfg = this.configManager?.getSkillsConfig();
    let runPrompt = parsed.prompt;
    if (skillsCfg?.enabled && skillInvoke) {
      appliedSkill = skillInvoke.skill;
      runPrompt = applySkill(skillInvoke.task, skillInvoke.skill);
      this.logger.info(`[skills] explicit invoke: ${skillInvoke.skill.name} v${skillInvoke.skill.version}`);
    } else if (skillsCfg?.enabled && skillsCfg.autoApply) {
      // runPrompt is non-empty here: empty prompts already returned above.
      const match = matchSkill(runPrompt, this.workspaceManager.getSkillStore().getActive());
      if (match) {
        const confirmed = match.confidence === 'high'
          || await confirmMatch(this.getSkillDistillDeps(), runPrompt, match.skill);
        if (confirmed) {
          appliedSkill = match.skill;
          runPrompt = applySkill(runPrompt, match.skill);
          this.logger.info(`[skills] auto-applied: ${match.skill.name} v${match.skill.version} (${match.confidence})`);
        }
      }
    }

    let prep = this.prepareAgentTurn(ctxWindow, agent, runPrompt, memoryContext);
    const buildRequest = (p: typeof prep): AgentRequest => ({
      prompt: p.prompt,
      agent,
      model: parsed.model || this.getDefaultModelConfig(agent),
      timeout: this.tuiMode ? 1800000 : undefined, // 30 min for TUI
      interactive: this.tuiMode,
      skipPermissions: !this.tuiMode && this.getSkipPermissions(),
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
      prep = this.prepareAgentTurn(ctxWindow, agent, runPrompt, memoryContext);
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

    // ── Skills: post-run pass (fire-and-forget — never blocks the reply) ──
    if (skillsCfg?.enabled) {
      const trace: RunTrace = {
        runId: `solo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        promptSummary: parsed.prompt.slice(0, 200),
        outputPreview: (response.output || '').slice(0, 300),
        timestamp: Date.now(),
        mode: 'solo',
      };
      // afterRunSkillPass never rejects (stage-isolated try/catch inside).
      void this.afterRunSkillPass({
        trace,
        appliedSkill,
        clean: response.success,
        notify: (text) => this.sendResponse({ chatId, channel, text }),
        setPending: (s) => this.pendingSkillSuggestions.set(`${channel}:${chatId}`, s),
      });
    }
  }

  private async runChannelTurnViaChat(
    message: UserMessage,
    parsed: ParsedCommand,
    codeyChatId: string,
    skillInvoke?: SkillInvoke,
  ): Promise<void> {
    const { chatId, channel, userId, id: messageId } = message;

    // Sink: forward `done` to the originating channel only. Mirror to OTHER
    // attached routes is handled by sendToChat's built-in fan-out (which uses
    // the `origin` passed below to skip this channel's route).
    const sink = (ev: any) => {
      if (ev?.type === 'done' && typeof ev.response === 'string') {
        void this.sendResponse({
          chatId,
          channel,
          text: ev.response,
          choices: ev.choices,
          replyTo: messageId,
        });
      } else if (ev?.type === 'error' && typeof ev.message === 'string') {
        void this.sendResponse({
          chatId,
          channel,
          text: `❌ ${ev.message}`,
          replyTo: messageId,
        });
      } else if (ev?.type === 'info' && ev.skillNotice && typeof ev.message === 'string') {
        // Skill-tagged notices only (🧩 suggestion question / ⚙︎ evolve line).
        // Untagged info events are tool/status/advisor chatter — too noisy for
        // channel surfaces. Without this, a pending suggestion persisted on the
        // linked chat is INVISIBLE to a channel-only user, and their next
        // literal "yes"/"no" gets silently consumed by the suggestion handler.
        void this.sendResponse({
          chatId,
          channel,
          text: ev.message,
        });
      }
      // Ignore stream/tool_* events for channel surfaces.
    };

    try {
      // Task 12: sendToChat receives channel-origin explicit skill invokes on
      // `origin.skillInvoke` (threaded per-turn from handleMessage, never via
      // shared state). Its skill pre-run pass should give this precedence over
      // the matcher, exactly like runOneTurn does.
      await this.sendToChat(
        codeyChatId,
        parsed.prompt ?? message.text ?? '',
        sink,
        undefined,
        { channel: channel as ChannelType, channelUserId: userId, skillInvoke },
      );
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
    const routeCount = chat?.routes?.length ?? 0;
    if (!chat?.routes || routeCount === 0) {
      this.logger.info(`[fanOut] chat=${codeyChatId} origin=${originChannel} routes=${routeCount} → nothing to fan out`);
      return;
    }
    this.logger.info(`[fanOut] chat=${codeyChatId} origin=${originChannel} routes=${routeCount} text="${text.slice(0, 80).replace(/\s+/g, ' ')}…"`);
    // Chunk long messages — sendToRoute doesn't handle platform length limits
    // (Telegram ~4096, Discord ~2000), so split here using the same limit as
    // the normal sendResponse path.
    const chunks = text.length > this.MAX_MESSAGE_LENGTH
      ? this.splitIntoChunks(text, this.MAX_MESSAGE_LENGTH)
      : [text];
    for (const route of chat.routes) {
      if (route.channel === originChannel && route.channelUserId === originUserId) {
        this.logger.info(`[fanOut]   skip ${route.channel}:${route.channelUserId} (origin)`);
        continue;
      }
      const handler = this.handlers.get(route.channel);
      if (!handler?.sendToRoute) {
        this.logger.warn(`[fanOut]   no handler for ${route.channel} — handlers=[${[...this.handlers.keys()].join(',')}]`);
        continue;
      }
      try {
        for (let i = 0; i < chunks.length; i++) {
          const header = chunks.length > 1 && i > 0 ? `[${i + 1}/${chunks.length}]\n` : '';
          await handler.sendToRoute(route, header + chunks[i]);
        }
        this.logger.info(`[fanOut]   ✓ sent to ${route.channel}:${route.channelChatId} (${chunks.length} chunk(s))`);
      } catch (err) {
        this.logger.warn(`[fanOut]   ✗ failed to send to ${route.channel}: ${(err as Error).message}`);
      }
    }
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
      case 'skills':
        await this.cmdSkills(chatId, channel);
        break;
      case 'skill-forget': {
        const ok = this.workspaceManager.getSkillStore().archive(args[0]);
        await this.sendResponse({ chatId, channel,
          text: ok ? `🗑️ Skill **${args[0]}** archived. Restore with /skill restore ${args[0]}` : `Skill "${args[0]}" not found.` });
        break;
      }
      case 'skill-restore': {
        const ok = this.workspaceManager.getSkillStore().restore(args[0]);
        await this.sendResponse({ chatId, channel,
          text: ok ? `🔄 Skill **${args[0]}** restored.` : `Skill "${args[0]}" not found.` });
        break;
      }
      case 'skill-rollback': {
        const store = this.workspaceManager.getSkillStore();
        const ok = store.rollback(args[0]);
        const v = store.get(args[0])?.version;
        await this.sendResponse({ chatId, channel,
          text: ok ? `⏪ Skill **${args[0]}** rolled back to v${v}.` : `Skill "${args[0]}" has no prior version (or was not found).` });
        break;
      }
      case 'skill-history':
        await this.cmdSkillHistory(chatId, channel, args[0]);
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
        `- /team <name> [--all] <task> — run a named team. With dispatch:auto the Advisor iteratively picks workers and may loop back for revisions; --all bypasses the Advisor and runs every member in declared order.`,
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
      text: `👥 Teams (available in all workspaces)\n\n${this.workspaceManager.listTeams()}`,
    });
  }

  private async cmdSkillHistory(chatId: string, channel: ChannelType, name: string): Promise<void> {
    const skill = this.workspaceManager.getSkillStore().get(name);
    if (!skill) {
      await this.sendResponse({ chatId, channel, text: `Skill "${name}" not found.` });
      return;
    }
    if (!skill.evolution || skill.evolution.length === 0) {
      await this.sendResponse({ chatId, channel,
        text: `📜 **${skill.name}** (v${skill.version}) — no recorded evolution events yet.` });
      return;
    }
    const lines = skill.evolution.map(ev => {
      const trig = ev.trigger ? ` ← "${ev.trigger.promptSummary.replace(/\s+/g, ' ').slice(0, 80)}"` : '';
      return `- v${ev.toVersion} ${ev.kind} · ${Codey.relativeTime(ev.at)}${trig}`;
    });
    await this.sendResponse({
      chatId, channel,
      text: `📜 **${skill.name}** — evolution (v${skill.version} current${skill.archived ? ' · archived' : ''})\n\n${lines.join('\n')}\n\nCurrent steps (v${skill.version}):\n${skill.steps}`,
    });
  }

  private async cmdSkills(chatId: string, channel: ChannelType): Promise<void> {
    const active = this.workspaceManager.getSkillStore().getActive();
    if (active.length === 0) {
      await this.sendResponse({ chatId, channel, text: 'No active skills. Skills crystallize from repeated work patterns.' });
      return;
    }
    const lines = active.map(s =>
      `- **${s.name}** (v${s.version}): ${s.description} — used ${s.useCount}×, last ${Codey.relativeTime(s.lastUsedAt)}`
    );
    await this.sendResponse({ chatId, channel, text: `📋 **Skills** (${active.length})\n\n${lines.join('\n')}` });
  }

  private static relativeTime(ts: number): string {
    const diff = Date.now() - ts;
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  }

  private getSkillDistillDeps(): DistillDeps {
    const { agent, model } = this.getAdvisorAgentAndModel();
    const cfg = this.configManager?.getSkillsConfig();
    let resolved = model ?? this.getDefaultModelConfig(agent);
    if (cfg?.distillModel && resolved) {
      resolved = { ...resolved, model: cfg.distillModel };
    }
    return {
      agentFactory: this.agentFactory,
      activeAgent: agent,
      activeModel: resolved,
      workingDir: this.workingDir,
    };
  }

  /** Shared post-run skill pass for both surfaces. Never rejects — every LLM
   *  stage is isolated in its own try/catch so call sites can be a bare
   *  `void this.afterRunSkillPass(...)` without a `.catch`. */
  private async afterRunSkillPass(opts: {
    trace: RunTrace;
    appliedSkill: SkillEntry | null;
    clean: boolean;
    /** Deliver a one-liner to the user on whatever surface ran the turn. */
    notify: (text: string) => void | Promise<void>;
    /** Stash a suggestion so the user's next reply can resolve it. */
    setPending: (s: DistillResult) => void;
    /** Skip ONLY the distill/suggest stage (bookkeeping, evolve, trace, and GC
     *  still run). Set when the turn ended with the agent asking the user a
     *  question, so a suggestion doesn't hijack the user's answer. */
    suppressSuggestion?: boolean;
  }): Promise<void> {
    try {
      const cfg = this.configManager?.getSkillsConfig();
      if (!cfg || !cfg.enabled) return;
      const store = this.workspaceManager.getSkillStore();

      if (opts.appliedSkill) {
        // Bookkeeping stays outside the LLM try block so it always happens.
        store.recordUse(opts.appliedSkill.name);
        store.recordSuccessSignal(opts.appliedSkill.name, opts.clean);
        const entry = store.get(opts.appliedSkill.name);
        // Gate evolution to every Nth use — one weak trace is not enough signal
        // to rewrite steps on, and per-run LLM calls would be pure cost.
        if (opts.clean && entry && entry.useCount % Codey.SKILL_EVOLVE_EVERY_N_USES === 0) {
          try {
            const evolved = await evolveSkill(this.getSkillDistillDeps(), entry, opts.trace);
            if (evolved) {
              // Known v1 window: a concurrent /skill rollback (or another evolve)
              // between evolveSkill and bumpVersion can be silently overwritten.
              store.bumpVersion(entry.name, evolved, {
                runId: opts.trace.runId,
                promptSummary: opts.trace.promptSummary,
              });
              this.logger.info(`[skills] evolved ${entry.name} → v${entry.version}`);
              await opts.notify(`⚙︎ evolved skill ${entry.name} → v${entry.version} (rollback with /skill rollback ${entry.name})`);
            }
          } catch (err) {
            this.logger.warn(`[skills] evolve stage failed: ${err}`);
          }
        }
      }

      if (!opts.clean) return; // failed runs contribute a correction signal, not a trace

      store.recordTrace(opts.trace);

      this.skillRunCounter++;
      if (this.skillRunCounter % Codey.SKILL_GC_EVERY_N_RUNS === 1) {
        const n = store.runCollectGarbage({ staleDays: cfg.staleDays, weakSkillDays: cfg.weakSkillDays });
        if (n > 0) this.logger.info(`[skills] GC archived ${n} skill(s)`);
      }

      // Distill/suggest is the last stage, so suppressing it is an early
      // return. The cooldown is NOT consumed — the next unsuppressed run
      // can still surface the suggestion.
      if (opts.suppressSuggestion) return;

      try {
        const now = Date.now();
        if (now - this.lastSkillDistillTime > Codey.SKILL_DISTILL_COOLDOWN_MS) {
          const recent = store.getRecentTraces(cfg.suggestOnRepeat + 5);
          // Nothing to distill yet — skip WITHOUT consuming the cooldown.
          if (recent.length < cfg.suggestOnRepeat) return;
          this.lastSkillDistillTime = now;
          const candidate = await distillCandidate(
            this.getSkillDistillDeps(), recent, store.getAll(), store.getRejected(), cfg.suggestOnRepeat,
          );
          if (candidate) {
            opts.setPending(candidate);
            await opts.notify(
              `🧩 I've done something like this repeatedly ("${candidate.description}"). ` +
              `Save it as a reusable skill **${candidate.name}**? (reply "yes", "no", or "rename <new-name>")`
            );
          }
        }
      } catch (err) {
        this.logger.warn(`[skills] distill stage failed: ${err}`);
      }
    } catch (err) {
      this.logger.warn(`[skills] post-run pass failed: ${err}`);
    }
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
    // Optional `--global` flag selects the user-global store instead of
    // the current workspace's store.
    let useGlobal = false;
    const rest = [...args];
    if (rest[0] === '--global') { useGlobal = true; rest.shift(); }
    const memoryStore = useGlobal
      ? this.workspaceManager.getGlobalMemoryStore()
      : this.workspaceManager.getMemoryStore();
    const scopeLabel = useGlobal ? 'Global' : 'Workspace';

    if (rest.length === 0 || rest[0] === 'list') {
      const memories = memoryStore.getRecent(10);
      if (memories.length === 0) {
        await this.sendResponse({ chatId, channel, text: `No ${scopeLabel.toLowerCase()} memories stored.` });
        return;
      }
      const lines = memories.map(m =>
        `- [${m.type}] **${m.label}**: ${m.content.substring(0, 100)}${m.content.length > 100 ? '...' : ''}`
      );
      await this.sendResponse({
        chatId,
        channel,
        text: `\ud83e\udde0 ${scopeLabel} Memories (${memories.length})\n\n${lines.join('\n')}`,
      });
    } else if (rest[0] === 'search' && rest.length > 1) {
      const query = rest.slice(1).join(' ');
      const results = memoryStore.search(query);
      if (results.length === 0) {
        await this.sendResponse({ chatId, channel, text: `No ${scopeLabel.toLowerCase()} memories matching "${query}".` });
        return;
      }
      const lines = results.map(m => `- [${m.type}] **${m.label}**: ${m.content.substring(0, 100)}`);
      await this.sendResponse({
        chatId,
        channel,
        text: `\ud83d\udd0d ${scopeLabel} memory search: "${query}"\n\n${lines.join('\n')}`,
      });
    } else if (rest[0] === 'clear') {
      const all = memoryStore.getAll();
      for (const m of all) memoryStore.remove(m.id);
      await this.sendResponse({ chatId, channel, text: `\ud83d\uddd1\ufe0f All ${scopeLabel.toLowerCase()} memories cleared.` });
    } else {
      await this.sendResponse({
        chatId,
        channel,
        text: 'Usage:\n/memory [--global] - List recent memories (workspace or global)\n/memory [--global] search <query> - Search memories\n/memory [--global] clear - Clear all memories in that store\n/remember [--global] [--worker <name>] <text> - Add a memory',
      });
    }
  }

  private async cmdRemember(args: string[], message: UserMessage): Promise<void> {
    const { chatId, channel } = message;
    if (args.length === 0) {
      await this.sendResponse({
        chatId,
        channel,
        text: 'Usage: /remember [--global] [--worker <name>] <something to remember>\n\nExamples:\n/remember This project uses PostgreSQL 15 with pgvector\n/remember --global prefer pnpm over npm in every workspace\n/remember --worker reviewer prefer explicit error chaining over swallowed exceptions',
      });
      return;
    }

    // Parse leading flags (--global, --worker NAME, --workers a,b,c). Any
    // order; consumed from the head until a non-flag token appears.
    let scope: import('@codey/core').MemoryScope | undefined;
    let global = false;
    const rest = [...args];
    while (rest.length > 0) {
      if (rest[0] === '--global') {
        global = true;
        rest.splice(0, 1);
        continue;
      }
      if (rest[0] === '--worker' && rest[1]) {
        scope = { worker: rest[1] };
        rest.splice(0, 2);
        continue;
      }
      if (rest[0] === '--workers' && rest[1]) {
        const list = rest[1].split(',').map(s => s.trim()).filter(Boolean);
        if (list.length > 0) scope = { workers: list };
        rest.splice(0, 2);
        continue;
      }
      break;
    }

    if (rest.length === 0) {
      await this.sendResponse({ chatId, channel, text: 'Missing memory text after flag.' });
      return;
    }

    const content = rest.join(' ');
    const tags = ['user'];
    if (scope && typeof scope === 'object') {
      if ('worker' in scope) tags.push(`worker:${scope.worker}`);
      else if ('workers' in scope) for (const w of scope.workers) tags.push(`worker:${w}`);
    }
    if (global) tags.push('global');

    const store = global
      ? this.workspaceManager.getGlobalMemoryStore()
      : this.workspaceManager.getMemoryStore();
    const entry = store.add({
      type: 'fact',
      content,
      label: content.substring(0, 60),
      tags,
      source: global ? 'user-global' : 'user',
      scope,
    });

    const where = global ? ' (global)' : '';
    const scopeNote = scope && typeof scope === 'object'
      ? ('worker' in scope ? ` (worker: ${scope.worker})` : ` (workers: ${scope.workers.join(', ')})`)
      : '';
    await this.sendResponse({
      chatId,
      channel,
      text: `\ud83e\udde0 Remembered${where}${scopeNote}: ${entry.content}`,
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
    const ok = this.pairingStore.completePairing(code, { channel, channelUserId: userId, channelChatId: chatId });
    await this.sendResponse({
      chatId,
      channel,
      text: ok
        ? '✅ Paired. Use /new to start a chat, or link an existing chat from the Mac app.'
        : '❌ Invalid or expired code.',
    });
    if (ok && this.pairingEventListener) {
      try {
        this.pairingEventListener({ type: 'completed', channel, channelUserId: userId });
      } catch { /* swallow */ }
    }
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
      channelChatId: binding.channelChatId,
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

  private getHelpText(): string {
    return `\ud83e\udd16 Codey Commands

\ud83d\udc65 Workers
/workers - List all workers in the global library
/worker <name> <task> - Run a specific worker
/teams - List teams declared on this workspace
/team <name> [--all] <task> — run a named team. With dispatch:auto the Advisor iteratively picks workers and may loop back for revisions; --all bypasses the Advisor and runs every member in declared order.

\ud83e\udd16 Agents (legacy)
/parallel <prompt> - Run all agents in parallel
/all <prompt> - Run all agents in parallel
/agent <name> - Switch agent

\ud83e\udde0 Memory
/memory - List recent memories
/memory search <query> - Search memories
/memory clear - Clear all memories
/remember <text> - Save a memory

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

    // Build cold-start bootstrap prompt — runWorkerStep only invokes the
    // closure when no warm session exists (or it expired / wrong agent).
    const buildBootstrapPrompt = () => {
      const basePrompt = this.workspaceManager.getWorkerManager().buildWorkerPrompt(workerName, task);
      return this.wrapPromptWithMemory(basePrompt, task, workerName);
    };

    const modelConfig = this.getModelConfig(codingAgent, model);
    const handler = this.handlers.get(channel);
    const onStream = handler?.streamText ? (text: string) => handler.streamText!(text) : undefined;
    const baseConv = `${channel}-${chatId}`;
    const workerConv = this.workerConversationId(baseConv, { worker: workerName });

    // Single-worker invocation: blackboard is unused (no peers to hand off
    // to) but runWorkerStep needs a value for delta tracking.
    const { response } = await this.runWorkerStep({
      conversationId: workerConv,
      workerName,
      task,
      blackboard: new TeamBlackboard(),
      codingAgent,
      modelConfig,
      buildBootstrapPrompt,
      onStream,
      interactive: this.tuiMode,
      skipPermissions: !this.tuiMode && this.getSkipPermissions(),
    });

    this.extractWorkerMemories(workerName, task, codingAgent, response);

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
   * Iteratively drives the team Advisor. Returns the chronological run result
   * or `{ fallback: true }` when the Advisor fails on turn 1 — caller should
   * fall back to running all members in input order.
   *
   * Mid-run Advisor failures (turn 2+) end the loop gracefully: the parts
   * collected so far are returned with `fallbackMidRun` set so the caller
   * can annotate the user-visible header.
   */
  private async runAdvisorLoop(
    team: { members: string[] },
    task: string,
    signal: AbortSignal | undefined,
    chatAgent: CodingAgent | undefined,
    chatModel: ModelConfig | undefined,
    perStep: (msg:
      | { kind: 'route'; step: number; worker: string; reason: string; isRevision: boolean }
      | { kind: 'blackboard'; step: number; worker: string; summary: string }
    ) => void | Promise<void>,
    runWorker: (worker: string, prompt: string, codingAgent: CodingAgent, modelConfig: ModelConfig | undefined, blackboard: TeamBlackboard) => Promise<{ success: boolean; output: string; error?: string; thinking?: string }>,
    onStepDone?: (d: { step: number; worker: string; failed: boolean }) => void,
  ): Promise<
    | { fallback: true; fallbackReason: string }
    | {
        fallback: false;
        paused?: undefined;
        parts: Array<{ step: number; worker: string; output: string; isRevision: boolean }>;
        finalSummary: string;
        fallbackMidRun?: { reason: string };
        blackboard: TeamBlackboard;
        thinkingByStep?: Record<number, string>;
      }
    | {
        fallback: false;
        paused: {
          history: AdvisorHistoryEntry[];
          lastWorker: string;
          lastOutput: string;
          parts: Array<{ step: number; worker: string; output: string; isRevision: boolean }>;
          seenWorkers: string[];
          step: number;
          askingWorker: string;
          question: string;
          options?: string[];
        };
        blackboard: TeamBlackboard;
      }
  > {
    const workerManager = this.workspaceManager.getWorkerManager();
    const members = team.members;
    const cap = Math.max(Math.min(2 * members.length, 12), 4);
    const FORWARD_HOP_CAP = 2;

    const history: AdvisorHistoryEntry[] = [];
    let lastWorker: string | null = null;
    let lastOutput: string | null = null;
    const parts: Array<{ step: number; worker: string; output: string; isRevision: boolean }> = [];
    let finalSummary = '';
    let fallbackMidRun: { reason: string } | undefined;
    const blackboard = new TeamBlackboard();
    const thinkingByStep: Record<number, string> = {};

    const { agent: mAgent, model: mModel } = this.getAdvisorAgentAndModel();
    const seenWorkers = new Set<string>();

    // When set, skip the next Advisor call and run this worker directly
    // (used when a worker emits `[ASK: <teammate>]: q` to forward).
    let directNext: { worker: string; instruction: string } | null = null;
    // When set, the next Advisor turn arbitrates this pending question
    // (used when a worker emits `[ASK_USER]:` or forwards to an unknown target).
    let pendingArbitration: { worker: string; question: string; options?: string[] } | null = null;
    // Number of consecutive direct forwards since the last Advisor turn.
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
        const turn: AdvisorTurn = await runAdvisor(
          {
            task,
            members: members.map(n => ({ name: n, hint: workerManager.getDispatchHint(n) })),
            history,
            lastWorker,
            lastOutput,
            pendingQuestion: pendingArbitration ?? undefined,
          },
          { agent: mAgent, model: mModel, runner: this.advisorRunner, signal },
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
            blackboard,
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
      // Build a per-step "last did" map from Advisor history: latest entry per worker.
      const lastDidByWorker = new Map<string, string>();
      for (const h of history) lastDidByWorker.set(h.worker, h.summary);
      const teamRoster = members
        .filter(n => n !== turnNext)
        .map(n => ({
          name: n,
          hint: workerManager.getDispatchHint(n),
          lastDid: lastDidByWorker.get(n),
        }));
      const prompt = workerManager.buildTeamWorkerPrompt(
        turnNext,
        stepTaskBody,
        teamRoster,
        blackboard.renderForWorker(turnNext),
      );

      const response = await runWorker(turnNext, prompt, codingAgent, modelConfig, blackboard);
      if (!response.success) {
        onStepDone?.({ step, worker: turnNext, failed: true });
        fallbackMidRun = { reason: `worker ${turnNext} failed: ${response.error ?? 'unknown'}` };
        break;
      }
      if (response.thinking) thinkingByStep[step] = response.thinking;
      // Pull structured markers out before anything downstream sees the
      // output — users get clean prose, blackboard collects the structure.
      const ingested = blackboard.ingest(turnNext, step, response.output);
      const cleanOutput = ingested.stripped;
      const deltaSummary = blackboard.summarizeDelta(ingested.added);
      if (deltaSummary) await perStep({ kind: 'blackboard', step, worker: turnNext, summary: deltaSummary });

      parts.push({ step, worker: turnNext, output: cleanOutput, isRevision });
      onStepDone?.({ step, worker: turnNext, failed: false });
      seenWorkers.add(turnNext);
      lastWorker = turnNext;
      lastOutput = cleanOutput;

      const ask = parseAsk(cleanOutput);
      if (!ask) continue;

      if (ask.kind === 'team') {
        const targetValid = members.includes(ask.target) && ask.target !== turnNext;
        if (targetValid && forwardHops < FORWARD_HOP_CAP) {
          forwardHops += 1;
          // Record the forward in history so the Advisor retains visibility of
          // the asking worker's contribution despite skipping the Advisor turn.
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
        // Invalid target or hop cap exceeded → Advisor arbitrates.
        pendingArbitration = { worker: turnNext, question: ask.question, options: undefined };
        continue;
      }
      // kind === 'user' → Advisor arbitrates whether to route or escalate.
      pendingArbitration = { worker: turnNext, question: ask.question, options: ask.options };
    }

    // Cap exhausted without explicit done — request a final summary.
    // Skip when the user aborted: the inner runner will fail anyway and we
    // shouldn't send a fresh request after cancellation.
    if (!finalSummary && parts.length > 0 && !fallbackMidRun && !signal?.aborted) {
      const closing = await runAdvisor(
        {
          task,
          members: members.map(n => ({ name: n, hint: workerManager.getDispatchHint(n) })),
          history,
          lastWorker,
          lastOutput,
          finalize: true,
        },
        { agent: mAgent, model: mModel, runner: this.advisorRunner, signal },
      );
      if (!closing.fallback) finalSummary = closing.final_summary ?? '';
    }

    return { fallback: false, parts, finalSummary, fallbackMidRun, blackboard, thinkingByStep };
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

  private formatAdvisorParts(
    parts: Array<{ step: number; worker: string; output: string; isRevision: boolean }>,
    finalSummary: string,
    previewChars?: number,
  ): string {
    const head = finalSummary ? `🧭 Advisor summary: ${finalSummary}\n\n` : '';
    const body = parts
      .map(p => {
        const label = p.isRevision ? `${p.worker} (revision)` : p.worker;
        // Condense each step to its last paragraph (~previewChars) so the run
        // reads as a tight summary instead of a wall of per-step output.
        const out = previewChars ? lastParagraphPreview(p.output, previewChars) : p.output;
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
        text: `Usage: /team <name> [--all] <task>\n\nAvailable teams:\n${teamList}`,
      });
      return;
    }

    const team = this.workspaceManager.getTeam(teamName);
    if (!team) {
      const teamList = this.workspaceManager.listTeams();
      await this.sendResponse({
        chatId,
        channel,
        text: `Team "${teamName}" not found.\n\nAvailable teams:\n${teamList}`,
      });
      return;
    }

    const handler = this.handlers.get(channel);
    const { members, dispatch } = team;
    const baseConv = `${channel}-${chatId}`;
    const teamConv = this.workerConversationId(baseConv, { team: teamName });
    const turnTeamTurnId = randomUUID();

    // Helper to run one worker once, used by both the Advisor loop and the
    // legacy "all members in input order" fallback. Routes through
    // runWorkerStep so subsequent invocations of the same worker reuse
    // the warm CLI session via --resume.
    const runOneWorker = async (
      workerName: string,
      prompt: string,
      codingAgent: CodingAgent,
      modelConfig: ModelConfig | undefined,
      blackboard: TeamBlackboard,
      onThinking?: (text: string) => void,
    ): Promise<{ success: boolean; output: string; error?: string; thinking?: string }> => {
      const onStream = handler?.streamText ? (text: string) => handler.streamText!(text) : undefined;
      const { response } = await this.runWorkerStep({
        conversationId: teamConv,
        workerName,
        task,
        blackboard,
        codingAgent,
        modelConfig,
        buildBootstrapPrompt: () => this.wrapPromptWithMemory(prompt, task, workerName),
        onStream,
        onThinking,
        interactive: this.tuiMode,
        skipPermissions: !this.tuiMode && this.getSkipPermissions(),
      });
      this.extractWorkerMemories(workerName, task, codingAgent, response);
      return response.success
        ? { success: true, output: response.output, thinking: response.thinking || undefined }
        : { success: false, output: '', error: response.error };
    };

    const useAdvisor = dispatch === 'auto' && !opts.forceAll;

    if (useAdvisor) {
      await this.sendResponse({
        chatId,
        channel,
        text: `🧭 Advisor running team **${teamName}**\nTask: ${task.substring(0, 100)}${task.length > 100 ? '...' : ''}`,
      });

      const result = await this.runAdvisorLoop(
        team,
        task,
        undefined,
        undefined,
        undefined,
        async (msg) => {
          if (msg.kind === 'route') {
            await this.sendResponse({
              chatId,
              channel,
              text: `🔄 Step ${msg.step}: **${msg.worker}**${msg.isRevision ? ' (revision)' : ''} — ${msg.reason}`,
            });
          } else {
            await this.sendResponse({ chatId, channel, text: msg.summary });
          }
        },
        runOneWorker,
      );

      if (result.fallback) {
        await this.sendResponse({
          chatId,
          channel,
          text: `⚠️ Auto-routing failed (${result.fallbackReason}), running all members.`,
        });
        const fbEmitter = new ChannelEmitter((r) => this.sendResponse(r), handler?.streamText ? (t: string) => handler.streamText!(t) : undefined, message.chatId, message.channel);
        await this.runAllMembersInOrder(fbEmitter, message.chatId, baseConv, teamName, members, task, runOneWorker, { teamTurnId: turnTeamTurnId });
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
          teamTurnId: turnTeamTurnId,
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
          blackboard: result.blackboard.toJSON(),
          workerAnchors: this.snapshotWorkerAnchors(teamConv),
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
          text: `⚠️ Advisor halted mid-run: ${result.fallbackMidRun.reason}`,
        });
      }

      const text = this.formatAdvisorParts(result.parts, result.finalSummary, /*previewChars*/ 200);
      const bbBlock = result.blackboard.renderForUser();
      const body = `📊 Team **${teamName}** results\n\n${text}`;
      await this.sendResponse({
        chatId,
        channel,
        text: bbBlock ? `${body}\n\n${bbBlock}` : body,
      });
      this.persistBlackboardDecisions(result.blackboard, teamName);
      return;
    }

    // dispatch === 'all' OR forceAll: legacy path
    if (!opts.forceAll && team.graph) {
      await this.runSequentialGraphForChat(message, teamName, team.graph, task, runOneWorker, turnTeamTurnId);
      return;
    }
    const headerSuffix = opts.forceAll ? ' [--all override]' : '';
    await this.sendResponse({
      chatId,
      channel,
      text: `👥 Running team **${teamName}** (${members.join(' → ')})${headerSuffix}\nTask: ${task.substring(0, 100)}${task.length > 100 ? '...' : ''}`,
    });
    const allEmitter = new ChannelEmitter((r) => this.sendResponse(r), handler?.streamText ? (t: string) => handler.streamText!(t) : undefined, message.chatId, message.channel);
    await this.runAllMembersInOrder(allEmitter, message.chatId, baseConv, teamName, members, task, runOneWorker, { teamTurnId: turnTeamTurnId });
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
    chatId: string,
    convBase: string,
    pending: PendingTeamState,
    answer: string,
    emitter: TeamEmitter,
  ): Promise<string> {
    // NOTE: this resume path emits the legacy "📊 Team results" format (not the
    // `### Step` structure parsed by the mac UI), so extended-thinking is only
    // surfaced through the emitter's onThinking hook. Showing per-step thinking
    // on resume more richly requires first unifying this path onto the same sink
    // + structured-message pipeline as runTeamForChat — tracked as a follow-up
    // (see docs/superpowers/specs/...-resume-streaming-unification).
    const team = this.workspaceManager.getTeam(pending.teamName);
    if (!team) {
      await emitter.notify(`Team \`${pending.teamName}\` no longer exists; the paused run was dropped.`);
      return emitter.transcript;
    }
    const teamConv = this.workerConversationId(convBase, { team: pending.teamName });
    // Rehydrate any warm worker sessions captured at pause time so the
    // resumed step continues `--resume`-ing instead of re-bootstrapping.
    await this.rehydrateWorkerAnchors(teamConv, pending.workerAnchors);
    const runOneWorker = async (
      workerName: string,
      prompt: string,
      codingAgent: CodingAgent,
      modelConfig: ModelConfig | undefined,
      blackboard: TeamBlackboard,
      onThinking?: (text: string) => void,
    ): Promise<{ success: boolean; output: string; error?: string; thinking?: string }> => {
      const { response } = await this.runWorkerStep({
        conversationId: teamConv,
        workerName,
        task: pending.task,
        blackboard,
        codingAgent,
        modelConfig,
        buildBootstrapPrompt: () => this.wrapPromptWithMemory(prompt, pending.task, workerName),
        onStream: (text: string) => emitter.onStream(text),
        onThinking: onThinking ?? ((text: string) => emitter.onThinking(text, 0)),
        interactive: this.tuiMode,
        skipPermissions: !this.tuiMode && this.getSkipPermissions(),
      });
      this.extractWorkerMemories(workerName, pending.task, codingAgent, response);
      return response.success
        ? { success: true, output: response.output, thinking: response.thinking || undefined }
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
      const blackboard = TeamBlackboard.fromJSON(pending.blackboard);
      const reprompt = wm.buildSequentialWorkerPrompt(
        memberName,
        `${pending.carry}\n\n[User answer to your question "${pending.question}"]:\n${answer}`,
        seqRoster,
        seqNextWorker,
        blackboard.renderForWorker(memberName),
      );
      await emitter.status(`🔄 Resuming **${memberName}** with your answer…`);
      const response = await runOneWorker(memberName, reprompt, codingAgent, modelConfig, blackboard);
      if (!response.success) {
        await emitter.notify(`❌ Worker **${memberName}** failed on resume: ${response.error}`);
        return emitter.transcript;
      }
      const ingested = blackboard.ingest(memberName, pending.memberIndex + 1, response.output);
      response.output = ingested.stripped;
      const deltaSummary = blackboard.summarizeDelta(ingested.added);
      if (deltaSummary) {
        await emitter.status(deltaSummary);
      }
      const ask = parseAskUser(response.output);
      if (ask) {
        this.persistPendingTeam(chatId, {
          mode: 'sequential',
          teamName: pending.teamName,
          task: pending.task,
          teamTurnId: pending.teamTurnId,
          memberIndex: pending.memberIndex,
          carry: pending.carry,
          askingWorker: memberName,
          question: ask.question,
          options: ask.options,
          askedAt: Date.now(),
          blackboard: blackboard.toJSON(),
          workerAnchors: this.snapshotWorkerAnchors(teamConv),
        });
        const rendered2 = renderQuestion(memberName, ask.preamble, ask.question, ask.options);
        await emitter.notify(rendered2.text, rendered2.choices);
        return emitter.transcript;
      }
      const carryForNext = `Previous worker output:\n${response.output}\n\nYour task: ${pending.task}`;
      const priorResults: string[] = [`**${memberName}**: ${response.output}`];
      await this.runAllMembersInOrder(
        emitter,
        chatId,
        convBase,
        pending.teamName,
        team.members,
        pending.task,
        runOneWorker,
        { startIndex: pending.memberIndex + 1, startCarry: carryForNext, priorResults, blackboard, conversationId: teamConv, teamTurnId: pending.teamTurnId },
      );
      return emitter.transcript;
    }

    if (pending.mode === 'graph') {
      if (!team.graph) {
        await emitter.notify(`Team \`${pending.teamName}\` no longer has a flow graph; the paused run was dropped.`);
        return emitter.transcript;
      }
      const state: GraphRunState = { currentNodeId: pending.graphState.currentNodeId, hops: pending.graphState.hops, status: 'running', visited: pending.graphState.visited, runStreak: pending.graphState.runStreak ?? 0 };
      const blackboard = TeamBlackboard.fromJSON(pending.blackboard);
      await this.continueGraphRun(
        emitter, chatId, convBase,
        pending.teamName, pending.teamTurnId, team.graph, pending.task, state, blackboard, pending.results,
        runOneWorker, { resume: { question: pending.question, answer } },
      );
      return emitter.transcript;
    }

    // mode === 'auto'
    const { agent: mAgent, model: mModel } = this.getAdvisorAgentAndModel();
    const wm = this.workspaceManager.getWorkerManager();
    const turn = await runAdvisor(
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
      { agent: mAgent, model: mModel, runner: this.advisorRunner },
    );
    if (turn.fallback) {
      await emitter.notify(`⚠️ Advisor failed on resume (${turn.fallbackReason}). Paused run dropped.`);
      return emitter.transcript;
    }
    const seededHistory: AdvisorHistoryEntry[] = [
      ...pending.history,
      { worker: pending.askingWorker, summary: `User clarified: ${pending.question} → ${answer}` },
    ];
    if (turn.done || !turn.next) {
      await emitter.notify(this.formatAdvisorParts(pending.partsSoFar, turn.final_summary ?? '', 200));
      return emitter.transcript;
    }
    const isRevision = pending.seenWorkers.includes(turn.next);
    await emitter.status(`🔄 Step ${pending.step}: **${turn.next}**${isRevision ? ' (revision)' : ''} — ${turn.reason}`);
    const codingAgent = (wm.getWorkerCodingAgent(turn.next) ?? this.getDefaultAgent()) as CodingAgent;
    const workerModelName = wm.getWorkerModel(turn.next);
    const modelConfig = workerModelName
      ? this.getModelConfig(codingAgent, workerModelName)
      : this.getDefaultModelConfig(codingAgent);
    const stepTaskBody = this.composeStepTask(pending.task, turn.instruction, pending.lastWorker, pending.lastOutput);
    // Use the team-aware builder so the resumed worker also sees the blackboard
    // and the marker protocol — keeps post-pause steps consistent with pre-pause.
    const resumeRoster = team.members
      .filter(n => n !== turn.next)
      .map(n => ({ name: n, hint: wm.getDispatchHint(n) }));
    const resumeBoardForPrompt = TeamBlackboard.fromJSON(pending.blackboard);
    const stepPrompt = wm.buildTeamWorkerPrompt(
      turn.next,
      stepTaskBody,
      resumeRoster,
      resumeBoardForPrompt.renderForWorker(turn.next),
    );
    const response = await runOneWorker(turn.next, stepPrompt, codingAgent, modelConfig, resumeBoardForPrompt);
    if (!response.success) {
      await emitter.notify(`❌ Worker **${turn.next}** failed on resume: ${response.error}`);
      return emitter.transcript;
    }
    // Restore the blackboard captured at pause time so resumed step + future
    // pauses keep accumulating against the same shared state.
    const resumeBoard = TeamBlackboard.fromJSON(pending.blackboard);
    const resumeIngest = resumeBoard.ingest(turn.next, pending.step, response.output);
    response.output = resumeIngest.stripped;
    const ask = parseAskUser(response.output);
    const newParts = [...pending.partsSoFar, { step: pending.step, worker: turn.next, output: response.output, isRevision }];
    const newSeen = Array.from(new Set([...pending.seenWorkers, turn.next]));
    const newHistory = turn.summary_of_last
      ? [...seededHistory, { worker: pending.askingWorker, summary: turn.summary_of_last }]
      : seededHistory;
    if (ask) {
      this.persistPendingTeam(chatId, {
        mode: 'auto',
        teamName: pending.teamName,
        task: pending.task,
        teamTurnId: pending.teamTurnId,
        history: newHistory,
        lastWorker: turn.next,
        lastOutput: response.output,
        partsSoFar: newParts,
        seenWorkers: newSeen,
        step: pending.step + 1,
        askingWorker: turn.next,
        question: ask.question,
        options: ask.options,
        blackboard: resumeBoard.toJSON(),
        askedAt: Date.now(),
        workerAnchors: this.snapshotWorkerAnchors(teamConv),
      });
      const rendered3 = renderQuestion(turn.next, ask.preamble, ask.question, ask.options);
      await emitter.notify(rendered3.text, rendered3.choices);
      return emitter.transcript;
    }
    const closing = await runAdvisor(
      {
        task: pending.task,
        members: team.members.map(n => ({ name: n, hint: wm.getDispatchHint(n) })),
        history: newHistory,
        lastWorker: turn.next,
        lastOutput: response.output,
        finalize: true,
      },
      { agent: mAgent, model: mModel, runner: this.advisorRunner },
    );
    const finalSummary = closing.fallback ? '' : (closing.final_summary ?? '');
    const resumeBlock = resumeBoard.renderForUser();
    const resumeFormatted = this.formatAdvisorParts(newParts, finalSummary, 200);
    this.persistBlackboardDecisions(resumeBoard, pending.teamName);
    await emitter.notify(resumeBlock ? `${resumeFormatted}\n\n${resumeBlock}` : resumeFormatted);
    return emitter.transcript;
  }

  private async runAllMembersInOrder(
    emitter: TeamEmitter,
    chatId: string,
    convBase: string,
    teamName: string,
    members: string[],
    task: string,
    runOneWorker: (
      workerName: string,
      prompt: string,
      codingAgent: CodingAgent,
      modelConfig: ModelConfig | undefined,
      blackboard: TeamBlackboard,
      onThinking?: (text: string) => void,
    ) => Promise<{ success: boolean; output: string; error?: string; thinking?: string }>,
    opts: { startIndex?: number; startCarry?: string; priorResults?: string[]; blackboard?: TeamBlackboard; conversationId?: string; signal?: AbortSignal; fallbackAgent?: CodingAgent; fallbackModel?: ModelConfig; teamTurnId?: string } = {},
  ): Promise<{ thinkingByStep: Record<number, string> }> {
    const workerManager = this.workspaceManager.getWorkerManager();
    const results: string[] = opts.priorResults ? [...opts.priorResults] : [];
    let currentTask = opts.startCarry ?? task;
    const blackboard = opts.blackboard ?? new TeamBlackboard();
    const thinkingByStep: Record<number, string> = {};
    const teamConv = opts.conversationId
      ?? this.workerConversationId(convBase, { team: teamName });

    for (let i = opts.startIndex ?? 0; i < members.length; i++) {
      if (opts.signal?.aborted) break;
      const memberName = members[i];
      const worker = workerManager.getWorker(memberName);
      if (!worker) {
        results.push(`**${memberName}**: ❌ not found in global library`);
        break;
      }
      const codingAgent = (workerManager.getWorkerCodingAgent(memberName) ?? opts.fallbackAgent ?? this.getDefaultAgent()) as CodingAgent;
      const wmModel = workerManager.getWorkerModel(memberName);
      const modelConfig = wmModel ? this.getModelConfig(codingAgent, wmModel) : (opts.fallbackModel ?? this.getDefaultModelConfig(codingAgent));
      await emitter.status(`🔄 Worker **${worker.name}** is working...`);
      emitter.beginWorker?.({ step: i + 1, worker: worker.name });
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
        blackboard.renderForWorker(memberName),
      );
      const response = await runOneWorker(memberName, prompt, codingAgent, modelConfig, blackboard, (t) => emitter.onThinking(t, i + 1));
      if (!response.success) {
        results.push(`**${worker.name}**: ❌ Failed - ${response.error}`);
        emitter.endWorker?.('failed');
        break;
      }
      if (response.thinking) thinkingByStep[i + 1] = response.thinking;
      const ingested = blackboard.ingest(memberName, i + 1, response.output);
      const cleanOutput = ingested.stripped;
      const deltaSummary = blackboard.summarizeDelta(ingested.added);
      if (deltaSummary) {
        await emitter.status(deltaSummary);
      }
      const ask = parseAskUser(cleanOutput);
      if (ask) {
        const pending: PendingTeamState = {
          mode: 'sequential',
          teamName,
          task,
          teamTurnId: opts.teamTurnId || '',
          memberIndex: i,
          carry: currentTask,
          askingWorker: memberName,
          question: ask.question,
          options: ask.options,
          askedAt: Date.now(),
          blackboard: blackboard.toJSON(),
          workerAnchors: this.snapshotWorkerAnchors(teamConv),
        };
        this.persistPendingTeam(chatId, pending);
        const rendered4 = renderQuestion(worker.name, ask.preamble, ask.question, ask.options);
        await emitter.notify(rendered4.text, rendered4.choices);
        emitter.endWorker?.('askedUser');
        return { thinkingByStep };
      }
      results.push(`**${worker.name}**: ${cleanOutput}`);
      emitter.endWorker?.('done');
      currentTask = `Previous worker output:\n${cleanOutput}\n\nYour task: ${task}`;
    }

    const bbBlock = blackboard.renderForUser();
    const body = `📊 Team **${teamName}** results\n\n${results.join('\n\n')}`;
    await emitter.notify(bbBlock ? `${body}\n\n${bbBlock}` : body);
    this.persistBlackboardDecisions(blackboard, teamName);
    return { thinkingByStep };
  }

  /**
   * Build the judge edge descriptors for the given node. Shared by both graph
   * walk variants so they can't silently drift.
   */
  private buildJudgeEdges(
    graph: TeamGraph,
    nodeById: Map<string, TeamGraph['nodes'][number]>,
    nodeId: string,
    state: GraphRunState,
  ): JudgeInput['edges'] {
    const node = nodeById.get(nodeId);
    return eligibleEdges(graph, state, nodeId).map(e => ({
      id: e.id,
      condition: node?.type === 'condition' ? e.branch : e.condition,
      targetWorker: nodeById.get(e.to)?.type === 'end' ? '(end)' : (nodeById.get(e.to)?.worker ?? e.to),
    }));
  }

  /**
   * Assemble the JudgeInput, run the judge, and resolve the chosen edge. Shared
   * by both graph walk variants. Returns the raw decision (for the caller's
   * reason/fallback emit) plus the resolved edge (null if no match).
   */
  private async pickNextGraphEdge(
    graph: TeamGraph,
    nodeById: Map<string, TeamGraph['nodes'][number]>,
    currentNodeId: string,
    state: GraphRunState,
    task: string,
    workerName: string,
    workerOutput: string,
    blackboardSummary: string,
    signal?: AbortSignal,
  ): Promise<{ decision: JudgeDecision; edge: TeamGraphEdge | null }> {
    const edges = this.buildJudgeEdges(graph, nodeById, currentNodeId, state);
    const node = nodeById.get(currentNodeId);
    const { agent, model } = this.getAdvisorAgentAndModel();
    const decision = await runJudge(
      { task, worker: workerName, workerOutput, blackboardSummary, edges,
        question: node?.type === 'condition' ? node.condition : undefined },
      { agent, model, runner: this.advisorRunner, signal },
    );
    const edge = resolveEdge(graph, currentNodeId, decision.edgeId);
    return { decision, edge };
  }

  /**
   * Walk a Sequential team's flow graph, letting a judge LLM choose the next
   * edge after each worker. Mirrors runAllMembersInOrder but follows graph
   * topology (with loop-backs and a maxHops cap) instead of a linear list.
   * sendResponse/void variant used by runTeamTask. ([ASK_USER] pause/resume is
   * a separate task — here a worker's [ASK_USER] text is just treated as output.)
   */
  private async runSequentialGraphForChat(
    message: UserMessage,
    teamName: string,
    graph: TeamGraph,
    task: string,
    runOneWorker: (
      workerName: string,
      prompt: string,
      codingAgent: CodingAgent,
      modelConfig: ModelConfig | undefined,
      blackboard: TeamBlackboard,
    ) => Promise<{ success: boolean; output: string; error?: string }>,
    teamTurnId?: string,
  ): Promise<void> {
    const handler = this.handlers.get(message.channel);
    const emitter = new ChannelEmitter(
      (r) => this.sendResponse(r),
      handler?.streamText ? (t: string) => handler.streamText!(t) : undefined,
      message.chatId, message.channel,
    );
    const convBase = `${message.channel}-${message.chatId}`;
    const blackboard = new TeamBlackboard();
    const state = startRun(graph);
    if (state.status !== 'running') {
      await emitter.status(`⚠️ Team **${teamName}** flow could not start (${state.status}).`);
      return;
    }
    await emitter.status(`🧭 Running flow for team **${teamName}**\nTask: ${task.substring(0, 100)}${task.length > 100 ? '...' : ''}`);
    await this.continueGraphRun(emitter, message.chatId, convBase, teamName, teamTurnId || '', graph, task, state, blackboard, [], runOneWorker);
  }

  /**
   * Resumable body of runSequentialGraphForChat's flow walk. Runs the void/
   * sendResponse loop from `state` until the graph finishes (or pauses on an
   * [ASK_USER]), then emits the cap warning + final results block. Shared by the
   * fresh run and the `mode:'graph'` resume path so post-pause steps behave
   * identically. When `resume` is set, the FIRST worker's prompt is re-issued
   * with the user's answer injected (matching the sequential resume format).
   */
  private async continueGraphRun(
    emitter: TeamEmitter,
    chatId: string,
    convBase: string,
    teamName: string,
    teamTurnId: string,
    graph: TeamGraph,
    task: string,
    state: GraphRunState,
    blackboard: TeamBlackboard,
    results: string[],
    runOneWorker: (
      workerName: string,
      prompt: string,
      codingAgent: CodingAgent,
      modelConfig: ModelConfig | undefined,
      blackboard: TeamBlackboard,
    ) => Promise<{ success: boolean; output: string; error?: string }>,
    opts?: {
      signal?: AbortSignal;
      fallbackAgent?: CodingAgent;
      fallbackModel?: ModelConfig;
      resume?: { question: string; answer: string };
    },
  ): Promise<string> {
    const wm = this.workspaceManager.getWorkerManager();
    const nodeById = new Map(graph.nodes.map(n => [n.id, n]));
    let resumeInfo = opts?.resume;

    let lastWorkerOutput = '';
    let lastWorkerName = '';
    let stepIndex = 0;
    while (state.status === 'running') {
      if (opts?.signal?.aborted) break;
      const node = nodeById.get(state.currentNodeId)!;

      if (node.type === 'condition') {
        // Branch point: no worker runs. The judge picks among the diamond's
        // outgoing edges using the last worker's output for context.
        const { decision, edge } = await this.pickNextGraphEdge(
          graph, nodeById, state.currentNodeId, state, task, lastWorkerName,
          lastWorkerOutput, blackboard.renderForUser() || '',
        );
        if (!edge) {
          await emitter.status(`🏁 Flow stopped at a decision point (no matching branch).`);
          break;
        }
        await emitter.status(`↪️ ${decision.fallback ? '(default) ' : ''}${decision.reason || 'branch'}`);
        state = advance(graph, state, edge.id);
        continue;
      }

      // safe: team.graph is only set after validateGraph guarantees every worker node has a worker
      const workerName = node.worker!;
      const worker = wm.getWorker(workerName);
      if (!worker) { results.push(`**${workerName}**: ❌ not found`); emitter.endWorker?.('failed'); break; }

      const codingAgent = (wm.getWorkerCodingAgent(workerName) ?? opts?.fallbackAgent ?? this.getDefaultAgent()) as CodingAgent;
      const wmModel = wm.getWorkerModel(workerName);
      const modelConfig = wmModel
        ? this.getModelConfig(codingAgent, wmModel)
        : (opts?.fallbackModel ?? this.getDefaultModelConfig(codingAgent));
      await emitter.status(`🔄 Step ${++stepIndex}: **${worker.name}** is working...`);
      emitter.beginWorker?.({ step: stepIndex, worker: worker.name });

      const roster = graph.nodes
        .filter(n => n.type === 'worker' && n.worker)
        .map(n => ({ name: n.worker!, hint: wm.getDispatchHint(n.worker!) }));
      // On the first iteration of a resume, inject the user's answer into the
      // re-issued prompt for the worker that asked; subsequent steps use `task`.
      const promptTask = resumeInfo
        ? `${task}\n\n[User answer to your question "${resumeInfo.question}"]:\n${resumeInfo.answer}`
        : task;
      const prompt = wm.buildSequentialWorkerPrompt(
        workerName, promptTask, roster, null, blackboard.renderForWorker(workerName),
      );
      resumeInfo = undefined;
      const resp = await runOneWorker(workerName, prompt, codingAgent, modelConfig, blackboard);
      if (!resp.success) { results.push(`**${worker.name}**: ❌ Failed - ${resp.error}`); emitter.endWorker?.('failed'); break; }

      const ingested = blackboard.ingest(workerName, stepIndex, resp.output);
      results.push(`**${worker.name}**:\n${ingested.stripped}`);
      emitter.endWorker?.('done');
      lastWorkerOutput = ingested.stripped;
      lastWorkerName = workerName;

      // Pause if this worker asked the user a question.
      const ask = parseAskUser(ingested.stripped);
      if (ask) {
        const teamConv = this.workerConversationId(convBase, { team: teamName });
        this.persistPendingTeam(chatId, {
          mode: 'graph', teamName, task, teamTurnId,
          graphState: { currentNodeId: state.currentNodeId, hops: state.hops, visited: state.visited, runStreak: state.runStreak },
          results,
          askingWorker: workerName, question: ask.question, options: ask.options,
          askedAt: Date.now(), blackboard: blackboard.toJSON(),
          workerAnchors: this.snapshotWorkerAnchors(teamConv),
        });
        const askWorkerName = this.workspaceManager.getWorkerManager().getWorker(workerName)?.name ?? workerName;
        const rendered = renderQuestion(askWorkerName, ask.preamble, ask.question, ask.options);
        await emitter.notify(rendered.text, rendered.choices);
        emitter.endWorker?.('askedUser');
        return emitter.transcript;
      }

      // Count this completed (non-paused) run toward the worker's self-loop cap.
      state = { ...state, runStreak: state.runStreak + 1 };

      // Judge picks the next edge.
      const { decision, edge } = await this.pickNextGraphEdge(
        graph, nodeById, state.currentNodeId, state, task, workerName,
        ingested.stripped, blackboard.renderForUser() || '',
      );
      if (!edge) {
        await emitter.status(`🏁 Flow stopped at **${worker.name}** (no matching next step).`);
        break;
      }
      await emitter.status(`↪️ ${decision.fallback ? '(default) ' : ''}${decision.reason || 'next step'}`);
      state = advance(graph, state, edge.id);
    }

    if (state.status === 'capped') {
      await emitter.status(`⚠️ Flow hit the max-hops cap (${graph.maxHops}); reporting partial result.`);
    }
    const bbBlock = blackboard.renderForUser();
    const body = `📊 Team **${teamName}** flow results\n\n${results.join('\n\n')}`;
    await emitter.notify(bbBlock ? `${body}\n\n${bbBlock}` : body);
    this.persistBlackboardDecisions(blackboard, teamName);
    return emitter.transcript;
  }

  /**
   * Sink/return variant of runSequentialGraphForChat for runTeamForChat. Walks
   * the flow graph with a judge LLM, streaming progress through the chat sink
   * and returning the assembled transcript (mirrors runTeamForChat's linear
   * fallback contract). [ASK_USER] pause/resume is a separate task.
   */
  private async runSequentialGraphForChatSink(
    teamName: string,
    graph: TeamGraph,
    prompt: string,
    sink: ChatStreamSink,
    chatId: string,
    runOneWorker: (
      workerName: string,
      workerPrompt: string,
      codingAgent: CodingAgent,
      modelConfig: ModelConfig | undefined,
      blackboard: TeamBlackboard,
      onThinking?: (text: string) => void,
    ) => Promise<{ success: boolean; output: string; error?: string; thinking?: string }>,
    chatAgent?: CodingAgent,
    chatModel?: ModelConfig,
    signal?: AbortSignal,
    workerMsgs?: WorkerMessageEmitter,
    teamTurnId?: string,
  ): Promise<{ response: string; choices?: string[]; thinkingByStep?: Record<number, string> }> {
    const emitter = new ChatEmitter(sink, chatId, workerMsgs);
    const blackboard = new TeamBlackboard();
    const state = startRun(graph);
    if (state.status !== 'running') {
      await emitter.status(`⚠️ Team **${teamName}** flow could not start (${state.status}).`);
      return { response: emitter.transcript };
    }
    await emitter.status(`Running flow for team ${teamName}`);
    await this.continueGraphRun(emitter, chatId, `chat-${chatId}`, teamName, teamTurnId || '', graph, prompt, state, blackboard, [], runOneWorker,
      { signal, fallbackAgent: chatAgent, fallbackModel: chatModel });
    return { response: emitter.transcript, choices: emitter.choices };
  }

  private async runTeamForChat(
    teamName: string,
    team: TeamConfig,
    prompt: string,
    workingDir: string,
    sink: ChatStreamSink,
    chatId: string,
    chat: Chat,
    signal?: AbortSignal,
    opts: { forceAll?: boolean } = {},
    chatAgent?: CodingAgent,
    chatModel?: ModelConfig,
  ): Promise<{ response: string; tokens?: number; choices?: string[]; thinkingByStep?: Record<number, string>; teamTurnId?: string }> {
    if (!team || !team.members || team.members.length === 0) {
      throw new Error(`Team not found or empty: ${teamName}`);
    }

    const baseConv = `chat-${chat.id}`;
    const teamConv = this.workerConversationId(baseConv, { team: teamName });

    const teamTurnId = randomUUID();
    const useAdvisorMode = team.dispatch === 'auto' && !opts.forceAll;
    const teamMode: 'sequential' | 'graph' | 'auto' | 'parallel' =
      useAdvisorMode
        ? 'auto'
        : (!opts.forceAll && team.graph)
          ? 'graph'
          : team.dispatch === 'parallel'
            ? 'parallel'
            : 'sequential';
    const workerMsgs = new WorkerMessageEmitter(
      sink, this.chatManager, chatId,
      { teamTurnId, teamName, mode: teamMode },
    );

    const runOneWorker = async (
      workerName: string,
      workerPrompt: string,
      codingAgent: CodingAgent,
      modelConfig: ModelConfig | undefined,
      blackboard: TeamBlackboard,
      onThinking?: (text: string) => void,
    ): Promise<{ success: boolean; output: string; error?: string; thinking?: string }> => {
      const { response } = await this.runWorkerStep({
        conversationId: teamConv,
        workerName,
        task: prompt,
        blackboard,
        codingAgent,
        modelConfig,
        buildBootstrapPrompt: () => this.wrapPromptWithMemory(workerPrompt, prompt, workerName),
        onStream: (text: string) => workerMsgs.onStream(text),
        onThinking,
        onStatus: (update: any) => {
          // Forward each worker's tool events to the chat so the run-flow view
          // can attribute them per worker (team runs here are serial; the Mac
          // side buckets each call under the most-recent "Step N" marker).
          // Mirrors the single-agent onStatus; step narration stays on
          // emitter.status. (Parallel path below is left untouched — its tool
          // events interleave and can't be attributed by order.)
          try {
            const parsed = typeof update === 'string' ? JSON.parse(update) : update;
            if (parsed?.type === 'tool_start') {
              workerMsgs.onTool({ type: 'tool_start', tool: parsed.tool, message: parsed.message ?? '', input: parsed.input });
            } else if (parsed?.type === 'tool_end') {
              workerMsgs.onTool({ type: 'tool_end', tool: parsed.tool, message: parsed.message ?? '', output: parsed.output });
            }
          } catch { /* non-JSON status */ }
        },
        signal,
        workingDir,
      });
      if (response) this.extractWorkerMemories(workerName, prompt, codingAgent, response);
      return response?.success
        ? { success: true, output: this.formatAgentResponse(response), thinking: response.thinking || undefined }
        : { success: false, output: '', error: response?.error };
    };

    const useAdvisor = team.dispatch === 'auto' && !opts.forceAll;

    // === parallel dispatch branch ===
    // Check if user is answering a pending question from a paused parallel discussion
    if (this.parallelResumes.has(chat.id)) {
      const resume = this.parallelResumes.get(chat.id)!;
      this.parallelResumes.delete(chat.id);
      await resume(prompt);
      return { response: '' };
    }

    this.logger.info(`[parallel-debug] runTeamForChat: dispatch=${team.dispatch} parallel=${JSON.stringify(team.parallel)} members=${team.members.join(',')}`);
    if (team.dispatch === 'parallel') {
      this.logger.info(`[parallel-debug] entering parallel branch`);
      const workspacesRoot = this.workspaceManager.getWorkspacesRoot();
      // Resume detection: if this chat has a completed/terminated discussion,
      // re-activate it instead of starting fresh. initDiscussionDir will
      // append a Continuation header to topic.md and reset control.md.
      if (chat.discussion && (chat.discussion.status === 'done' || chat.discussion.status === 'terminated')) {
        await initDiscussionDir(workspacesRoot, chat.workspaceName, chat.id, prompt, team.members);
      }
      if (!team.parallel) {
        // defensive — normalizer always populates this for parallel teams
        await sink({ type: 'stream', chatId, token: '⚠️ parallel team is missing settings' });
        return { response: '' };
      }
      // Pre-create one stub message per worker so streaming events are routed
      // per-worker. Serial modes use beginWorker; parallel pre-creates them all.
      workerMsgs.teamStart(team.members.map((w, i) => ({ step: i + 1, worker: w })));
      const workerStep = new Map<string, number>(team.members.map((w, i) => [w, i + 1]));

      const runner = new ParallelTeamRunner({
        workspacesRoot,
        workspace: chat.workspaceName,
        chatId: chat.id,
        teamName: teamName,
        members: team.members,
        topic: prompt,
        settings: team.parallel,
        workerRunner: async (req, workerName) => this.runWithFallback(chatAgent ?? this.getDefaultAgent() as CodingAgent, {
          prompt: req.prompt,
          agent: chatAgent ?? this.getDefaultAgent() as CodingAgent,
          model: chatModel ?? this.getDefaultModelConfig(chatAgent ?? this.getDefaultAgent() as CodingAgent),
          context: { workingDir },
          onStream: (text: string) => workerMsgs.onStream(text, workerName),
          onThinking: (text: string) => workerMsgs.onThinking(text, workerStep.get(workerName) ?? 0, workerName),
          onStatus: (update: any) => {
            // Route per-worker tool events through workerMsgs for parallel mode,
            // matching the serial-mode routing in runOneWorker.
            try {
              const parsed = typeof update === 'string' ? JSON.parse(update) : update;
              if (parsed?.type === 'tool_start') {
                workerMsgs.onTool({ type: 'tool_start', tool: parsed.tool, message: parsed.message ?? '', input: parsed.input }, workerName);
              } else if (parsed?.type === 'tool_end') {
                workerMsgs.onTool({ type: 'tool_end', tool: parsed.tool, message: parsed.message ?? '', output: parsed.output }, workerName);
              }
            } catch { /* non-JSON status */ }
          },
          signal: req.signal,
        }),
        advisorRunner: async req => {
          const { agent: mAgent, model: mModel } = this.getAdvisorAgentAndModel();
          const advisorResult = await this.runWithFallback(mAgent, {
            prompt: req.prompt,
            agent: mAgent,
            model: mModel,
            context: { workingDir },
            onStream: () => {},
            onThinking: () => {},
            onStatus: () => {},
            signal: req.signal,
          });
          return advisorResult;
        },
        buildWorkerPrompt: (workerName: string) => {
          const wm = this.workspaceManager.getWorkerManager();
          return wm.buildParallelWorkerPrompt(workerName, {
            topic: prompt,
            controlPath: controlPath(workspacesRoot, chat.workspaceName, chat.id),
            summaryPath: summaryPath(workspacesRoot, chat.workspaceName, chat.id),
            ownOpinionPath: opinionPath(workspacesRoot, chat.workspaceName, chat.id, workerName),
            peerOpinions: team.members
              .filter(m => m !== workerName)
              .map(m => ({ name: m, path: opinionPath(workspacesRoot, chat.workspaceName, chat.id, m) })),
          });
        },
        onUserQuestion: q => {
          this.parallelResumes.set(chat.id, q.resume);
          const rendered = renderQuestion('Advisor', '', q.question, q.choices);
          sink({ type: 'stream', chatId, token: rendered.text });
        },
        onFinal: ev => {
          this.parallelResumes.delete(chat.id);
          this.activeParallelRuns.delete(chat.id);
          const c = this.chatManager.get(chat.id);
          if (c) {
            c.discussion = { teamName, status: 'done', startedAt: c.discussion?.startedAt ?? Date.now(), terminatedReason: ev.reason };
            (c as any).updatedAt = Date.now();
          }
          this.persistDiscussionSummary(teamName, prompt, ev);
          void sink({ type: 'stream', chatId, token: this.formatParallelFinal(ev, teamName) });
        },
        onWorkerDone: (worker, ok) => workerMsgs.endWorker(ok ? 'done' : 'failed', undefined, worker),
      });
      const c0 = this.chatManager.get(chat.id);
      if (c0) {
        c0.discussion = { teamName, status: 'running', startedAt: Date.now() };
        (c0 as any).updatedAt = Date.now();
      }
      this.activeParallelRuns.set(chat.id, runner);
      let finalResponse = '';
      const origOnFinal = runner['opts'].onFinal;
      runner['opts'].onFinal = (ev: ParallelFinalEvent) => {
        finalResponse = this.formatParallelFinal(ev, teamName);
        origOnFinal(ev);
      };
      await runner.start();
      await runner.waitDone();
      return { response: finalResponse, teamTurnId };
    }
    // === end parallel dispatch branch ===

    if (useAdvisor) {
      const result = await this.runAdvisorLoop(
        team,
        prompt,
        signal,
        chatAgent,
        chatModel,
        (msg) => {
          if (msg.kind === 'route') {
            sink({
              type: 'info',
              chatId,
              message: `Step ${msg.step}: ${msg.worker}${msg.isRevision ? ' (revision)' : ''} — ${msg.reason}`,
            });
            // Each worker streams its full output into its own per-worker bubble
            // (beginWorker below). Don't also echo a "### Step N" header into the
            // turn's main message — that produced a second, redundant copy of the
            // whole run in a different format.
            workerMsgs.beginWorker({ step: msg.step, worker: msg.worker, reason: msg.reason });
          } else {
            sink({ type: 'info', chatId, message: msg.summary });
          }
        },
        runOneWorker,
        (d) => workerMsgs.endWorker(d.failed ? 'failed' : 'done'),
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
          teamTurnId,
          history: p.history,
          lastWorker: p.lastWorker,
          lastOutput: p.lastOutput,
          partsSoFar: p.parts,
          seenWorkers: p.seenWorkers,
          step: p.step,
          askingWorker: p.askingWorker,
          question: p.question,
          options: p.options,
          blackboard: result.blackboard.toJSON(),
          askedAt: Date.now(),
          workerAnchors: this.snapshotWorkerAnchors(teamConv),
        });
        const rendered5 = renderQuestion(askWorkerName, '', p.question, p.options);
        sink({ type: 'stream', chatId, token: rendered5.text });
        return { response: rendered5.text, choices: rendered5.choices, teamTurnId };
      } else {
        // Per-worker bubbles already render each step's full output, so the
        // turn's main message is just the Advisor's wrap-up summary (a short
        // recap when the run produced a lot of detail) plus the blackboard —
        // not a second copy of every step.
        const summary = result.finalSummary?.trim()
          ? `🧭 Advisor summary: ${result.finalSummary.trim()}`
          : '';
        if (signal?.aborted) {
          return { response: summary, teamTurnId };
        }
        if (result.fallbackMidRun) {
          sink({ type: 'info', chatId, message: `Advisor halted mid-run: ${result.fallbackMidRun.reason}` });
        }
        const bbBlock = result.blackboard.renderForUser();
        this.persistBlackboardDecisions(result.blackboard, teamName);
        const response = [summary, bbBlock].filter(Boolean).join('\n\n');
        return { response, thinkingByStep: result.thinkingByStep, teamTurnId };
      }
    }

    // dispatch === 'all', forceAll, or auto-routing fallback
    if (!opts.forceAll && team.graph) {
      const g = await this.runSequentialGraphForChatSink(teamName, team.graph, prompt, sink, chatId, runOneWorker, chatAgent, chatModel, signal, workerMsgs, teamTurnId);
      return { ...g, teamTurnId };
    }
    const emitter = new ChatEmitter(sink, chatId, workerMsgs);
    const r = await this.runAllMembersInOrder(emitter, chatId, baseConv, teamName, team.members, prompt, runOneWorker,
      { signal, fallbackAgent: chatAgent, fallbackModel: chatModel, teamTurnId });
    return { response: emitter.transcript, choices: emitter.choices, thinkingByStep: r.thinkingByStep, teamTurnId };
  }

  private formatUptime(seconds: number): string {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    return `${h}h ${m}m ${s}s`;
  }

  private formatParallelFinal(ev: ParallelFinalEvent, team: string): string {
    const summaryBody = ev.summary.replace(/^#\s+Summary\s*/i, '').trim();
    return [
      `🪑 Roundtable: **${team}**`,
      `Termination reason: ${ev.reason}`,
      '',
      '## Advisor Summary',
      summaryBody || '(empty)',
      '',
      '## Viewpoints',
      ...ev.perWorker.map(p => `**${p.name}**: ${p.excerpt || '(empty)'}`),
      '',
      ev.message,
    ].join('\n');
  }

  private parseCommand(text: string): ParsedCommand {
    // First check for commands
    const commandMatch = text.match(/^\/(\w+)(?:\s+(.*))?$/);
    
    if (commandMatch) {
      const command = commandMatch[1].toLowerCase();
      const argsStr = commandMatch[2] || '';
      const args = argsStr.split(/\s+/).filter(Boolean);
      
      // /skill forget|restore|rollback <name>
      const skillSubMatch = text.match(/^\/skill\s+(forget|restore|rollback|history)\s+(\S+)/i);
      if (skillSubMatch) {
        return {
          command: `skill-${skillSubMatch[1].toLowerCase()}`,
          args: [skillSubMatch[2]],
          agent: this.getDefaultAgent() as CodingAgent,
          model: undefined,
          prompt: '',
        };
      }

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

    // User-initiated abort — do NOT churn through every fallback agent,
    // spawning subprocesses the user just asked to cancel.
    if (request.signal?.aborted) return response;

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
      let resolvedModel: ModelConfig | undefined;
      try {
        resolvedModel = this.resolveFallbackModel(entry);
      } catch (err) {
        // getModelConfig may throw for misconfigured catalog entries (no API
        // bound, apiType mismatch). Don't let one bad fallback entry abort
        // the whole chain — log it and try the next.
        this.logger.warn(`Skipping fallback ${entry.agent}${entry.model ? `(${entry.model})` : ''}: ${(err as Error).message}`);
        continue;
      }
      if (!resolvedModel) {
        this.logger.warn(`Skipping fallback ${entry.agent}${entry.model ? `(${entry.model})` : ''}: no usable model config`);
        continue;
      }
      const key = `${entry.agent}::${resolvedModel.model}`;
      if (seen.has(key)) continue;
      seen.add(key);

      // Bail out mid-loop if the user aborted while a fallback was running.
      if (request.signal?.aborted) return response;

      const label = `${entry.agent}(${resolvedModel.model})`;
      this.logger.warn(`Agent ${agent} failed, trying ${label}...`);
      const fallbackResponse = await this.agentFactory.run(entry.agent, {
        ...request,
        agent: entry.agent,
        model: resolvedModel,
      });
      if (fallbackResponse.success) {
        const fromLabel = originalModel ? `${agent}(${originalModel})` : agent;
        // Carry the fallback as structured metadata rather than prepending a
        // banner to the output text. The Aide reuses this same fallback-routed
        // runner for housekeeping (title/summary/JSON), and a text banner would
        // leak into those — e.g. a chat title becoming "[Fallback: …]".
        fallbackResponse.fallback = { from: fromLabel, to: label };
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
    // 1. Check the global model catalog. Credentials live on the referenced
    //    ApiKeyEntry, not on the model itself — walk apiKeyRef to load them.
    //    apiKeyRef is optional; when unset, the adapter falls back to its
    //    default environment variables (ANTHROPIC_API_KEY / OPENAI_API_KEY).
    const catalogEntry = this.configManager?.getModel(modelName);
    if (catalogEntry) {
      const apiKey = catalogEntry.apiKeyRef
        ? this.configManager?.getApiKey(catalogEntry.apiKeyRef)
        : undefined;
      // apiKeyRef set but the referenced key is gone: surface the broken
      // binding so the user can fix it instead of silently falling back.
      if (catalogEntry.apiKeyRef && !apiKey) {
        throw new Error(
          `Model "${catalogEntry.model}" references API key "${catalogEntry.apiKeyRef}" which no longer exists. Open Settings → API Keys to add it, or rebind the model.`
        );
      }
      const baseUrl = apiKey
        ? (catalogEntry.apiType === 'anthropic' ? apiKey.anthropicBaseUrl : apiKey.openaiBaseUrl)
        : undefined;
      return {
        provider: catalogEntry.provider ?? (catalogEntry.apiType === 'anthropic' ? 'anthropic' : 'openai'),
        model: catalogEntry.model,
        apiKey: apiKey?.apiKey,
        baseUrl,
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

    // Build memory context — merges user-global + workspace stores.
    const memoryStore = this.workspaceManager.getMemoryStore();
    const memoryContext = this.buildMergedMemoryContext(prompt) || undefined;

    const onStream = sse ? (text: string) => sse('stream', text) : undefined;
    const onStatus = sse ? (update: any) => sse('status', update) : undefined;

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
      ...(httpAsk?.options && httpAsk.options.length >= 2 ? { choices: httpAsk.options } : {}),
    };
  }

  /**
   * Run an ephemeral, read-only Quick Question turn against a chat's context.
   * Does NOT append to the chat, set a session anchor, persist, or mirror to
   * channels. Streams via the provided sink. Uses the Aide agent/model when
   * configured, otherwise the chat's effective agent/model.
   */
  async runQuickQuestion(
    chatId: string,
    question: string,
    qqHistory: QQHistoryEntry[],
    sink: (e: QQStreamEvent) => void,
    attachments?: import('@codey/core').FileAttachment[],
  ): Promise<{ response: string; tokens?: number; durationSec?: number }> {
    const chat = this.chatManager.get(chatId);
    if (!chat) throw new Error(`Chat not found: ${chatId}`);

    // Resolve workingDir from the chat's workspace.json (mirrors sendToChat).
    const workspacesRoot = this.workspaceManager.getWorkspacesRoot();
    const wsConfigPath = path.join(workspacesRoot, chat.workspaceName, 'workspace.json');
    let workingDir = this.workingDir;
    if (fs.existsSync(wsConfigPath)) {
      try {
        const wsConfig = JSON.parse(fs.readFileSync(wsConfigPath, 'utf-8'));
        if (wsConfig.workingDir) workingDir = wsConfig.workingDir;
      } catch { /* use default */ }
    } else {
      const msg = `Workspace not found: ${chat.workspaceName}`;
      sink({ type: 'error', chatId, message: msg });
      throw new Error(msg);
    }

    // Aide agent/model if configured, else the chat's effective agent/model.
    const aideCfg = this.config.aide;
    let agent: CodingAgent;
    let model: ModelConfig | undefined;
    try {
      if (aideCfg?.agent || aideCfg?.model) {
        ({ agent, model } = this.getAideAgentAndModel());
      } else {
        agent = (chat.agent ?? this.getDefaultAgent()) as CodingAgent;
        model = chat.model
          ? this.getModelConfig(agent, chat.model)
          : this.getDefaultModelConfig(agent);
      }
    } catch (err) {
      const msg = (err as Error).message;
      sink({ type: 'error', chatId, message: msg });
      throw err;
    }

    // One in-flight QQ per chat: abort any prior run for this chat.
    this.qqAborts.get(chatId)?.abort();
    const abortController = new AbortController();
    this.qqAborts.set(chatId, abortController);

    const started = Date.now();
    const prompt = buildQuickQuestionPrompt(chat, qqHistory, question, attachments);

    let streamedText = '';
    const onStream = (text: string) => {
      streamedText += text;
      sink({ type: 'stream', chatId, token: text });
    };
    const onStatus = (update: any) => {
      try {
        const parsed = typeof update === 'string' ? JSON.parse(update) : update;
        if (parsed?.message) sink({ type: 'tool', chatId, message: String(parsed.message) });
      } catch { /* non-JSON status */ }
    };

    try {
      const response = await this.runWithFallback(agent, {
        prompt,
        agent,
        model,
        context: { workingDir },
        skipPermissions: true,
        allowedTools: READ_ONLY_TOOLS,
        onStream,
        onStatus,
        signal: abortController.signal,
      });

      if (abortController.signal.aborted) {
        sink({ type: 'stopped', chatId });
        return { response: streamedText };
      }

      const output = response?.success ? this.formatAgentResponse(response) : (streamedText || '');
      const tokens = (response as any)?.tokens?.total;
      const durationSec = Math.round((Date.now() - started) / 1000);

      if (!response?.success && !output) {
        const msg = (response as any)?.error || 'Quick Question failed';
        sink({ type: 'error', chatId, message: String(msg) });
        return { response: '' };
      }

      sink({ type: 'done', chatId, response: output, tokens, durationSec });
      return { response: output, tokens, durationSec };
    } catch (err) {
      if (abortController.signal.aborted) {
        sink({ type: 'stopped', chatId });
        return { response: streamedText };
      }
      const msg = (err as Error).message;
      sink({ type: 'error', chatId, message: msg });
      throw err;
    } finally {
      if (this.qqAborts.get(chatId) === abortController) {
        this.qqAborts.delete(chatId);
      }
    }
  }

  /** Cancel an in-flight Quick Question run for a chat. Returns true if one was aborted. */
  stopQuickQuestion(chatId: string): boolean {
    const ac = this.qqAborts.get(chatId);
    if (!ac) return false;
    ac.abort();
    return true;
  }

  async sendToChat(
    chatId: string,
    userTextParam: string,
    sinkParam: ChatStreamSink,
    attachments?: import('@codey/core').FileAttachment[],
    // Origin identifies which surface initiated this turn so the chat-mirror
    // fan-out at the end of the turn can skip the originating route. Default
    // is Mac (no route matches '__mac__'), so all attached channels receive
    // the mirror. Channel-side callers must pass the real channel+userId so
    // we don't echo the message back to the user who typed it.
    // `skillInvoke` is an explicit `/skill <name> <task>` invocation threaded
    // per-turn from the channel surface (Task 12: apply it in this method's
    // skill pre-run pass, taking precedence over the auto-apply matcher).
    origin?: { channel: ChannelType; channelUserId: string; skillInvoke?: SkillInvoke },
  ): Promise<{ response: string; chatId: string; tokens?: number; durationSec?: number }> {
    const chat = this.chatManager.get(chatId);
    if (!chat) throw new Error(`Chat not found: ${chatId}`);

    // Resolvable copy of the incoming text. A digit reply to a paused team is
    // rewritten to the chosen option's text BEFORE it is persisted as the user
    // message and handed to the resume path.
    let userText = userTextParam;

    // Detect a paused team and decide how this turn relates to it. A slash turn
    // cancels the paused run and proceeds normally; otherwise this turn is an
    // answer to the team's question, so map any digit reply to the option text.
    const pendingTeam = chat.pendingTeam;
    const isSlashTurn = userText.trimStart().startsWith('/');
    if (pendingTeam) {
      if (isSlashTurn) {
        this.chatManager.setPendingTeam(chatId, null);
      } else if (pendingTeam.options && pendingTeam.options.length > 0) {
        const resolved = resolveChoiceDigit(userText, pendingTeam.options);
        if (resolved !== null) userText = resolved;
      }
    }

    // Persisted alongside the assistant message at completion. Declared here
    // so the sink wrapper can capture 'info' events into it (see below).
    const toolCalls: ToolCallEntry[] = [];

    // Tee every sink event to the registered global listener so other surfaces
    // (e.g., the Mac app) see channel-driven chat updates too. Also capture
    // 'info' events into the persisted toolCalls array so the right Context
    // Panel still shows advisor routing reasons after a chat reload (info
    // events come from team-mode orchestration via direct sink calls and
    // never go through onStatus, so they would otherwise vanish on persist).
    const sink: ChatStreamSink = (ev) => {
      if (ev.type === 'info') {
        toolCalls.push({ id: randomUUID(), type: 'info', message: ev.message });
      }
      try { sinkParam(ev); } catch { /* swallow */ }
      if (this.chatEventListener) {
        try { this.chatEventListener(ev); } catch { /* swallow */ }
      }
    };

    // Short-circuit helper for skill-related conversational replies that never
    // reach an agent: persist both sides of the exchange, announce completion,
    // and return. Runs BEFORE the semaphore acquire, so there is nothing to
    // release (mirrors how the workspace-not-found path only releases because
    // it acquired first).
    const finishSkillReply = (responseText: string): { response: string; chatId: string } => {
      const now = Date.now();
      this.chatManager.appendMessage(chatId, {
        id: randomUUID(), role: 'user', content: userTextParam, timestamp: now, isComplete: true,
      });
      this.chatManager.appendMessage(chatId, {
        id: randomUUID(), role: 'assistant', content: responseText, timestamp: now, isComplete: true,
      });
      sink({ type: 'done', chatId, response: responseText });
      return { response: responseText, chatId };
    };

    // ── Pending skill suggestion (yes / no / rename <name>) ─────────
    // Resolved here because Mac turns never pass through handleMessage.
    // A paused team's question takes precedence: when pendingTeam is set this
    // turn is the user's answer to the team, so leave the suggestion persisted
    // untouched — it can still be answered after the team resumes/finishes.
    if (chat.pendingSkillSuggestion && !isSlashTurn && !pendingTeam) {
      const s = chat.pendingSkillSuggestion;
      const reply = userText.trim().toLowerCase();
      const renameMatch = reply.match(/^rename\s+([a-z][a-z0-9-]{2,29})$/);
      if (reply === 'yes' || reply === 'no' || renameMatch) {
        const store = this.workspaceManager.getSkillStore();
        let responseText: string;
        if (reply === 'no') {
          store.rejectSuggestion(s.name, s.description);
          responseText = `Got it — I won't suggest "${s.name}" again.`;
        } else {
          const name = renameMatch ? renameMatch[1] : s.name;
          store.add({ name, description: s.description, whenToUse: s.whenToUse,
                      steps: s.steps, sourceRunId: 'user-confirmed' });
          responseText = `✅ Skill **${name}** saved. It will be auto-applied on matching tasks.`;
        }
        this.chatManager.setPendingSkillSuggestion(chatId, null);
        return finishSkillReply(responseText);
      }
      // Any other reply: drop the suggestion and continue as a normal turn.
      this.chatManager.setPendingSkillSuggestion(chatId, null);
    }

    // ── Explicit skill invocation ───────────────────────────────────
    // Channel-origin turns arrive pre-resolved on origin.skillInvoke (parsed
    // and validated by handleMessage); Mac-origin turns parse `/skill <name>
    // <task>` here. Either way userText is rewritten to the RAW task so the
    // persisted user message and downstream bootstrap see the clean text —
    // the banner is applied exactly once at prompt build (see below).
    let appliedChatSkill: SkillEntry | null = null;
    let chatSkillTask: string | null = null;
    if (origin?.skillInvoke) {
      appliedChatSkill = origin.skillInvoke.skill;
      chatSkillTask = origin.skillInvoke.task;
    } else {
      const invokeMatch = userText.match(/^\/skill\s+(?!forget\b|restore\b|rollback\b|history\b)(\S+)\s+([\s\S]+)/i);
      if (invokeMatch) {
        if (!this.configManager?.getSkillsConfig()?.enabled) {
          return finishSkillReply('Skills are disabled.');
        }
        const name = invokeMatch[1].toLowerCase();
        const skill = this.workspaceManager.getSkillStore().getActive()
          .find(sk => sk.name === name);
        if (!skill) {
          return finishSkillReply(`Skill "${name}" not found. Ask me to /skills to see active skills.`);
        }
        appliedChatSkill = skill;
        chatSkillTask = invokeMatch[2].trim();
      }
    }
    if (appliedChatSkill && chatSkillTask !== null) {
      userText = chatSkillTask;
    }

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
    let chatWorkspaceTeamNames: string[] = [];
    // The global team library, looked up against the workspace's enabled names below.
    const globalTeams: Record<string, TeamConfigRaw> = this.configManager?.getTeams() ?? {};
    if (fs.existsSync(wsConfigPath)) {
      try {
        const wsConfig = JSON.parse(fs.readFileSync(wsConfigPath, 'utf-8'));
        if (wsConfig.workingDir) workingDir = wsConfig.workingDir;
        if (Array.isArray(wsConfig.teams)) {
          chatWorkspaceTeamNames = wsConfig.teams.filter((n: any) => typeof n === 'string');
        } else if (wsConfig.teams && typeof wsConfig.teams === 'object') {
          // Legacy: workspace held its own definitions. Treat keys as the enabled names.
          chatWorkspaceTeamNames = Object.keys(wsConfig.teams);
        }
      } catch { /* use default */ }
    } else {
      this.chatSemaphore.release();
      const msg = `Workspace not found: ${chat.workspaceName}`;
      sink({ type: 'error', chatId, message: msg });
      throw new Error(msg);
    }

    // Per-chat worktree binding: an explicit workingDirOverride wins over the
    // workspace's workingDir so the agent actually runs in the bound worktree
    // (mirrors resolveChatWorkingDir's precedence).
    if (chat.workingDirOverride) {
      if (fs.existsSync(chat.workingDirOverride)) workingDir = chat.workingDirOverride;
      else this.logger.warn(`Chat ${chat.id} workingDirOverride=${chat.workingDirOverride} is gone; falling back to workspace dir`);
    }

    // Per-chat override takes precedence over the gateway default.
    const agent = (chat.agent ?? this.getDefaultAgent()) as CodingAgent;
    let model: ModelConfig | undefined;
    try {
      model = chat.model
        ? this.getModelConfig(agent, chat.model)
        : this.getDefaultModelConfig(agent);
    } catch (err) {
      // getModelConfig throws when a model's apiKeyRef references a missing key
      // or an apiType mismatch — surface that as a chat error rather than leaking the semaphore.
      this.chatSemaphore.release();
      const msg = (err as Error).message;
      sink({ type: 'error', chatId, message: msg });
      throw err;
    }

    // Decide whether this turn resumes a warm CLI session or bootstraps a
    // new one. Resume mode skips the full history dump and uses the agent's
    // own session memory. Bootstrap mode sends a one-shot "prior conversation"
    // block. Team mode always uses the legacy bootstrap path (no session
    // resume) because team dispatch builds worker prompts internally.
    const selPrefix = assistantPrefixForSelection(chat);
    const canResume = chat.selection.type !== 'team';
    const warmAnchor = canResume && chat.sessionAnchor && chat.sessionAnchor.agent === agent
      ? chat.sessionAnchor
      : undefined;

    let prompt: string;
    let resumeSessionId: string | undefined;
    let newSessionId: string | undefined;
    if (warmAnchor) {
      // Resume turn: send only the new user text (+ attachments).
      prompt = selPrefix + buildChatResumePrompt(userText, attachments);
      resumeSessionId = warmAnchor.sessionId;
    } else {
      // Bootstrap turn: include prior history once. For claude-code, pre-allocate
      // a session id so we can resume on the next turn without parsing CLI output.
      prompt = selPrefix + buildChatBootstrapPrompt(chat, userText, attachments);
      if (canResume && agent === 'claude-code') {
        newSessionId = randomUUID();
      }
    }

    // Solo advisor: when enabled (and not a team), tell the agent how to escalate.
    if (chat.soloAdvisor && chat.selection.type !== 'team') {
      prompt = prompt + '\n\n' + SOLO_ADVISOR_INSTRUCTION;
    }

    // ── Skill application (pre-run) ─────────────────────────────────
    // Explicit invoke wins outright (banner applied once, no matching);
    // otherwise auto-apply matches against active skills — solo chats only.
    const skillsCfg = this.configManager?.getSkillsConfig();
    if (appliedChatSkill) {
      prompt = applySkill(prompt, appliedChatSkill);
      this.logger.info(`[skills] explicit invoke (chat): ${appliedChatSkill.name} v${appliedChatSkill.version}`);
    } else if (skillsCfg?.enabled && skillsCfg.autoApply
        && chat.selection.type !== 'team' && !isSlashTurn) {
      const match = matchSkill(userText, this.workspaceManager.getSkillStore().getActive());
      if (match) {
        const confirmed = match.confidence === 'high'
          || await confirmMatch(this.getSkillDistillDeps(), userText, match.skill);
        if (confirmed) {
          appliedChatSkill = match.skill;
          prompt = applySkill(prompt, match.skill);
          this.logger.info(`[skills] auto-applied (chat): ${match.skill.name} v${match.skill.version} (${match.confidence})`);
        }
      }
    }

    const userMessage: ChatMessage = {
      id: randomUUID(),
      role: 'user',
      content: userText,
      timestamp: started,
      isComplete: true,
      attachments: attachments && attachments.length > 0 ? attachments : undefined,
    };
    const afterUser = this.chatManager.appendMessage(chatId, userMessage);

    // On the very first message, derive a real title via the Aide instead of
    // blindly truncating the prompt. Kick it off now so it runs concurrently
    // with the agent turn; we await it just before the 'done' event. The
    // truncated title set by appendMessage stays visible until then, and acts
    // as the fallback if the Aide fails or returns nothing.
    const titlePromise: Promise<string> | undefined =
      afterUser.messages.length === 1 && this.isAideConfigured()
        ? this.generateChatTitleSafe(userText)
        : undefined;

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
      let teamChoices: string[] | undefined;
      let teamThinkingByStep: Record<number, string> | undefined;
      let teamTurnId: string | undefined;
      let agentUserQuestion: AgentResponse['userQuestion'];
      let singleAgentResponse: AgentResponse | null | undefined;
      if (pendingTeam && !isSlashTurn) {
        // This turn answers a paused team's question. Resume regardless of the
        // chat's current selection — a paused team can outlive a selection change.
        // The resume reuses the assistant-persist + 'done' + semaphore-release
        // lifecycle below (a re-pause sets pendingTeam again and surfaces new
        // choices through emitter.choices → teamChoices).
        this.chatManager.setPendingTeam(chatId, null);
        teamTurnId = pendingTeam.teamTurnId;
        const workerMsgs = new WorkerMessageEmitter(
          sink, this.chatManager, chatId,
          { teamTurnId: teamTurnId!, teamName: pendingTeam.teamName, mode: pendingTeam.mode === 'graph' ? 'graph' : pendingTeam.mode },
        );
        // Patch the asking worker's message from askedUser → done so the Mac
        // UI can release the pause UI and show the worker as completed.
        const resumeChat = this.chatManager.get(chatId);
        if (resumeChat) {
          const askingMsg = resumeChat.messages.filter(m => m.teamTurnId === teamTurnId && m.worker === pendingTeam.askingWorker).pop();
          if (askingMsg) {
            this.chatManager.updateMessage(chatId, askingMsg.id, { workerStatus: 'done' });
          }
        }
        const emitter = new ChatEmitter(sink, chatId, workerMsgs);
        output = await this.resumeTeamFromAnswer(chatId, `chat-${chatId}`, pendingTeam, userText, emitter);
        teamChoices = emitter.choices;
      } else if (chat.selection.type === 'team') {
        // Resolve the team from the chat's workspace.json (read above), not from
        // the active workspace, so a chat in workspace B uses B's team config
        // even if WorkspaceManager has loaded A. Worker prompt bodies still come
        // from WorkerManager's loaded workers/ dir (a known limitation when the
        // active workspace differs from the chat's).
        // Only count enabled names that actually resolve in the global library.
        const teamNames = chatWorkspaceTeamNames.filter(n => globalTeams[n] !== undefined);
        if (teamNames.length === 0) throw new Error(`No teams configured in workspace "${chat.workspaceName}"`);
        // Prefer the team named on the selection. Falling through to teamNames[0]
        // keeps legacy chats (persisted before per-team selection) working.
        const teamName = chat.selection.name && teamNames.includes(chat.selection.name)
          ? chat.selection.name
          : teamNames[0];
        const rawTeam = globalTeams[teamName];
        const rawMembers: string[] = Array.isArray(rawTeam) ? rawTeam : (rawTeam?.members ?? []);
        if (!rawMembers || rawMembers.length === 0) throw new Error(`Team "${teamName}" is empty`);
        // Prefer the active workspace's normalized team (which carries dispatch mode);
        // fall back to building a TeamConfig inline from the chat's raw config.
        const wsTeam = this.workspaceManager.getTeam(teamName);
        const fallbackDispatch = (Array.isArray(rawTeam) ? 'all' : (rawTeam?.dispatch ?? 'all')) as TeamConfig['dispatch'];
        const fallbackTeam: TeamConfig = { members: rawMembers, dispatch: fallbackDispatch };
        if (fallbackDispatch === 'parallel') {
          const rawParallel = (!Array.isArray(rawTeam) && rawTeam?.parallel) || {};
          fallbackTeam.parallel = { ...DEFAULT_PARALLEL_SETTINGS, ...rawParallel };
        }
        // Carry a Sequential flow graph through the inline fallback too. This path
        // bypasses normalizeTeam, so validate here as well — an invalid graph drops
        // to linear rather than reaching the executor.
        if (fallbackDispatch === 'all' && !Array.isArray(rawTeam) && rawTeam?.graph) {
          const problems = validateGraph(rawTeam.graph, rawMembers);
          if (problems.length === 0) fallbackTeam.graph = rawTeam.graph;
          else this.logger.warn(`[Workspace] Team "${teamName}" fallback flow graph invalid — running linearly: ${problems.join('; ')}`);
        }
        const team: TeamConfig = wsTeam ?? fallbackTeam;
        this.logger.info(`[parallel-debug] teamName=${teamName} dispatch=${team.dispatch} hasParallel=${!!team.parallel} wsTeam=${!!wsTeam} fallbackDispatch=${fallbackDispatch} members=${team.members.join(',')}`);
        const r = await this.runTeamForChat(teamName, team, prompt, workingDir, sink, chatId, chat, abortController.signal, {}, agent, model);
        output = r.response;
        tokens = r.tokens;
        teamChoices = r.choices;
        teamThinkingByStep = r.thinkingByStep;
        teamTurnId = r.teamTurnId;
      } else {
        let response = await this.runWithFallback(agent, {
          prompt,
          agent,
          model,
          context: { workingDir },
          skipPermissions: this.getSkipPermissions(),
          onStream,
          onThinking: (text: string) => sink({ type: 'thinking', chatId, token: text }),
          onStatus,
          signal: abortController.signal,
          resumeSessionId,
          newSessionId,
        });
        // If resume failed (stale session id on disk, or agent rejected it),
        // drop the anchor and retry once with a full bootstrap prompt.
        if (resumeSessionId && !response?.success && !abortController.signal.aborted) {
          this.logger.warn(`[chat ${chatId}] resume of ${resumeSessionId} failed; bootstrapping`);
          this.chatManager.clearSessionAnchor(chatId);
          streamedText = '';
          resumeSessionId = undefined;
          newSessionId = canResume && agent === 'claude-code' ? randomUUID() : undefined;
          prompt = selPrefix + buildChatBootstrapPrompt(chat, userText, attachments);
          // Re-apply the skill banner: the rebuilt bootstrap prompt replaced
          // the one that carried it (still exactly once per prompt build).
          if (appliedChatSkill) prompt = applySkill(prompt, appliedChatSkill);
          response = await this.runWithFallback(agent, {
            prompt,
            agent,
            model,
            context: { workingDir },
            skipPermissions: this.getSkipPermissions(),
            onStream,
            onThinking: (text: string) => sink({ type: 'thinking', chatId, token: text }),
            onStatus,
            signal: abortController.signal,
            resumeSessionId: undefined,
            newSessionId,
          });
        }
        // Solo advisor escalation: if the agent signalled it's stuck, get
        // guidance from the stronger advisor model and re-run, up to N rounds.
        let advisorRounds = 0;
        while (
          chat.soloAdvisor &&
          response?.success &&
          advisorRounds < SOLO_ADVISOR_MAX_ROUNDS &&
          !abortController.signal.aborted
        ) {
          const ask = parseAskAdvisor(this.formatAgentResponse(response));
          if (!ask) break;
          advisorRounds++;
          const guidance = await this.runSoloAdvisor(
            { task: userText, stuckOutput: ask.preamble, reason: ask.reason },
            workingDir,
            abortController.signal,
          );
          if (!guidance) break; // advisor failed → keep the agent's own reply
          sink({ type: 'info', chatId, message: `🧭 Advisor: ${guidance}` });
          streamedText = '';
          const followupInput: SoloAdvisorFollowupInput = {
            task: userText,
            stuckOutput: ask.preamble,
            reason: ask.reason,
            guidance,
          };
          const followup = selPrefix + buildSoloAdvisorFollowupPrompt(followupInput);
          // Intentionally no resumeSessionId/newSessionId — each re-run bootstraps
          // fresh (the prior attempt + guidance are inlined in the followup prompt)
          // so this works uniformly across all agent types, not just claude-code.
          response = await this.runWithFallback(agent, {
            prompt: followup,
            agent,
            model,
            context: { workingDir },
            skipPermissions: this.getSkipPermissions(),
            onStream,
            onThinking: (text: string) => sink({ type: 'thinking', chatId, token: text }),
            onStatus,
            signal: abortController.signal,
          });
        }
        singleAgentResponse = response;
        output = response?.success ? this.formatAgentResponse(response) : (streamedText || '');
        if (chat.soloAdvisor) output = stripAskAdvisor(output);
        tokens = (response as any)?.tokens?.total;
        // Persist the anchor on success for next-turn resume.
        if (canResume && response?.success) {
          const anchorId = newSessionId ?? (response as any)?.sessionId;
          if (anchorId) {
            this.chatManager.setSessionAnchor(chatId, { agent, sessionId: anchorId });
          }
        }
        // Surface permission denials so the UI can offer to add them to the allow list.
        if (response?.permissionDenials && response.permissionDenials.length > 0) {
          sink({ type: 'permission_denials', chatId, denials: response.permissionDenials });
        }
        // Capture structured AskUserQuestion from the agent so the UI can
        // render interactive choices instead of raw JSON.
        if (response?.userQuestion) {
          agentUserQuestion = response.userQuestion;
        }
      }
      if (abortController.signal.aborted) {
        // User-initiated stop: roll the prompt back so the client can restore
        // it into the input box. Don't append a "Stopped" assistant message
        // and don't fan out to other routes.
        this.chatManager.removeMessage(chatId, userMessage.id);
        sink({ type: 'stopped', chatId, userMessageId: userMessage.id, text: userText });
        return { response: '', chatId };
      }

      const durationSec = Math.round((Date.now() - started) / 1000);

      // ASK_USER:choice detection. Team flows already stripped the marker into
      // a rendered question via runTeamForChat, so reuse the choices it
      // returned. For non-team chats, parse the worker output for the marker.
      // Also check for structured AskUserQuestion from the agent adapter.
      let surfacedChoices: string[] | undefined;
      let plainAskOptions: string[] | undefined;
      if (agentUserQuestion && agentUserQuestion.options.length >= 2) {
        surfacedChoices = agentUserQuestion.options.map(o => o.label);
      } else if (teamChoices && teamChoices.length >= 2) {
        surfacedChoices = teamChoices;
      } else {
        const plainAsk = parseAskUser(output);
        if (plainAsk?.options && plainAsk.options.length >= 2) {
          surfacedChoices = plainAsk.options;
          plainAskOptions = plainAsk.options;
        }
      }

      const assistantMessage: ChatMessage = {
        id: randomUUID(),
        role: 'assistant',
        content: output,
        thinking: singleAgentResponse?.thinking,
        thinkingByStep: teamThinkingByStep,
        timestamp: Date.now(),
        toolCalls,
        isComplete: true,
        tokens,
        durationSec,
        ...(surfacedChoices ? { choices: surfacedChoices } : {}),
        ...(agentUserQuestion ? { userQuestion: agentUserQuestion } : {}),
        ...(singleAgentResponse?.fallback ? { fallback: singleAgentResponse.fallback } : {}),
      };
      // For per-worker team runs the transcript was already persisted as
      // individual worker messages by the WorkerMessageEmitter, so skip the
      // single combined assistant message. Title + 'done' still run below.
      if (!teamTurnId) {
        const updated = this.chatManager.appendMessage(chatId, assistantMessage);

        // Persist lastAskedOptions on non-team chats so the next user reply can
        // be digit-mapped. Team flows track this via pendingTeam.options.
        if (plainAskOptions && !updated.pendingTeam) {
          this.chatManager.setLastAskedOptions(chatId, assistantMessage.id, plainAskOptions);
        }
      }

      // Apply the Aide-generated title (first turn only) before announcing
      // completion so the sidebar updates in the same 'done' event.
      let finalTitle = this.chatManager.get(chatId)?.title;
      if (titlePromise) {
        const aiTitle = await titlePromise;
        if (aiTitle && aiTitle !== finalTitle) {
          this.chatManager.rename(chatId, aiTitle);
          finalTitle = aiTitle;
        }
      }

      sink({ type: 'done', chatId, response: output, thinking: singleAgentResponse?.thinking, tokens, durationSec, title: finalTitle, choices: surfacedChoices, userQuestion: agentUserQuestion, fallback: singleAgentResponse?.fallback, ...(teamTurnId ? { teamTurnId } : {}) });

      // ── Skills: post-run pass (fire-and-forget, response already delivered) ──
      // Skip the whole pass when this turn ended PAUSED — i.e. the team run
      // re-set pendingTeam because a worker asked the user a question. Re-read
      // the chat: the run itself persists the pause via setPendingTeam, so the
      // freshest signal is the chat record, not the pre-run `pendingTeam` local.
      // A paused turn's `output` is the worker's mid-run question: no trace
      // (bad distillation input), no distill, no suggestion (it would collide
      // with the team's question on the next user turn), and no use/success
      // bookkeeping for an applied skill either — the run isn't finished yet.
      const pausedAfterRun = !!this.chatManager.get(chatId)?.pendingTeam;
      if (skillsCfg?.enabled && !pausedAfterRun) {
        // Real success signal: the solo path exposes it on singleAgentResponse
        // (a failed run reaches here with success:false and output = streamed
        // partial text or ''). Team paths have no structured flag — they throw
        // to the catch block on failure — so non-empty output is the signal.
        // Failed runs still run the pass so an applied skill records a
        // correction; afterRunSkillPass skips trace/distill itself when !clean.
        const runSucceeded = singleAgentResponse ? !!singleAgentResponse.success : !!output;
        // Worker sequence for team turns comes from the persisted per-worker
        // messages (teamThinkingByStep only maps step → thinking text, no names).
        const workerSequence = teamTurnId
          ? this.chatManager.get(chatId)?.messages
              .filter(m => m.teamTurnId === teamTurnId && m.worker)
              .map(m => m.worker as string)
          : undefined;
        const chatTrace: RunTrace = {
          runId: `chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          promptSummary: userText.slice(0, 200),
          outputPreview: (output || '').slice(0, 300),
          workerSequence: workerSequence && workerSequence.length > 0 ? workerSequence : undefined,
          timestamp: Date.now(),
          mode: teamTurnId ? 'team-sequential' : 'solo',
        };
        // afterRunSkillPass never rejects (stage-isolated try/catch inside).
        void this.afterRunSkillPass({
          trace: chatTrace,
          appliedSkill: appliedChatSkill,
          clean: runSucceeded,
          // A turn that ended by asking the user something (choice buttons or
          // a structured AskUserQuestion) must not get a skill suggestion
          // stacked on top — the user's "yes" would resolve the suggestion
          // instead of the agent's question. Trace/evolve still run.
          suppressSuggestion: !!surfacedChoices || !!agentUserQuestion,
          notify: (text) => { sink({ type: 'info', chatId, message: text, skillNotice: true }); },
          setPending: (s) => { this.chatManager.setPendingSkillSuggestion(chatId, s); },
        });
      }

      // Mirror this turn to every attached route except the originating one.
      // Mac-origin uses a synthetic '__mac__' channel that matches no real
      // route, so every attached channel receives the user prompt + reply.
      // Channel-origin passes the real channel+userId so the originating
      // channel's user doesn't see their own message echoed back.
      const originChannel = (origin?.channel ?? '__mac__') as ChannelType;
      const originUserId = origin?.channelUserId ?? '';
      // Only echo the user's prompt to other routes when it came from a channel,
      // so other attached channels see the conversation in context. Mac-origin
      // user input is intentionally not mirrored — only the assistant reply is.
      if (origin) {
        await this.fanOutToOtherRoutes(chatId, originChannel, originUserId, `💬 ${userText}`);
      }
      await this.fanOutToOtherRoutes(chatId, originChannel, originUserId, output);

      return { response: output, chatId, tokens, durationSec };
    } catch (err) {
      if (abortController.signal.aborted) {
        // Same rollback as the abort branch above — agent runners surface
        // aborts as thrown errors, but we still want to restore the prompt.
        this.chatManager.removeMessage(chatId, userMessage.id);
        sink({ type: 'stopped', chatId, userMessageId: userMessage.id, text: userText });
        return { response: '', chatId };
      }
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
    const runner = this.activeParallelRuns.get(chatId);
    if (runner) {
      void runner.stop('user_cancel', 'user cancelled the discussion');
      // Also abort the surrounding chat turn so the prompt is rolled back
      // and the 'stopped' event fires from runChatTurn's abort branch.
      const c = this.chatAborts.get(chatId);
      if (c) c.abort();
      return true;
    }
    const controller = this.chatAborts.get(chatId);
    if (!controller) return false;
    controller.abort();
    return true;
  }
}
