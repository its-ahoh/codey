import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { AgentRequest, AgentResponse, AideOptions, ChannelKind, Chat, ChatCompaction, ChatRoute, FallbackEntry, GatewayConfig, GatewayResponse, UserMessage, CodingAgent, ModelConfig, ChannelType, ChannelConfig, ChatMessage, ToolCallEntry, runAdvisor, summarizeChatMessages, generateChatTitle, generateTaskBrief, generateAideTurnDigest, TaskBrief, AdvisorTurn, AdvisorHistoryEntry, parseAskUser, parseAsk, PendingTeamState, discussionDir, controlPath, summaryPath, topicPath, opinionPath, initDiscussionDir, TeamBlackboard, WorkerAnchor, lastParagraphPreview, parseAskAdvisor, stripAskAdvisor, buildSoloAdvisorPrompt, buildSoloAdvisorFollowupPrompt, SoloAdvisorInput, SoloAdvisorFollowupInput, TeamGraph, validateGraph, startRun, advance, resolveEdge, outgoingEdges, eligibleEdges, runJudge, JudgeInput, JudgeDecision, TeamGraphEdge, GraphRunState, SkillEntry, SkillStore, RunTrace, DistillDeps, DistillResult, matchSkill, confirmMatch, applySkill, distillCandidate, evolveSkill, isLowSignalTrace, stepsFrom, clusterProcedures, induceTemplate, nameTemplate, ClusterReport, ProcedureCluster, hasProcedureData, RECENT_TRACES_MAX, Automation, AutomationRun, AutomationEvent, AutomationCheck, renderBrief, automationChatTurn, classifyDryRun, DryRunVerdict, parseVoiceCommand, VoiceCommand, pickVoiceAck, needsDigest, buildSpeechDigestPrompt, stripForSpeech, splitIntoSentences, SentenceAccumulator, ConversationDigestCache, VoiceConverseEvent, buildTeamFastPathPrompt, parseTeamFastPathDecision, TeamFastPathDecision, finalizeTeamRunSummary, TeamRunSummary, ThinkingEffort, DEFAULT_THINKING_EFFORT, ApiType, unwiredAllProtocols } from '@codey/core';
import { randomUUID } from 'crypto';
import { AutomationStore } from './automations/store';
import { AutomationEngine, TargetResult } from './automations/engine';
import { SchedulerLease } from './automations/lease';
import { AutomationChatManager, ChatStep } from './automations/chat';
import { DryRunManager } from './automations/dry-run';
import { needsRecheck, verdictToCheck } from './automations/check';
import { detectParked, ParkedInfo } from './automations/parked';
import { closeSandbox, openSandbox, sandboxLogLine, SandboxOps } from './automations/sandbox';
import { formatRunSummary } from './automations/report';
import { formatRunLogEvent } from './automations/run-log';
import { ConfigManager, ResolvedVoiceTtsSettings } from './config';
import { TelegramHandler, DiscordHandler, IMessageHandler, TuiHandler, VoiceChannelHandler, ChannelHandler } from './channels';
import { synthesizeSpeech } from './voice-tts';
import { runTextCompletion, streamTextCompletion, canRunDirectly } from './text-completion';
import { AgentFactory, isThinkingEffort } from '@codey/core';
import { Logger } from './logger';
import { ContextManager, ContextWindow } from '@codey/core';
import { MemoryStore } from '@codey/core';
import { WorkspaceManager, TeamConfigRaw, TeamConfig, DEFAULT_PARALLEL_SETTINGS } from '@codey/core';
import { WorkerManager } from '@codey/core';
import { ChatManager, CreateChatInput } from './chats';
import { chatWorktreeParent, discardDisposableWorktree, discoverChatWorktree, ensureWorktreeContainer, isGitWorkspace, provisionChatWorktree, removeCleanChatWorktree, resolveRegisteredWorktreeBinding, workspaceHasUncommittedChanges } from './chat-worktree';
import { resolveEffort } from './effort-resolve';
import { PairingStore, ChannelBinding } from './pairings';
import { summarizePriorHistory } from './summary';
import { chatStreamEventForStatus, isPersistableToolCall } from './chat-status-events';
import { buildChatPrompt, buildChatBootstrapPrompt, buildChatResumePrompt, buildChatCatchupPrompt, buildQuickQuestionPrompt, assistantPrefixForSelection, RunSemaphore, ChatStreamSink, READ_ONLY_TOOLS, QQStreamEvent, QQHistoryEntry, SOLO_ADVISOR_INSTRUCTION } from './chat-runner';
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

/** A failed run may be retried this many times before fallback routing starts. */
export const MAX_NETWORK_RETRIES = 5;

/** Keep retries narrow: agent/config/permission failures must not be repeated. */
export function isRetryableNetworkFailure(response: AgentResponse): boolean {
  if (response.success) return false;
  const text = `${response.error ?? ''}\n${response.output ?? ''}`.toLowerCase();
  return /(?:\btimeout\b|timed out|deadline exceeded|etimedout|econnreset|econnrefused|enotfound|eai_again|socket hang up|fetch failed|network (?:error|unavailable)|connection (?:closed|lost|reset|refused|error)|temporarily unavailable|service unavailable|gateway timeout|\b(?:408|429|500|502|503|504)\b)/i.test(text);
}

/** Longest primary-failure text carried into fallback metadata. The full text
 *  stays in the gateway log; this only has to explain the fallback in a popup. */
const FALLBACK_REASON_MAX = 400;

/** One-line-ish explanation of why a run failed, for the fallback badge.
 *  Prefers `error` (the adapter's own diagnosis) over raw `output`. */
export function summarizeFailure(response: AgentResponse): string | undefined {
  const raw = (response.error ?? response.output ?? '').trim();
  if (!raw) return undefined;
  return raw.length > FALLBACK_REASON_MAX ? `${raw.slice(0, FALLBACK_REASON_MAX).trimEnd()}…` : raw;
}

/**
 * The log line for an 'all' model whose key covers only one protocol, or
 * undefined when there is nothing to say.
 *
 * `applyModelEnv` wires up a protocol only when its base URL is known, so the
 * missing half silently stays on the ambient environment: the CLI aims a
 * third-party token at the real api.anthropic.com / api.openai.com and fails
 * as what reads like a broken key. The model editor warns while editing, but a
 * model written by `models:save` or by hand into gateway.json never passes
 * through it — `getModelConfig` is the one point every path converges on
 * before a CLI is spawned.
 */
export function unwiredAllModelWarning(model: ModelConfig, keyRef?: string): string | undefined {
  const missing = unwiredAllProtocols(model);
  if (missing.length === 0) return undefined;
  const where = keyRef ? `API key "${keyRef}"` : 'its API key';
  const consequence = missing.length === 2
    ? 'neither protocol is wired up'
    : 'that protocol is not wired up';
  return `Model "${model.model}" has apiType "all" but ${where} defines no ${missing.join(' or ')} `
    + `base URL, so ${consequence} and the ambient environment is used instead. `
    + `Agents pinned to ${missing.join('/')} will authenticate against the official endpoint and likely fail. `
    + `Add the base URL under API Keys, or give this model a single-protocol API Type.`;
}

/**
 * Expand a catalog model row plus its bound API key into the ModelConfig an
 * adapter receives. Split out of `getModelConfig` because this is the single
 * place a dual-protocol ('all') model gets its two endpoints — if it stopped
 * populating them, `applyModelEnv` would wire up nothing and every 'all' model
 * would silently degrade to the ambient environment, with both of its own
 * tests still green.
 *
 * `anthropicBaseUrl` / `openaiBaseUrl` are deliberately confined to 'all'
 * models: a single-protocol model's endpoint belongs on `baseUrl`, which stays
 * the anthropic-first pick for callers (like text-completion) that can only
 * speak one protocol at a time.
 */
export function bindModelToApiKey(
  entry: { model: string; apiType: ApiType; provider?: string },
  apiKey?: { apiKey: string; anthropicBaseUrl?: string; openaiBaseUrl?: string },
): ModelConfig {
  const isAll = entry.apiType === 'all';
  const baseUrl = apiKey
    ? (entry.apiType === 'anthropic' ? apiKey.anthropicBaseUrl
      : entry.apiType === 'openai' ? apiKey.openaiBaseUrl
      : apiKey.anthropicBaseUrl ?? apiKey.openaiBaseUrl)
    : undefined;
  return {
    provider: entry.provider ?? (entry.apiType === 'openai' ? 'openai' : 'anthropic'),
    model: entry.model,
    apiKey: apiKey?.apiKey,
    baseUrl,
    anthropicBaseUrl: isAll ? apiKey?.anthropicBaseUrl : undefined,
    openaiBaseUrl: isAll ? apiKey?.openaiBaseUrl : undefined,
    apiType: entry.apiType,
  };
}

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
  private automationStore?: AutomationStore;
  private automationEngine?: AutomationEngine;
  private automationChats?: AutomationChatManager;
  private automationDryRuns?: DryRunManager;
  private automationEventListener?: (ev: AutomationEvent) => void;
  private voiceHandler?: VoiceChannelHandler;
  private voiceDigestCache = new ConversationDigestCache();

  // Rate limiting: userId -> last request timestamp
  private userCooldowns: Map<string, number> = new Map();
  private warnedUnwiredModels: Set<string> = new Set();
  private readonly COOLDOWN_MS: number;

  // Response chunking
  private readonly MAX_MESSAGE_LENGTH = 2000;

  // Stats
  private messagesProcessed = 0;
  private errors = 0;
  private startTime = Date.now();
  private tuiMode = false;
  private workingDir: string = process.cwd();
  /** Last spoken acknowledgement, so the next turn draws a different one. */
  private lastVoiceAck?: string;

  /** Pending skill suggestions for the channel surface, keyed `${channel}:${chatId}`.
   *  `workspaceName` pins the suggestion to the workspace it was distilled in,
   *  so a later workspace switch can't save it into the wrong skills store.
   *  (Chat-surface suggestions are persisted on the Chat via ChatManager instead.) */
  private pendingSkillSuggestions = new Map<string, { suggestion: DistillResult; workspaceName: string }>();
  private pendingChatWorkspaces = new Map<string, Promise<Chat>>();
  private skillRunCounter = 0;
  private lastSkillDistillTime = 0;
  private static SKILL_DISTILL_COOLDOWN_MS = 300_000; // 5 min
  private static SKILL_GC_EVERY_N_RUNS = 20;
  private static SKILL_EVOLVE_EVERY_N_USES = 3;

  // Pre-compiled regex for /team command parsing
  private static readonly REGEX_TEAM = /\/team\s+(\w+)(?:\s+(--all))?\s+(?!--all\s*$)(.+)/i;

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
    browserChatId?: string;
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
      // Worker tier. No chat is in scope on this path, and the per-agent
      // global default is filled in by runWithFallback when this is undefined.
      effort: resolveEffort({ worker: wm.getWorkerEffort(opts.workerName) }),
      context: { workingDir: opts.workingDir ?? this.workingDir },
      browserTools: true,
      browserChatId: opts.browserChatId,
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

  /** The per-agent configured effort, falling back to the balanced baseline. */
  private getDefaultEffort(agent: CodingAgent): ThinkingEffort {
    return this.config.agents?.[agent]?.defaultEffort ?? DEFAULT_THINKING_EFFORT;
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

  /** Conservative gate for Sequential/Graph teams. Invalid, failed, or
   * uncertain classifications always keep the full workflow. */
  private async decideSequentialFastPath(
    members: string[],
    task: string,
    workingDir: string,
    signal?: AbortSignal,
  ): Promise<TeamFastPathDecision> {
    const workerManager = this.workspaceManager.getWorkerManager();
    const roster = members.map(name => ({ name, hint: workerManager.getDispatchHint(name) }));
    if (roster.length === 1) {
      return { route: 'single_worker', worker: roster[0].name, reason: 'The team has one member.' };
    }
    const { agent, model } = this.getAdvisorAgentAndModel();
    try {
      const response = await this.runWithFallback(agent, {
        prompt: buildTeamFastPathPrompt(task, roster),
        agent,
        model,
        context: { workingDir },
        onStream: () => {},
        onThinking: () => {},
        onStatus: () => {},
        signal,
      });
      if (!response?.success) return { route: 'full_flow', reason: 'Routing gate failed.' };
      return parseTeamFastPathDecision(this.formatAgentResponse(response), roster);
    } catch {
      return { route: 'full_flow', reason: 'Routing gate failed.' };
    }
  }

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
    // Plugins are opt-in: the factory only attaches plugin MCP servers when
    // the user has enabled them in config. Read live so toggling in the
    // renderer applies on the next agent spawn without a restart.
    this.agentFactory.setPluginEnabledProvider((plugin) =>
      plugin === 'browser' && this.configManager?.isPluginEnabled('browser') === true
    );
    // User-configured external MCP servers ride the same live-read pattern.
    this.agentFactory.setExternalMcpProvider(() =>
      this.configManager?.getEnabledExternalMcpServers()
    );
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

  /** New chats begin in the shared checkout. A worktree is created either by
   *  the explicit Branch Selector action or when the running agent opts in. */
  public async createChat(input: CreateChatInput): Promise<Chat> {
    return this.chatManager.create({ ...input, executionMode: 'shared-checkout' });
  }

  public async listChats(workspaceName?: string): Promise<Chat[]> {
    return this.chatManager.list(workspaceName);
  }

  public async getChat(chatId: string): Promise<Chat> {
    const chat = this.chatManager.get(chatId);
    if (!chat) throw new Error(`Chat not found: ${chatId}`);
    return chat;
  }

  public async deleteChat(chatId: string): Promise<void> {
    const chat = await this.getChat(chatId);
    if (this.chatAborts.has(chatId)) throw new Error('Wait for the current agent turn to finish before deleting this chat');
    if (chat.chatWorkspace) await removeCleanChatWorktree(chat.chatWorkspace);
    this.chatManager.delete(chatId);
  }

  /** Preflight every chat worktree before deleting a Workspace, then remove
   *  only their clean checkouts. Branches remain available in the repository. */
  public async prepareWorkspaceDeletion(workspaceName: string): Promise<void> {
    const chats = this.chatManager.list(workspaceName, { includeAutomation: true });
    const worktrees = chats.flatMap(chat => chat.chatWorkspace ? [chat.chatWorkspace] : []);
    for (const workspace of worktrees) {
      if (fs.existsSync(workspace.worktreePath) && await workspaceHasUncommittedChanges(workspace.worktreePath)) {
        throw new Error(`Worktree "${workspace.name ?? path.basename(workspace.worktreePath)}" has uncommitted changes. Commit or stash them before deleting this workspace.`);
      }
    }
    for (const workspace of worktrees) await removeCleanChatWorktree(workspace);
  }

  /** Idempotently provision the explicitly named filesystem environment owned by a chat. */
  public async ensureChatWorkspace(chatId: string, worktreeName?: string): Promise<Chat> {
    const chat = this.chatManager.get(chatId);
    if (!chat) throw new Error(`Chat not found: ${chatId}`);
    if (chat.executionMode !== 'isolated-worktree') return chat;
    if (chat.chatWorkspace) {
      if (fs.existsSync(chat.chatWorkspace.workingDir)) return chat;
      throw new Error(`Chat workspace is missing: ${chat.chatWorkspace.workingDir}`);
    }
    if (!worktreeName) throw new Error('Create and name a worktree from the Branch Selector first');
    const pending = this.pendingChatWorkspaces.get(chatId);
    if (pending) return pending;
    const provision = provisionChatWorktree({
      workspaceWorkingDir: this.resolveWorkspaceWorkingDir(chat.workspaceName),
      worktreeName,
    }).then(workspace => {
      const updated = this.chatManager.setChatWorkspace(chat.id, workspace);
      return updated;
    })
      .finally(() => this.pendingChatWorkspaces.delete(chatId));
    this.pendingChatWorkspaces.set(chatId, provision);
    return provision;
  }

  /** Adopt a worktree that an agent created for this chat. No model call is
   *  involved: ownership is determined from local Git state. */
  private async adoptAgentCreatedWorktree(chatId: string): Promise<Chat | undefined> {
    const chat = this.chatManager.get(chatId);
    if (!chat || chat.chatWorkspace) return undefined;
    try {
      const workspace = await discoverChatWorktree({
        workspaceWorkingDir: this.resolveWorkspaceWorkingDir(chat.workspaceName),
        // The container is shared, so anything older than the chat, or already
        // bound to another chat, belongs to someone else.
        notBefore: chat.createdAt,
        claimedPaths: this.chatManager.list(chat.workspaceName, { includeAutomation: true })
          .flatMap(other => other.chatWorkspace ? [other.chatWorkspace.worktreePath] : []),
      });
      if (!workspace) return undefined;
      // The agent created the checkout with plain Git, so the container may not
      // be excluded from the workspace's own status yet.
      ensureWorktreeContainer(this.resolveWorkspaceWorkingDir(chat.workspaceName));
      const updated = this.chatManager.setChatWorkspace(chat.id, workspace);
      this.logger.info(`[chat ${chat.id}] adopted agent-created worktree ${workspace.name ?? workspace.worktreePath}`);
      return updated;
    } catch (error) {
      this.logger.warn(`[chat ${chat.id}] could not adopt agent-created worktree: ${(error as Error).message}`);
      return undefined;
    }
  }

  /** Explicitly create and bind a user-named worktree to one chat. */
  public async createChatWorktree(chatId: string, worktreeName: string): Promise<Chat> {
    const chat = await this.getChat(chatId);
    if (chat.chatWorkspace) throw new Error(`This chat already owns the worktree "${chat.chatWorkspace.name ?? path.basename(chat.chatWorkspace.worktreePath)}"`);
    if (this.chatAborts.has(chatId)) throw new Error('Wait for the current agent turn to finish before creating a worktree');
    const previousMode = chat.executionMode ?? 'shared-checkout';
    // Logged so a chat that turns out to be bound to a worktree can be traced
    // back to this explicit UI action rather than to agent-side adoption.
    this.logger.info(`[chat ${chatId}] Branch Selector requested worktree "${worktreeName}"`);
    this.chatManager.setExecutionMode(chatId, 'isolated-worktree');
    try {
      return await this.ensureChatWorkspace(chatId, worktreeName);
    } catch (error) {
      this.chatManager.setExecutionMode(chatId, previousMode);
      throw error;
    }
  }

  /** Switch the checkout used by one chat. Worktrees are retained when a chat
   *  switches back to the shared checkout so the operation is reversible. */
  public async setChatExecutionMode(chatId: string, mode: NonNullable<Chat['executionMode']>): Promise<Chat> {
    const chat = await this.getChat(chatId);
    if (this.chatAborts.has(chatId)) throw new Error('Wait for the current agent turn to finish before switching checkout mode');
    if (mode === 'isolated-worktree') {
      if (!chat.chatWorkspace) throw new Error('Create and name a worktree first');
      this.chatManager.setExecutionMode(chatId, mode);
      return this.ensureChatWorkspace(chatId);
    }
    return this.chatManager.setExecutionMode(chatId, mode);
  }

  /** Bind a chat to a worktree already registered in the workspace repository.
   * The checkout remains user-managed: binding never transfers ownership and
   * deleting the chat must therefore never remove it. */
  public async bindChatToWorktree(chatId: string, worktreePath: string, expectedBranch?: string): Promise<Chat> {
    const chat = await this.getChat(chatId);
    if (this.chatAborts.has(chatId)) throw new Error('Wait for the current agent turn to finish before switching worktrees');
    const binding = await resolveRegisteredWorktreeBinding({
      workspaceWorkingDir: this.resolveWorkspaceWorkingDir(chat.workspaceName),
      worktreePath,
    });
    if (expectedBranch && binding.branch !== expectedBranch) {
      throw new Error(`Git changed while switching: this worktree now has branch "${binding.branch ?? '(detached)'}" instead of "${expectedBranch}"`);
    }

    if (binding.isMain) return this.chatManager.setExecutionMode(chatId, 'shared-checkout');
    if (chat.chatWorkspace
      && fs.existsSync(chat.chatWorkspace.worktreePath)
      && fs.realpathSync(chat.chatWorkspace.worktreePath) === binding.worktreePath) {
      return this.setChatExecutionMode(chatId, 'isolated-worktree');
    }

    const occupied = this.chatManager.list(chat.workspaceName, { includeAutomation: true }).find(other => {
      if (other.id === chat.id) return false;
      if (other.executionMode === 'isolated-worktree' && other.chatWorkspace) {
        return fs.existsSync(other.chatWorkspace.worktreePath)
          && fs.realpathSync(other.chatWorkspace.worktreePath) === binding.worktreePath;
      }
      return Boolean(other.workingDirOverride)
        && path.resolve(other.workingDirOverride!) === path.resolve(binding.workingDir);
    });
    if (occupied) throw new Error(`This worktree is already used by chat "${occupied.title}"`);

    return this.chatManager.setExternalWorkingDir(chatId, binding.workingDir);
  }

  public setChatEventListener(fn: (ev: any) => void): void {
    this.chatEventListener = fn;
  }

  public setPairingEventListener(
    fn: (ev: { type: 'completed'; channel: ChannelKind; channelUserId: string }) => void,
  ): void {
    this.pairingEventListener = fn;
  }

  /**
   * Mac calls this to start a pairing flow. Returns a 6-digit code shown in
   * the UI, plus a deep link (rendered as a QR code) when the channel supports
   * sending the code without typing it: Telegram via a t.me ?start payload,
   * iMessage via an sms: compose link with the command prefilled.
   */
  public startPairing(channel: ChannelKind): { code: string; deepLink?: string } {
    const code = this.pairingStore.startPairing({ channel });
    let deepLink: string | undefined;
    if (channel === 'telegram') {
      const handler = this.handlers.get('telegram');
      const username = handler instanceof TelegramHandler ? handler.getBotUsername() : undefined;
      if (username) deepLink = `https://t.me/${username}?start=pair_${code}`;
    } else if (channel === 'imessage') {
      deepLink = `sms:&body=${encodeURIComponent(`/pair ${code}`)}`;
    }
    return { code, deepLink };
  }

  public listPairings(): ChannelBinding[] {
    return this.pairingStore.list();
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

  getWorkingDir(): string { return this.workingDir; }

  async switchWorkspaceByName(name: string): Promise<boolean> {
    return this.switchWorkspace(name);
  }

  /** Lazily creates and registers the synthetic 'voice' channel handler
   *  (see channels/voice.ts) the first time a voice conversation runs. */
  private getVoiceHandler(): VoiceChannelHandler {
    if (!this.voiceHandler) {
      const handler = new VoiceChannelHandler();
      handler.onMessage(this.handleMessage.bind(this));
      this.voiceHandler = handler;
      this.handlers.set('voice', handler);
    }
    return this.voiceHandler;
  }

  /** "有什么通知" — spoken summary of automation runs the user hasn't seen yet. */ // lint-allow-non-english
  private describeUnseenNotifications(): string {
    const automations = this.listAutomations();
    const unseen: { name: string; run: AutomationRun }[] = [];
    for (const automation of automations) {
      const runs = this.listAutomationRuns(automation.id, 5);
      for (const run of runs) {
        if (!run.seenAt) unseen.push({ name: automation.name, run });
      }
    }
    if (unseen.length === 0) return '没有新的通知。'; // lint-allow-non-english
    const summary = unseen
      .slice(0, 5)
      .map(({ name, run }) => `${name}${run.status === 'failed' ? '失败' : run.status === 'parked' ? '在等你回复' : '已完成'}`) // lint-allow-non-english
      .join('，'); // lint-allow-non-english
    return `你有 ${unseen.length} 条新通知：${summary}。`; // lint-allow-non-english
  }

  /**
   * Resolves the model the speech digest should use. Prefers an explicit
   * `voice.tts.digestModel` (point it at a small, fast model — digesting is
   * a tool-free text transform), else reuses the Aide model. Returns
   * undefined rather than throwing when the binding is broken, since a
   * missing digest model must degrade to the CLI path, not fail the turn.
   */
  private resolveDigestModel(agent: CodingAgent, aideModel?: ModelConfig): ModelConfig | undefined {
    const name = this.configManager?.get().voice?.tts?.digestModel;
    if (!name) return aideModel;
    try {
      return this.getModelConfig(agent, name) ?? aideModel;
    } catch (e) {
      this.logger.warn(`Voice digest model "${name}" could not be resolved, falling back: ${e}`);
      return aideModel;
    }
  }

  /**
   * Streams a speech digest of `fullReply`, handing each completed sentence
   * to `onSentence` as soon as it lands. Returns false when no streaming
   * path is available (no API credentials on the resolved model) or when the
   * stream produced nothing, so the caller can fall back to the one-shot
   * digest. Returns true after a partial stream too — those sentences have
   * already been spoken, and re-running would repeat them.
   */
  private async streamVoiceDigest(fullReply: string, onSentence: (s: string) => void): Promise<boolean> {
    let digestModel: ModelConfig | undefined;
    try {
      const { agent, model } = this.getAideAgentAndModel();
      digestModel = this.resolveDigestModel(agent, model);
    } catch (e) {
      // Aide resolution throws when a model points at an API key that
      // no longer exists. Speaking the reply undigested is a fine outcome;
      // letting this escape turns the whole turn into an error event and the
      // user hears nothing at all.
      this.logger.warn(`Voice digest model unavailable, speaking the reply as-is: ${e}`);
      return false;
    }
    if (!canRunDirectly(digestModel)) return false;

    const accumulator = new SentenceAccumulator();
    const text = await streamTextCompletion(
      buildSpeechDigestPrompt(fullReply),
      digestModel,
      (delta) => accumulator.push(delta).forEach(onSentence),
      { maxTokens: 512 },
    );
    if (!text) return false;
    accumulator.flush().forEach(onSentence);
    return true;
  }

  private async runVoiceDigestPrompt(fullReply: string): Promise<string | null> {
    const { agent, model } = this.getAideAgentAndModel();
    const prompt = buildSpeechDigestPrompt(fullReply);

    // Fast path — a plain HTTP call to the model API. The digest sits in the
    // worst possible spot for a voice turn: the silence after the agent has
    // finished but before Codey starts speaking. Spawning an agentic CLI
    // here costs process boot + config load + MCP init before the model is
    // even reached (5-15s); a direct call to a small model is ~1s.
    const digestModel = this.resolveDigestModel(agent, model);
    if (canRunDirectly(digestModel)) {
      const direct = await runTextCompletion(prompt, digestModel, { maxTokens: 512, timeoutMs: 20000 });
      if (direct) return direct;
      this.logger.warn('Voice digest via direct API returned nothing; falling back to the agent CLI path.');
    }

    // Fallback — no API credentials on the model (e.g. a CLI-auth setup), or
    // the direct call failed. Slower, but keeps the feature working.
    try {
      const resp = await this.runWithFallback(agent, {
        prompt,
        agent,
        model,
        // Well under the adapter's 15-minute default: a stalled digest here
        // is pure dead air, and speaking the undigested reply beats silence.
        timeout: 60000,
        context: { workingDir: this.workingDir },
        onStream: () => {},
        onThinking: () => {},
        onStatus: () => {},
      });
      if (!resp?.success) return null;
      const text = this.formatAgentResponse(resp).trim();
      return text.length > 0 ? text : null;
    } catch {
      return null;
    }
  }

  /**
   * The spoken acknowledgement for a voice turn, drawn from a written list
   * (see `pickVoiceAck`) rather than generated.
   *
   * This used to be a model call so the ack could name what you had just
   * asked. It sat on the one part of a voice turn that has to be instant — the
   * silence right after you stop talking — and when it timed out, which it
   * routinely did, it fell back to one fixed line anyway. Rotating written
   * phrases gives the same content with no wait and no repetition.
   */
  generateVoiceAck(transcript: string): string {
    const ack = pickVoiceAck(transcript, { previous: this.lastVoiceAck });
    this.lastVoiceAck = ack;
    return ack;
  }

  /** Resolves who synthesizes audio for a spoken reply. */
  private resolveTtsMode(): { tts: ResolvedVoiceTtsSettings | undefined; ttsMode: 'server' | 'client' } {
    const voice = this.configManager?.getResolvedVoiceConfig();
    const tts = voice?.tts;
    const ttsMode: 'server' | 'client' =
      tts?.enabled && tts.provider === 'api' && tts.apiKey ? 'server' : 'client';
    return { tts, ttsMode };
  }

  /**
   * Builds the sentence→(text, audio) emitter shared by /voice/converse and
   * /voice/speak. `speak` emits a sentence's text immediately and starts its
   * synthesis right away; `finish` waits for the audio queue to drain and
   * emits `done`.
   *
   * Audio events must reach the client in `seq` order, but synthesis should
   * start the instant a sentence exists — so requests are fired immediately
   * and only emission is serialized, by chaining.
   */
  private makeSpeechEmitter(
    emit: (event: VoiceConverseEvent) => void,
    ttsMode: 'server' | 'client',
    tts: { apiUrl: string; apiKey: string; apiModel: string; voiceId: string } | undefined,
  ): { speak: (sentence: string) => void; finish: () => Promise<void> } {
    let ttsDegraded = false;
    let seq = 0;
    let audioChain: Promise<void> = Promise.resolve();

    const speak = (sentence: string): void => {
      const mySeq = seq++;
      emit({ type: 'text', seq: mySeq, text: sentence });
      if (ttsMode !== 'server' || ttsDegraded || !tts) return;

      const synthesis = synthesizeSpeech(sentence, {
        apiUrl: tts.apiUrl,
        apiKey: tts.apiKey,
        apiModel: tts.apiModel,
        voiceId: tts.voiceId,
      }).then(
        (audio) => ({ ok: true as const, audio }),
        (e) => ({ ok: false as const, e }),
      );

      audioChain = audioChain.then(async () => {
        const result = await synthesis;
        // Sentences are dispatched to the synthesizer as soon as they exist,
        // so several can already be in flight when one fails. Suppress the
        // rest here rather than letting a later success through: the chain
        // runs in seq order, and a reply that switches back to the API voice
        // partway through the client's fallback voice sounds broken.
        if (ttsDegraded) return;
        if (result.ok) {
          emit({ type: 'audio', seq: mySeq, format: 'mp3', dataBase64: result.audio.toString('base64') });
        } else {
          this.logger.error(`Voice TTS synthesis failed, degrading to client-side speech: ${result.e}`);
          ttsDegraded = true;
        }
      });
    };

    const finish = async (): Promise<void> => {
      await audioChain;
      emit({ type: 'done', ttsDegraded: ttsDegraded || undefined });
    };

    return { speak, finish };
  }

  /**
   * Speaks `text` aloud without running an agent: digest (per verbosity),
   * sentence-split, stream text/audio, done.
   *
   * This is what the in-chat voice button uses. It deliberately does *not*
   * go through runVoiceConverse — a chat message has to travel the normal
   * chat path to keep that chat's context, working directory and history.
   * By the time this is called the reply already exists; all that's left is
   * saying it.
   */
  async runVoiceSpeak(
    text: string,
    emit: (event: VoiceConverseEvent) => void,
    conversationId?: string,
    /** Read exactly as given: no digest, and nothing cached for "more
     *  detail". Used for short interjections like the acknowledgement, which
     *  are already one sentence and are not the reply. */
    verbatim = false,
  ): Promise<void> {
    const { tts, ttsMode } = this.resolveTtsMode();
    emit({ type: 'start', tts: ttsMode });

    try {
      const trimmed = text.trim();
      if (!trimmed) {
        emit({ type: 'done' });
        return;
      }
      if (conversationId && !verbatim) this.voiceDigestCache.set(conversationId, trimmed);

      const { speak, finish } = this.makeSpeechEmitter(emit, ttsMode, tts);
      const verbosity = tts?.verbosity ?? 'auto';
      // Deliberately no CLI digest fallback here, unlike /voice/converse.
      // Spawning a coding agent to summarize a chat reply is slow, and its
      // output isn't reliably a summary at all — a permission notice or a
      // refusal gets spoken instead of the answer. When there's no API model
      // to digest with, just read the reply: the full text is already on
      // screen, so a plain reading is never the wrong thing.
      let spokenSentences = 0;
      const countedSpeak = (sentence: string) => { spokenSentences++; speak(sentence); };
      if (!verbatim && needsDigest(trimmed, verbosity)) {
        const streamed = await this.streamVoiceDigest(trimmed, countedSpeak);
        if (!streamed) splitIntoSentences(stripForSpeech(trimmed)).forEach(countedSpeak);
      } else {
        splitIntoSentences(stripForSpeech(trimmed)).forEach(countedSpeak);
      }
      // Silence is this feature's only unrecoverable failure and it leaves
      // nothing on screen to inspect, so record what was actually said.
      this.logger.info(
        `[voice] speak: ${trimmed.length} chars in, tts=${ttsMode}, verbatim=${verbatim}, ${spokenSentences} sentence(s) out`
      );
      if (spokenSentences === 0) {
        this.logger.warn('[voice] speak produced no sentences — nothing will be heard');
      }
      await finish();
    } catch (e) {
      emit({ type: 'error', message: String(e instanceof Error ? e.message : e) });
    }
  }

  /**
   * Runs one voice transcript through the full converse pipeline described
   * in docs/superpowers/specs/voice-converse-spec.md and streams NDJSON
   * events via `emit`. Command match short-circuits (workspace switch /
   * notifications / list workspaces); otherwise the transcript runs through
   * the normal conversation path and the reply is digested + segmented for
   * TTS. Never throws — failures become an `error` event.
   */
  async runVoiceConverse(
    transcript: string,
    conversationId: string | undefined,
    emit: (event: VoiceConverseEvent) => void,
  ): Promise<void> {
    const voiceConfig = this.configManager?.getResolvedVoiceConfig?.();
    const tts = voiceConfig?.tts;
    const ttsMode: 'server' | 'client' = tts?.enabled && tts.provider === 'api' && tts.apiKey ? 'server' : 'client';
    emit({ type: 'start', tts: ttsMode });

    try {
      const { speak, finish } = this.makeSpeechEmitter(emit, ttsMode, tts);

      const command: VoiceCommand | null = parseVoiceCommand(transcript);

      // "More detail" replays the cached pre-digest reply instead of running
      // the agent again — the digest deliberately drops detail, and this is
      // the path that gives it back.
      if (command?.type === 'more-detail') {
        const cached = conversationId ? this.voiceDigestCache.get(conversationId) : undefined;
        if (!cached) {
          const empty = /[一-鿿]/.test(transcript) ? '没有可以展开的内容。' : 'There is nothing to expand on yet.'; // lint-allow-non-english
          emit({ type: 'command', action: 'more-detail', result: empty });
          emit({ type: 'done' });
          return;
        }
        splitIntoSentences(cached).forEach(speak);
        await finish();
        return;
      }

      if (command) {
        let result = '';
        switch (command.type) {
          case 'switch-workspace': {
            const ok = await this.switchWorkspaceByName(command.workspace);
            result = ok ? `已切换到 ${command.workspace}` : `没有找到工作区 ${command.workspace}`; // lint-allow-non-english
            break;
          }
          case 'list-workspaces': {
            const names = this.getWorkspaceList();
            result = names.length > 0 ? `工作区有：${names.join('、')}` : '没有配置任何工作区。'; // lint-allow-non-english
            break;
          }
          case 'list-notifications': {
            result = this.describeUnseenNotifications();
            break;
          }
        }
        emit({ type: 'command', action: command.type, result });
        emit({ type: 'done' });
        return;
      }

      const ackText = this.generateVoiceAck(transcript);
      emit({ type: 'ack', text: ackText });

      const convId = conversationId ?? `voice-${randomUUID()}`;
      const chatId = `voice-${convId}`;
      const message: UserMessage = {
        id: randomUUID(),
        channel: 'voice',
        userId: 'voice-user',
        username: 'Voice',
        chatId,
        text: transcript,
        timestamp: Date.now(),
        conversationId: convId,
      };

      const reply = (await this.getVoiceHandler().runMessage(message)).trim();
      if (!reply) {
        emit({ type: 'error', message: 'No reply was produced for this turn.' });
        return;
      }

      this.voiceDigestCache.set(convId, reply);

      const verbosity = tts?.verbosity ?? 'auto';
      if (needsDigest(reply, verbosity)) {
        // Streaming digest: sentences go to TTS while the rest is still being
        // written, so first-sound latency is one sentence, not the whole
        // summary. Returns false when streaming isn't available at all.
        const streamed = await this.streamVoiceDigest(reply, speak);
        if (!streamed) {
          const digest = await this.runVoiceDigestPrompt(reply);
          splitIntoSentences(digest ?? reply).forEach(speak);
        }
      } else {
        splitIntoSentences(reply).forEach(speak);
      }

      await finish();
    } catch (e) {
      emit({ type: 'error', message: String(e instanceof Error ? e.message : e) });
    }
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

    // Automations: hidden-chat scheduler + engine, wired last so channels/chat
    // manager are already up.
    this.initAutomations();
  }

  /** Base dir mirrors workspace.ts: CODEY_HOME override, else ~/.codey. */
  private codeyHome(): string {
    return process.env.CODEY_HOME ?? path.join(os.homedir(), '.codey');
  }

  private initAutomations(): void {
    const base = this.codeyHome();
    this.automationStore = new AutomationStore(base);
    const role = this.config.automationRole ?? 'daemon';
    this.automationEngine = new AutomationEngine({
      store: this.automationStore,
      lease: new SchedulerLease(path.join(base, 'automation-scheduler.lock'), role),
      runTarget: (a, runId) => this.runAutomationTurn(a, renderBrief(a.brief, a.params), { runId }),
      resumeTarget: (a, answer, runId) => this.runAutomationTurn(a, answer, { resume: true, runId }),
      report: (a, run) => this.deliverAutomationReport(a, run),
      onEvent: (ev) => { try { this.automationEventListener?.(ev); } catch { /* swallow */ } },
      log: (msg) => this.logger.info(`[automations] ${msg}`),
    });
    this.automationEngine.start();
    this.automationDryRuns = new DryRunManager({
      execute: (target, prompt) => this.runDryRunPrompt(target, prompt),
      classify: (output) => classifyDryRun(output, this.getAideOptions()),
      teamContext: (_workspaceName, teamName) => {
        const team = (this.configManager?.getTeams() ?? {})[teamName];
        if (!team) return undefined;
        const members = Array.isArray(team) ? team : team.members;
        const wm = this.workspaceManager.getWorkerManager();
        const personas = members.map(m => {
          const w = wm.getWorker(m);
          return w
            ? `### ${m}\n${w.personality.role}`.trim()
            : `### ${m}\n(worker definition not found)`;
        }).join('\n\n');
        return `Team config:\n${JSON.stringify(team, null, 2)}\n\nWorker roles:\n${personas}`;
      },
      onResult: (automationId, verdict) => this.onDryRunResult(automationId, verdict),
      log: (msg) => this.logger.info(`[automations] ${msg}`),
    });
    this.automationChats = new AutomationChatManager({
      turn: (messages, draft, context) => automationChatTurn(messages, draft, context, this.getAideOptions()),
      context: () => ({
        workspaces: this.getWorkspaceList(),
        teams: Object.keys(this.configManager?.getTeams() ?? {}),
        agents: ['claude-code', 'opencode', 'codex', 'pi'] as CodingAgent[],
        models: (this.configManager?.listModels() ?? this.config.models ?? []).map(m => m.model),
        tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
        nowIso: new Date().toString(),
      }),
    });
  }

  /** The hidden system chat an automation executes in (created lazily). */
  private async ensureAutomationChat(a: Automation): Promise<string> {
    // Automation chats are shared across the daemon and embedded gateways;
    // the in-memory cache may be stale (e.g. the Mac app created the chat
    // after this daemon booted). Re-read from disk before deciding the chat
    // is missing — otherwise we'd create a duplicate and clobber a.chatId.
    if (a.chatId) this.chatManager.reload(a.chatId);
    if (a.chatId && this.chatManager.get(a.chatId)) return a.chatId;
    const selection = a.target.kind === 'team'
      ? { type: 'team' as const, name: a.target.teamName }
      : { type: 'none' as const };
    const chat = this.chatManager.create({
      workspaceName: a.target.workspaceName,
      title: `Automation: ${a.name}`,
      selection,
      kind: 'automation',
      agent: a.target.kind === 'prompt' ? a.target.agent : undefined,
      model: a.target.kind === 'prompt' ? a.target.model : undefined,
    });
    this.automationStore!.update(a.id, { chatId: chat.id }, Date.now());
    return chat.id;
  }

  /**
   * One headless turn: send `text` into the automation's hidden chat with a
   * collecting sink, then decide parked/success from the persisted chat state.
   * Resume is the same call — sendToChat's pendingTeam continuation handles it.
   */
  private async runAutomationTurn(a: Automation, text: string, opts?: { resume?: boolean; runId?: string }): Promise<TargetResult> {
    // Automation chats are shared across the daemon and embedded gateways;
    // the in-memory cache may be stale. Refresh before the pendingTeam
    // handling below — an embedded process resuming a daemon-parked run must
    // see the daemon-persisted pendingTeam, or the answer would be dispatched
    // as a fresh team task (and its persist would clobber the daemon's file).
    if (a.chatId) this.chatManager.reload(a.chatId);
    const chatId = await this.ensureAutomationChat(a);
    // Fresh runs must not inherit a stale pendingTeam: the engine can mark a
    // parked run failed (7-day expiry) or consume it via a failed resume (e.g.
    // sendToChat throws before its own pendingTeam clear) WITHOUT the chat's
    // pause state being cleared. Left in place, the next fresh brief would be
    // treated by sendToChat as the "answer" to that dead question and fed into
    // the team-resume continuation. Resume turns keep it — that continuation
    // IS the resume mechanism.
    if (!opts?.resume && this.chatManager.get(chatId)?.pendingTeam) {
      this.chatManager.setPendingTeam(chatId, null);
    }
    // Headless — the response comes from the return value, but the event
    // stream is the run's activity log (tool calls, worker steps, errors).
    const runId = opts?.runId;
    const sink: ChatStreamSink = runId
      ? (e) => {
          const line = formatRunLogEvent(e, Date.now());
          if (!line) return;
          try { this.automationStore?.appendRunLog(a.id, runId, line); } catch { /* logging must never fail the run */ }
        }
      : () => { /* dry-run and other unlogged turns */ };
    const logSandbox = (detail: string) => {
      this.logger.info(`[automations] ${a.name}: sandbox ${detail}`);
      if (runId) {
        try { this.automationStore?.appendRunLog(a.id, runId, sandboxLogLine(Date.now(), detail)); }
        catch { /* logging must never fail the run */ }
      }
    };
    let parked: ParkedInfo | null = null;
    try {
      // A resume continues the parked run's turn, so it must land in the same
      // checkout that asked the question — provisioning is a fresh-run step.
      if (a.target.sandbox && !opts?.resume) {
        await openSandbox(this.automationSandboxOps(a, chatId, logSandbox), a.name, runId ?? randomUUID());
      }
      const { response } = await this.sendToChat(chatId, text, sink);
      parked = detectParked(this.chatManager.get(chatId), a.target, response);
      return parked ? { output: response, parked } : { output: response };
    } catch (err) {
      return { output: '', error: (err as Error).message };
    } finally {
      // A parked run is still live: its sandbox has to survive until the
      // question is answered (or the parked run expires and the next fresh
      // run replaces the binding).
      if (a.target.sandbox && !parked) await closeSandbox(this.automationSandboxOps(a, chatId, logSandbox));
    }
  }

  private automationSandboxOps(a: Automation, chatId: string, log: (detail: string) => void): SandboxOps {
    return {
      isGitWorkspace: () => isGitWorkspace(this.resolveWorkspaceWorkingDir(a.target.workspaceName)),
      provision: (worktreeName) => provisionChatWorktree({
        workspaceWorkingDir: this.resolveWorkspaceWorkingDir(a.target.workspaceName),
        worktreeName,
      }),
      bind: (workspace) => { this.chatManager.setChatWorkspace(chatId, workspace); },
      current: () => this.chatManager.get(chatId)?.chatWorkspace,
      discard: (workspace) => discardDisposableWorktree(workspace),
      unbind: () => { this.chatManager.clearChatWorkspace(chatId); },
      log,
    };
  }

  /** Post the run summary to report.channel if configured. Returns failure text. */
  private async deliverAutomationReport(a: Automation, run: AutomationRun): Promise<string | undefined> {
    if (!a.report.channel) return undefined;
    const channel = a.report.channel.platform as ChannelType;
    const handler = this.handlers.get(channel);
    if (!handler) return `channel ${a.report.channel.platform} not connected in this process`;
    try {
      await this.sendResponse({ chatId: a.report.channel.target, channel, text: formatRunSummary(a, run) });
      return undefined;
    } catch (err) {
      return (err as Error).message;
    }
  }

  /**
   * One-shot no-act agent run for the authoring dry-run. Deliberately NOT
   * skipPermissions: headless default-deny is the belt to the preamble's
   * suspenders - the agent can read the workspace but a stray write attempt
   * is refused rather than executed.
   */
  private async runDryRunPrompt(target: Automation['target'], prompt: string): Promise<string> {
    const workspaceName = target.workspaceName;
    // workspaceName is LLM output; a hallucinated name must fail visibly
    // (DryRunManager maps the throw to an 'error' verdict) instead of
    // silently dry-running against the gateway's own working dir.
    if (!this.getWorkspaceList().includes(workspaceName)) {
      throw new Error(`Unknown workspace: ${workspaceName}`);
    }
    const workingDir = this.resolveWorkspaceWorkingDir(workspaceName);
    // A prompt automation may override both agent and model. The check must
    // use that same execution configuration or its verdict is misleading.
    // Team checks remain a no-act analysis run with the gateway default; the
    // team definition is already inlined into the prompt above.
    const agent = target.kind === 'prompt' && target.agent ? target.agent : this.getDefaultAgent();
    const model = target.kind === 'prompt' && target.model
      ? this.getModelConfig(agent, target.model)
      : this.getDefaultModelConfig(agent);
    // Plain agentFactory.run, not runWithFallback: fallback churn is not
    // wanted for a background nicety - a failure just becomes an 'error'
    // verdict in the authoring panel.
    const response = await this.agentFactory.run(agent, {
      prompt,
      agent,
      model,
      context: { workingDir },
    });
    if (!response.success) throw new Error(response.error || 'dry-run agent failed');
    return response.output;
  }

  /** Emit an automation event without letting a listener failure escape. */
  private emitAutomationEvent(ev: AutomationEvent): void {
    try { this.automationEventListener?.(ev); }
    catch { /* swallow - listener failures must not break automations */ }
  }

  /** Start an advisory background dry run for an already-persisted automation. */
  private startAutomationCheck(a: Automation): void {
    const check: AutomationCheck = { status: 'pending', at: Date.now() };
    this.automationStore?.setCheck(a.id, check);
    this.emitAutomationEvent({ type: 'automation-check', automationId: a.id, check });
    this.automationDryRuns?.start(a.id, {
      name: a.name, target: a.target, brief: a.brief, params: a.params,
    });
  }

  /** Persist a dry-run verdict and tell the renderer. Purely advisory - the
   *  automation has been saved and runnable since before this started. */
  private onDryRunResult(automationId: string, verdict: DryRunVerdict): void {
    // Deleted while the run was in flight: nothing left to annotate.
    if (!this.automationStore?.get(automationId)) return;
    const check = verdictToCheck(verdict, Date.now());
    this.automationStore.setCheck(automationId, check);
    this.emitAutomationEvent({ type: 'automation-check', automationId, check });
  }

  // ---- Automations public API ----

  listAutomations(): Automation[] { return this.automationStore?.list() ?? []; }
  getAutomation(id: string): Automation | undefined { return this.automationStore?.get(id); }
  createAutomation(draft: Parameters<AutomationStore['create']>[0]): Automation {
    this.validateAutomationTargetReferences(draft.target);
    return this.requireAutomationStore().create(draft, Date.now());
  }
  updateAutomation(id: string, patch: Partial<Automation>): Automation {
    // A target change invalidates the hidden chat: its selection, workspace,
    // and agent/model overrides were frozen at creation from the OLD target.
    // Delete that chat and clear chatId so the next run lazily creates a
    // fresh one matching the new target. (store.update Object.assigns the
    // patch, so chatId becomes undefined and JSON.stringify drops the key
    // from the persisted document.)
    const prev = this.requireAutomationStore().get(id);
    const targetChanged = !!patch.target && JSON.stringify(patch.target) !== JSON.stringify(prev?.target);
    if (patch.target) this.validateAutomationTargetReferences(patch.target);
    if (targetChanged) {
      if (prev?.chatId) {
        // reload first so a chat created by the other process is deletable.
        this.chatManager.reload(prev.chatId);
        try { this.chatManager.delete(prev.chatId); } catch { /* already gone */ }
      }
      patch = { ...patch, chatId: undefined };
    }
    // Renderer edits commonly change only notification policy. Preserve a
    // configured channel instead of replacing the entire report object.
    if (patch.report && prev?.report) patch = { ...patch, report: { ...prev.report, ...patch.report } };
    return this.requireAutomationStore().update(id, patch, Date.now());
  }
  deleteAutomation(id: string): void {
    const a = this.requireAutomationStore().get(id);
    if (!a) throw new Error(`Automation not found: ${id}`);
    this.automationDryRuns?.cancel(id);
    if (a.chatId) {
      this.chatManager.reload(a.chatId);
      try { this.chatManager.delete(a.chatId); } catch { /* already gone */ }
    }
    this.requireAutomationStore().delete(id);
  }
  setAutomationEnabled(id: string, enabled: boolean): Automation {
    return this.requireAutomationStore().setEnabled(id, enabled, Date.now());
  }
  listAutomationRuns(id: string, limit?: number): AutomationRun[] {
    return this.automationStore?.listRuns(id, limit) ?? [];
  }
  markAutomationRunSeen(id: string, runId: string): void {
    this.automationStore?.markSeen(id, runId, Date.now());
  }
  /** Records that an OS notification was fired, so a relaunch inside the
   *  unseen window doesn't announce the same run twice. */
  markAutomationRunNotified(id: string, runId: string): void {
    this.automationStore?.markNotified(id, runId, Date.now());
  }
  /** Per-run activity log (tool calls, worker steps), or undefined if none. */
  getAutomationRunLog(id: string, runId: string): string | undefined {
    return this.automationStore?.readRunLog(id, runId);
  }
  runAutomationNow(id: string): Promise<AutomationRun | null> {
    return this.requireAutomationEngine().runNow(id, 'manual');
  }
  /** Chat this automation's runs execute in (created lazily) — lets the Mac
   *  app open it to monitor a run's progress while it streams. */
  ensureAutomationRunChat(id: string): Promise<string> {
    const a = this.requireAutomationStore().get(id);
    if (!a) throw new Error(`Automation not found: ${id}`);
    return this.ensureAutomationChat(a);
  }
  resumeAutomationRun(id: string, runId: string, answer: string): Promise<AutomationRun> {
    return this.requireAutomationEngine().resume(id, runId, answer);
  }
  startAutomationChat(mode: 'create' | 'edit', automationId?: string): ChatStep {
    const mgr = this.requireAutomationChats();
    if (mode !== 'edit') return mgr.start('create');
    const a = this.requireAutomationStore().get(automationId ?? '');
    if (!a) throw new Error(`Automation not found: ${automationId}`);
    return mgr.start('edit', {
      name: a.name,
      target: a.target,
      schedule: a.schedule,
      notify: a.report.notify,
      brief: a.brief,
      params: a.params,
    }, a.id);
  }
  sendAutomationChat(sessionId: string, text: string): Promise<ChatStep> {
    return this.requireAutomationChats().send(sessionId, text);
  }
  patchAutomationChat(sessionId: string, patch: Parameters<AutomationChatManager['patch']>[1]): ChatStep {
    return this.requireAutomationChats().patch(sessionId, patch);
  }
  saveAutomationChat(sessionId: string): Automation {
    const { mode, sourceAutomationId, draft } = this.requireAutomationChats().finalize(sessionId);
    const payload = {
      name: draft.name!.trim(), target: draft.target!, brief: draft.brief!.trim(),
      params: draft.params ?? {}, schedule: draft.schedule,
      report: { notify: draft.notify ?? 'none' },
    };
    // Read the pre-edit record first: the fingerprint comparison is what keeps
    // a rename or reschedule from costing the user a fresh agent run.
    const prev = mode === 'edit' ? this.automationStore?.get(sourceAutomationId!) : undefined;
    const saved = mode === 'edit'
      ? this.updateAutomation(sourceAutomationId!, payload)
      : this.createAutomation({ ...payload, enabled: true });
    this.cancelAutomationChat(sessionId);
    // Advisory only: the automation is already persisted, so a failure to
    // record or start the check must never surface as a failed save.
    if (needsRecheck(prev, saved)) {
      try { this.startAutomationCheck(saved); }
      catch (err) { this.logger.info(`[automations] could not start check for ${saved.id}: ${(err as Error).message}`); }
    }
    return saved;
  }

  /** Re-arm the advisory dry run for a saved automation (banner "Re-run"). */
  recheckAutomation(id: string): void {
    const a = this.requireAutomationStore().get(id);
    if (!a) throw new Error(`Automation not found: ${id}`);
    this.startAutomationCheck(a);
  }

  /** Clear the advisory check and drop any in-flight verdict (banner "Dismiss"). */
  dismissAutomationCheck(id: string): void {
    this.automationDryRuns?.cancel(id);
    this.requireAutomationStore().setCheck(id, undefined);
    this.emitAutomationEvent({ type: 'automation-check', automationId: id });
  }
  cancelAutomationChat(sessionId: string): void {
    this.automationChats?.cancel(sessionId);
  }
  setAutomationEventListener(fn: (ev: AutomationEvent) => void): void {
    this.automationEventListener = fn;
  }

  private validateAutomationTargetReferences(target: Automation['target']): void {
    if (!this.getWorkspaceList().includes(target.workspaceName)) {
      throw new Error(`Unknown automation workspace: ${target.workspaceName}`);
    }
    if (target.kind === 'team' && !(target.teamName in (this.configManager?.getTeams() ?? {}))) {
      throw new Error(`Unknown automation team: ${target.teamName}`);
    }
  }

  private requireAutomationStore(): AutomationStore {
    if (!this.automationStore) throw new Error('Automations not initialized (gateway not started)');
    return this.automationStore;
  }
  private requireAutomationEngine(): AutomationEngine {
    if (!this.automationEngine) throw new Error('Automations not initialized (gateway not started)');
    return this.automationEngine;
  }
  private requireAutomationChats(): AutomationChatManager {
    if (!this.automationChats) throw new Error('Automations not initialized (gateway not started)');
    return this.automationChats;
  }

  private resolveChatWorkingDir(chat: Chat): string {
    if (chat.executionMode === 'isolated-worktree') {
      const isolatedDir = chat.chatWorkspace?.workingDir;
      if (isolatedDir && fs.existsSync(isolatedDir)) return isolatedDir;
      throw new Error(isolatedDir
        ? `Chat workspace is missing: ${isolatedDir}`
        : `Chat workspace has not been provisioned: ${chat.id}`);
    }
    if (chat.workingDirOverride) {
      if (fs.existsSync(chat.workingDirOverride)) return chat.workingDirOverride;
      throw new Error(`Selected checkout is no longer available: ${chat.workingDirOverride}. Choose another branch or worktree before continuing.`);
    }
    return this.resolveWorkspaceWorkingDir(chat.workspaceName);
  }

  /** workspace.json workingDir if present, else the gateway working dir. */
  private resolveWorkspaceWorkingDir(workspaceName: string): string {
    const workspacesRoot = this.workspaceManager.getWorkspacesRoot();
    const wsConfigPath = path.join(workspacesRoot, workspaceName, 'workspace.json');
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
    // Note: engine.stop() does not await in-flight runs and releases the
    // scheduler lease immediately (accepted v1 risk).
    this.automationEngine?.stop();
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
      const pendingSkillEntry = this.pendingSkillSuggestions.get(pendingSkillKey);
      if (pendingSkillEntry && !pending && !isSlash) {
        const pendingSkill = pendingSkillEntry.suggestion;
        const reply = message.text.trim().toLowerCase();
        const renameMatch = reply.match(/^rename\s+([a-z][a-z0-9-]{2,29})$/);
        if (reply === 'yes' || renameMatch) {
          // Save into the workspace the suggestion was distilled in — the
          // active workspace may have changed since it was surfaced.
          const store = await this.resolveSkillStore(pendingSkillEntry.workspaceName);
          const name = renameMatch ? renameMatch[1] : pendingSkill.name;
          if (renameMatch && store.get(name)) {
            // Keep the suggestion pending so the user can pick another name.
            await this.sendResponse({
              chatId: message.chatId,
              channel: message.channel,
              text: `A skill named "${name}" already exists. Reply "rename <different-name>", "yes", or "no".`,
            });
            return;
          }
          store.add({
            name,
            description: pendingSkill.description,
            whenToUse: pendingSkill.whenToUse,
            steps: pendingSkill.steps,
            sourceRunId: 'user-confirmed',
            // If this upserts an existing skill (evolving its steps), record
            // what the user confirmed as the evolution's trigger.
            trigger: { runId: 'user-confirmed', promptSummary: pendingSkill.description },
            // Present only when the suggestion came from an induced template.
            parameters: pendingSkill.parameters,
            inducedFrom: pendingSkill.inducedFrom,
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
          const store = await this.resolveSkillStore(pendingSkillEntry.workspaceName);
          store.rejectSuggestion(pendingSkill.name, pendingSkill.description);
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
        // Skills are per-workspace: for a channel linked to a Codey chat, look
        // up the CHAT's workspace, not whichever workspace is loaded.
        const store = await this.resolveSkillStore(this.linkedChatWorkspaceName(message));
        const skill = store.getActive().find(s => s.name === name);
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
      browserTools: true,
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
      // What the run DID — the procedure clustering and the distiller work on.
      // Argument VALUES stay here; only their shapes reach the trace file.
      const steps = stepsFrom(meta.toolCalls);
      const trace: RunTrace = {
        runId: `solo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        promptSummary: parsed.prompt.slice(0, 200),
        outputPreview: (response.output || '').slice(0, 300),
        steps,
        toolSequence: steps.map(s => s.tool),
        timestamp: Date.now(),
        mode: 'solo',
      };
      // Capture the store and workspace NOW — the pass is fire-and-forget, so
      // a workspace switch before it runs must not redirect skill state.
      const runWorkspace = this.workspaceManager.getCurrentWorkspace();
      // afterRunSkillPass never rejects (stage-isolated try/catch inside).
      void this.afterRunSkillPass({
        trace,
        appliedSkill,
        clean: response.success,
        store: this.workspaceManager.getSkillStore(),
        // Mirror the chat surface: a turn that ended with the agent asking the
        // user a question must not get a suggestion stacked on top — the
        // user's "yes" would resolve the suggestion instead of the question.
        suppressSuggestion: !!response.userQuestion,
        notify: (text) => this.sendResponse({ chatId, channel, text }),
        setPending: (s) => this.pendingSkillSuggestions.set(
          `${channel}:${chatId}`, { suggestion: s, workspaceName: runWorkspace }),
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
      case 'effort':
        await this.cmdEffort(args, chatId, channel);
        break;
      case 'agent':
        await this.cmdAgent(args, chatId, channel);
        if (this.isPairableChannel(channel) && args.length > 0) {
          const a = args[0].toLowerCase();
          if (['claude-code', 'opencode', 'codex', 'pi'].includes(a)) {
            this.pairingStore.updatePrefs(channel, message.userId, { agent: a as 'claude-code' | 'opencode' | 'codex' | 'pi' });
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
        await this.cmdSkills(chatId, channel, this.linkedChatWorkspaceName(message));
        break;
      case 'skill': {
        // Bare `/skill` or `/skill <name>` without a task — surface usage
        // instead of silently swallowing the command.
        await this.sendResponse({ chatId, channel,
          text: 'Usage: /skill <name> <task> — run a task with a saved skill.\nAlso: /skill forget|restore|rollback|history <name>, /skills to list skills.' });
        break;
      }
      case 'skill-forget': {
        const store = await this.resolveSkillStore(this.linkedChatWorkspaceName(message));
        const ok = store.archive(args[0]);
        await this.sendResponse({ chatId, channel,
          text: ok ? `🗑️ Skill **${args[0]}** archived. Restore with /skill restore ${args[0]}` : `Skill "${args[0]}" not found.` });
        break;
      }
      case 'skill-restore': {
        const store = await this.resolveSkillStore(this.linkedChatWorkspaceName(message));
        const ok = store.restore(args[0]);
        await this.sendResponse({ chatId, channel,
          text: ok ? `🔄 Skill **${args[0]}** restored.` : `Skill "${args[0]}" not found.` });
        break;
      }
      case 'skill-rollback': {
        const store = await this.resolveSkillStore(this.linkedChatWorkspaceName(message));
        const ok = store.rollback(args[0]);
        const v = store.get(args[0])?.version;
        await this.sendResponse({ chatId, channel,
          text: ok ? `⏪ Skill **${args[0]}** rolled back to v${v}.` : `Skill "${args[0]}" has no prior version (or was not found).` });
        break;
      }
      case 'skill-history': {
        const store = await this.resolveSkillStore(this.linkedChatWorkspaceName(message));
        await this.cmdSkillHistory(chatId, channel, store, args[0]);
        break;
      }
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

  /**
   * Show, set, or clear the reasoning effort for the current default agent.
   * Chat platforms have no Chat record, so the per-chat override tier is not
   * reachable here — like /agent, this writes the global per-agent default.
   */
  private async cmdEffort(args: string[], chatId: string, channel: ChannelType): Promise<void> {
    const agent = this.getDefaultAgent() as CodingAgent;
    const current = this.getDefaultEffort(agent);

    if (args.length === 0) {
      await this.sendResponse({
        chatId,
        channel,
        text: `Current effort for **${agent}**: ${current}\n\n` +
          `Set with: /effort <low|medium|high|xhigh|max>\nClear with: /effort clear`,
      });
      return;
    }

    const raw = args[0].toLowerCase();
    if (raw === 'clear') {
      this.configManager?.setAgentDefaultEffort(agent, undefined);
      await this.sendResponse({
        chatId,
        channel,
        text: `✅ Reset effort for **${agent}** to **${DEFAULT_THINKING_EFFORT}**.`,
      });
      return;
    }

    if (!isThinkingEffort(raw)) {
      await this.sendResponse({
        chatId,
        channel,
        text: `Unknown effort: ${raw}\n\nAvailable: low, medium, high, xhigh, max`,
      });
      return;
    }

    this.configManager?.setAgentDefaultEffort(agent, raw);
    await this.sendResponse({
      chatId,
      channel,
      text: `✅ Effort for **${agent}** set to **${raw}**.`,
    });
  }

  private async cmdAgent(args: string[], chatId: string, channel: ChannelType): Promise<void> {
    if (args.length > 0) {
      const agentName = args[0].toLowerCase();
      const validAgents: CodingAgent[] = ['claude-code', 'opencode', 'codex', 'pi'];
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
          text: `Unknown agent: ${agentName}\n\nAvailable: claude-code, opencode, codex, pi`,
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

  private async cmdSkillHistory(chatId: string, channel: ChannelType, store: SkillStore, name: string): Promise<void> {
    const skill = store.get(name);
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

  private async cmdSkills(chatId: string, channel: ChannelType, workspaceName?: string): Promise<void> {
    const store = await this.resolveSkillStore(workspaceName);
    const active = store.getActive();
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
      agent,
      model: resolved,
      // Same plain-runner convention as the Advisor/Aide: bounded, tool-less,
      // and never with permissions skipped — crystallizer prompts embed user
      // text and agent output, so they must not reach a tool-capable session.
      runner: this.advisorRunner,
      logger: this.logger,
    };
  }

  /** Skills are per-workspace state. Resolve the store for a NAMED workspace
   *  (a chat's binding), falling back to the active workspace's store when no
   *  name is given or the lookup fails. */
  private async resolveSkillStore(workspaceName?: string): Promise<SkillStore> {
    if (workspaceName) {
      try {
        return await this.workspaceManager.getSkillStoreFor(workspaceName);
      } catch (err) {
        this.logger.warn(`[skills] store for workspace "${workspaceName}" unavailable — using active workspace: ${(err as Error).message}`);
      }
    }
    return this.workspaceManager.getSkillStore();
  }

  /** Workspace of the Codey chat linked to a channel message, if any. */
  private linkedChatWorkspaceName(message: UserMessage): string | undefined {
    const codeyChatId = this.resolveChatId(message.channel as ChannelType, message.userId);
    return codeyChatId ? this.chatManager.get(codeyChatId)?.workspaceName : undefined;
  }

  /** Procedure clustering, observation only — it proposes nothing and changes
   *  no behavior. Its thresholds are guesses with no ground truth behind them,
   *  so it runs in log-only mode until there are real traces to fit them
   *  against. Pure computation over at most RECENT_TRACES_MAX traces.
   *  See docs/superpowers/specs/2026-07-28-playbook-induction-design.md. */
  private logProcedureClusters(store: SkillStore, minMembers: number): ClusterReport | null {
    try {
      const traces = store.getRecentTraces(RECENT_TRACES_MAX);
      const report = clusterProcedures(traces, { minMembers });
      if (report.clusters.length === 0) {
        this.logger.debug(
          `[skills] induction: no cluster — ${report.withoutSteps} without steps, ` +
          `${report.tooShort} too short, ${report.tooFewMembers} not recurring yet, ` +
          `${report.rejectedByDistinctiveness} too generic`);
        return report;
      }
      for (const cluster of report.clusters) {
        this.logger.info(
          `[skills] induction: clustered ${cluster.runIds.length} run(s) — ` +
          `${cluster.signature.join(' → ')} (distinctiveness ${cluster.distinctiveness.toFixed(2)}, ` +
          `score ${cluster.score.toFixed(2)})`);
      }
      return report;
    } catch (err) {
      this.logger.warn(`[skills] induction pass failed: ${err}`);
      return null;
    }
  }

  /** Turn the winning cluster into a named, parameterized suggestion. Returns
   *  null whenever induction has nothing to offer, so the caller falls back to
   *  prose distillation. */
  private async induceSuggestion(
    store: SkillStore,
    cluster: ProcedureCluster,
  ): Promise<DistillResult | 'duplicate' | null> {
    const byId = new Map(store.getRecentTraces(RECENT_TRACES_MAX).map(t => [t.runId, t]));
    const members = cluster.runIds.map(id => byId.get(id)).filter((t): t is RunTrace => !!t);
    const template = induceTemplate(members);
    if (!template) {
      this.logger.debug('[skills] induction: cluster produced no template');
      return null;
    }
    return nameTemplate(this.getSkillDistillDeps(), template, store.getAll(), store.getRejected());
  }

  /** Shared post-run skill pass for both surfaces. Never rejects — every LLM
   *  stage is isolated in its own try/catch so call sites can be a bare
   *  `void this.afterRunSkillPass(...)` without a `.catch`. */
  private async afterRunSkillPass(opts: {
    trace: RunTrace;
    appliedSkill: SkillEntry | null;
    clean: boolean;
    /** The run's workspace-scoped skill store, resolved by the caller (the
     *  chat's workspace when the run had a chat binding, else the active one). */
    store: SkillStore;
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
      const store = opts.store;

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

      // A turn that neither said nor did anything ("ok", "2") is noise that
      // pushes real procedures out of the small trace window. Tool activity
      // overrides this — see isLowSignalTrace.
      if (isLowSignalTrace(opts.trace)) {
        this.logger.debug(`[skills] trace skipped — continuation turn: "${opts.trace.promptSummary.slice(0, 40)}"`);
        return;
      }

      store.recordTrace(opts.trace);
      const clusterReport = this.logProcedureClusters(store, cfg.suggestOnRepeat);

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
        if (now - this.lastSkillDistillTime <= Codey.SKILL_DISTILL_COOLDOWN_MS) {
          this.logger.debug('[skills] distill skipped — cooldown');
        } else {
          const recent = store.getRecentTraces(cfg.suggestOnRepeat + 5);
          // Nothing to distill yet — skip WITHOUT consuming the cooldown.
          if (recent.length < cfg.suggestOnRepeat) {
            this.logger.debug(`[skills] distill skipped — ${recent.length}/${cfg.suggestOnRepeat} traces`);
            return;
          }
          this.lastSkillDistillTime = now;
          // A clustered procedure is evidence; a prose pattern is an
          // impression. When induction has something to say, it is the only
          // one that speaks — including when what it says is "already a skill"
          // or "I couldn't name it", both of which mean stay quiet and retry
          // on the next window rather than propose something unrelated.
          let candidate: DistillResult | null = null;
          if (cfg.induction && clusterReport?.clusters.length) {
            const induced = await this.induceSuggestion(store, clusterReport.clusters[0]);
            if (induced === 'duplicate' || induced === null) return;
            candidate = induced;
          } else {
            // Prose distillation is for runs induction CANNOT see: no tool
            // activity anywhere in the window. When procedures were observed
            // and clustering declined them — too short, too generic, not
            // recurring yet — that decision stands. Falling through here would
            // let the distiller re-propose exactly what the distinctiveness
            // gate just rejected ("read a file, then edit it").
            if (cfg.induction && clusterReport && hasProcedureData(clusterReport)) {
              this.logger.debug('[skills] distill skipped — procedures observed but none clustered');
              return;
            }
            candidate = await distillCandidate(
              this.getSkillDistillDeps(), recent, store.getAll(), store.getRejected(), cfg.suggestOnRepeat,
            );
          }
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
    const chat = await this.createChat({ workspaceName: workspace, title });
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
/effort <level> - Set reasoning effort (low/medium/high/xhigh/max)
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
    const enabledAgents: CodingAgent[] = ['claude-code', 'opencode', 'codex', 'pi'];

    // Run all agents in parallel (with per-agent fallback)
    const results = await Promise.allSettled(
      enabledAgents.map(agent =>
        this.runWithFallback(agent, {
          prompt,
          agent,
          model: this.getDefaultModelConfig(agent),
          context: { workingDir: this.workingDir },
          browserTools: true,
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
    onStepDone?: (d: { step: number; worker: string; failed: boolean; error?: string }) => void,
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
        onStepDone?.({ step, worker: turnNext, failed: true, error: response.error });
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

    // Sequential/graph teams may answer a simple informational question with
    // one worker. The routing gate fails closed to the full workflow, and
    // `--all` always bypasses it.
    if (dispatch === 'all' && !opts.forceAll) {
      const fastPath = await this.decideSequentialFastPath(members, task, this.workingDir);
      if (fastPath.route === 'single_worker') {
        await this.sendResponse({
          chatId,
          channel,
          text: `Direct answer via **${fastPath.worker}** — ${fastPath.reason}`,
        });
        const directEmitter = new ChannelEmitter((r) => this.sendResponse(r), handler?.streamText ? (t: string) => handler.streamText!(t) : undefined, message.chatId, message.channel);
        await this.runAllMembersInOrder(directEmitter, message.chatId, baseConv, teamName, [fastPath.worker], task, runOneWorker, { teamTurnId: turnTeamTurnId });
        return;
      }
    }

    // dispatch === 'all' OR forceAll: full workflow path
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
    const nextResumeStep = Math.max(
      0,
      ...(this.chatManager.get(chatId)?.messages
        .filter(message => message.teamTurnId === pending.teamTurnId)
        .map(message => message.step ?? 0) ?? []),
    ) + 1;
    const recordResumeFailure = (worker: string, reason: string) => {
      emitter.beginWorker?.({ step: nextResumeStep, worker });
      emitter.endWorker?.('failed', { failureReason: reason });
    };
    const team = this.workspaceManager.getTeam(pending.teamName);
    if (!team) {
      recordResumeFailure('Team', `Team "${pending.teamName}" no longer exists`);
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
      emitter.beginWorker?.({ step: nextResumeStep, worker: memberName, agent: codingAgent, model: modelConfig?.model });
      const response = await runOneWorker(memberName, reprompt, codingAgent, modelConfig, blackboard);
      if (!response.success) {
        emitter.endWorker?.('failed', { failureReason: response.error ?? 'Worker failed without an error message' });
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
        emitter.endWorker?.('askedUser', { nextUserAction: { text: ask.question, options: ask.options } });
        return emitter.transcript;
      }
      emitter.endWorker?.('done');
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
        { startIndex: pending.memberIndex + 1, startStep: nextResumeStep + 1, startCarry: carryForNext, priorResults, blackboard, conversationId: teamConv, teamTurnId: pending.teamTurnId },
      );
      return emitter.transcript;
    }

    if (pending.mode === 'graph') {
      if (!team.graph) {
        recordResumeFailure('Team', `Team "${pending.teamName}" no longer has a flow graph`);
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
      recordResumeFailure('Advisor', turn.fallbackReason ?? 'Advisor failed without an error message');
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
    emitter.beginWorker?.({ step: nextResumeStep, worker: turn.next, reason: turn.reason, agent: codingAgent, model: modelConfig?.model });
    const response = await runOneWorker(turn.next, stepPrompt, codingAgent, modelConfig, resumeBoardForPrompt);
    if (!response.success) {
      emitter.endWorker?.('failed', { failureReason: response.error ?? 'Worker failed without an error message' });
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
      emitter.endWorker?.('askedUser', { nextUserAction: { text: ask.question, options: ask.options } });
      return emitter.transcript;
    }
    emitter.endWorker?.('done');
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
    opts: { startIndex?: number; startStep?: number; startCarry?: string; priorResults?: string[]; blackboard?: TeamBlackboard; conversationId?: string; signal?: AbortSignal; fallbackAgent?: CodingAgent; fallbackModel?: ModelConfig; teamTurnId?: string; firstReason?: string } = {},
  ): Promise<{ thinkingByStep: Record<number, string> }> {
    const workerManager = this.workspaceManager.getWorkerManager();
    const results: string[] = opts.priorResults ? [...opts.priorResults] : [];
    let currentTask = opts.startCarry ?? task;
    const blackboard = opts.blackboard ?? new TeamBlackboard();
    const thinkingByStep: Record<number, string> = {};
    const teamConv = opts.conversationId
      ?? this.workerConversationId(convBase, { team: teamName });
    let executionStep = opts.startStep ?? ((opts.startIndex ?? 0) + 1);

    for (let i = opts.startIndex ?? 0; i < members.length; i++) {
      if (opts.signal?.aborted) break;
      const memberName = members[i];
      const worker = workerManager.getWorker(memberName);
      if (!worker) {
        emitter.beginWorker?.({ step: executionStep, worker: memberName });
        results.push(`**${memberName}**: ❌ not found in global library`);
        emitter.endWorker?.('failed', { failureReason: `Worker "${memberName}" was not found` });
        break;
      }
      const codingAgent = (workerManager.getWorkerCodingAgent(memberName) ?? opts.fallbackAgent ?? this.getDefaultAgent()) as CodingAgent;
      const wmModel = workerManager.getWorkerModel(memberName);
      const modelConfig = wmModel ? this.getModelConfig(codingAgent, wmModel) : (opts.fallbackModel ?? this.getDefaultModelConfig(codingAgent));
      await emitter.status(`🔄 Worker **${worker.name}** is working...`);
      emitter.beginWorker?.({ step: executionStep, worker: worker.name, reason: i === (opts.startIndex ?? 0) ? opts.firstReason : undefined, agent: codingAgent, model: modelConfig?.model });
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
      const response = await runOneWorker(memberName, prompt, codingAgent, modelConfig, blackboard, (t) => emitter.onThinking(t, executionStep));
      if (!response.success) {
        results.push(`**${worker.name}**: ❌ Failed - ${response.error}`);
        emitter.endWorker?.('failed', { failureReason: response.error ?? 'Worker failed without an error message' });
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
        emitter.endWorker?.('askedUser', { nextUserAction: { text: ask.question, options: ask.options } });
        return { thinkingByStep };
      }
      results.push(`**${worker.name}**: ${cleanOutput}`);
      emitter.endWorker?.('done');
      executionStep++;
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
    let stepIndex = Math.max(
      0,
      ...(this.chatManager.get(chatId)?.messages
        .filter(message => message.teamTurnId === teamTurnId)
        .map(message => message.step ?? 0) ?? []),
    );
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
      if (!worker) {
        emitter.beginWorker?.({ step: stepIndex + 1, worker: workerName });
        results.push(`**${workerName}**: ❌ not found`);
        emitter.endWorker?.('failed', { failureReason: `Worker "${workerName}" was not found` });
        break;
      }

      const codingAgent = (wm.getWorkerCodingAgent(workerName) ?? opts?.fallbackAgent ?? this.getDefaultAgent()) as CodingAgent;
      const wmModel = wm.getWorkerModel(workerName);
      const modelConfig = wmModel
        ? this.getModelConfig(codingAgent, wmModel)
        : (opts?.fallbackModel ?? this.getDefaultModelConfig(codingAgent));
      await emitter.status(`🔄 Step ${++stepIndex}: **${worker.name}** is working...`);
      emitter.beginWorker?.({ step: stepIndex, worker: worker.name, agent: codingAgent, model: modelConfig?.model });

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
      if (!resp.success) { results.push(`**${worker.name}**: ❌ Failed - ${resp.error}`); emitter.endWorker?.('failed', { failureReason: resp.error ?? 'Worker failed without an error message' }); break; }

      const ingested = blackboard.ingest(workerName, stepIndex, resp.output);
      results.push(`**${worker.name}**:\n${ingested.stripped}`);
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
        emitter.endWorker?.('askedUser', { nextUserAction: { text: ask.question, options: ask.options } });
        return emitter.transcript;
      }

      emitter.endWorker?.('done');

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
    opts: { forceAll?: boolean; routingTask?: string } = {},
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
        browserChatId: chatId,
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

    // Sequential and authored-graph teams normally run their full workflow.
    // A conservative Advisor gate may route a genuinely simple informational
    // question to one suitable worker; failures and uncertainty fall through
    // to the complete flow. `--all` remains the explicit bypass.
    if (team.dispatch === 'all' && !opts.forceAll) {
      const fastPath = await this.decideSequentialFastPath(team.members, opts.routingTask ?? prompt, workingDir, signal);
      if (fastPath.route === 'single_worker' && !signal?.aborted) {
        const emitter = new ChatEmitter(sink, chatId, workerMsgs);
        const result = await this.runAllMembersInOrder(
          emitter,
          chatId,
          baseConv,
          teamName,
          [fastPath.worker],
          prompt,
          runOneWorker,
          {
            signal,
            fallbackAgent: chatAgent,
            fallbackModel: chatModel,
            teamTurnId,
            firstReason: `Direct-answer fast path: ${fastPath.reason}`,
          },
        );
        return { response: emitter.transcript, choices: emitter.choices, thinkingByStep: result.thinkingByStep, teamTurnId };
      }
    }

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
      workerMsgs.teamStart(team.members.map((w, i) => ({
        step: i + 1,
        worker: w,
        agent: chatAgent ?? this.getDefaultAgent() as CodingAgent,
        model: (chatModel ?? this.getDefaultModelConfig(chatAgent ?? this.getDefaultAgent() as CodingAgent))?.model,
      })));
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
          // Effort follows agent/model: this path already honours the chat's
          // agent and model, so it honours the chat's effort too. The worker
          // tier is deliberately skipped here — parallel mode runs every member
          // on the chat's agent/model rather than per-worker config, so mixing
          // in a per-worker effort would contradict that. Global default still
          // fills in via runWithFallback when the chat has no override.
          effort: resolveEffort({ chat: chat.effort }),
          context: { workingDir },
          browserTools: true,
          browserChatId: chatId,
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
          const completedNormally = ev.reason === 'consensus';
          for (const worker of team.members) {
            workerMsgs.endWorker(
              completedNormally ? 'done' : 'failed',
              completedNormally ? undefined : { failureReason: `Parallel discussion ended: ${ev.reason}` },
              worker,
            );
          }
          const c = this.chatManager.get(chat.id);
          if (c) {
            c.discussion = { teamName, status: 'done', startedAt: c.discussion?.startedAt ?? Date.now(), terminatedReason: ev.reason };
            (c as any).updatedAt = Date.now();
          }
          this.persistDiscussionSummary(teamName, prompt, ev);
          void sink({ type: 'stream', chatId, token: this.formatParallelFinal(ev, teamName) });
        },
        onWorkerDone: (worker, ok, error) => workerMsgs.endWorker(
          ok ? 'done' : 'failed',
          ok ? undefined : { failureReason: error ?? 'Worker failed without an error message' },
          worker,
        ),
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
            const wm = this.workspaceManager.getWorkerManager();
            const workerAgent = (wm.getWorkerCodingAgent(msg.worker) ?? chatAgent ?? this.getDefaultAgent()) as CodingAgent;
            const workerModelName = wm.getWorkerModel(msg.worker);
            const workerModel = workerModelName
              ? this.getModelConfig(workerAgent, workerModelName)
              : (chatModel ?? this.getDefaultModelConfig(workerAgent));
            workerMsgs.beginWorker({
              step: msg.step,
              worker: msg.worker,
              reason: msg.reason,
              agent: workerAgent,
              model: workerModel?.model,
            });
          } else {
            sink({ type: 'info', chatId, message: msg.summary });
          }
        },
        runOneWorker,
        (d) => workerMsgs.endWorker(d.failed ? 'failed' : 'done', d.failed ? { failureReason: d.error ?? 'Worker failed without an error message' } : undefined),
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
        const askingMessage = this.chatManager.get(chatId)?.messages
          .filter(message => message.teamTurnId === teamTurnId && message.worker === p.askingWorker)
          .pop();
        if (askingMessage) {
          this.chatManager.updateMessage(chatId, askingMessage.id, {
            workerStatus: 'askedUser',
            workerNextUserAction: { text: p.question, options: p.options },
          });
          sink({ type: 'worker_end', chatId, messageId: askingMessage.id, step: askingMessage.step ?? p.step, status: 'askedUser' });
        }
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
      
      // /skill forget|restore|rollback|history <name>
      const skillSubMatch = text.match(/^\/skill\s+(forget|restore|rollback|history)\s+(\S+)/i);
      if (skillSubMatch) {
        return {
          command: `skill-${skillSubMatch[1].toLowerCase()}`,
          // Skill names are stored lowercase (invoke/rename lowercase too).
          args: [skillSubMatch[2].toLowerCase()],
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
      const promptMatch = text.match(/\/agent\s+(claude-code|opencode|codex|pi)\s+(.+)/i);
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
    const agentMatch = text.match(/\/agent\s+(claude-code|opencode|codex|pi)/i);
    const agent = (agentMatch ? agentMatch[1] : this.getDefaultAgent()) as CodingAgent;

    const modelMatch = text.match(/\/model\s+(\S+)/i);
    let model: ModelConfig | undefined;
    if (modelMatch) {
      model = this.getModelConfig(agent, modelMatch[1]);
    }

    // Remove inline commands from prompt, but preserve the rest
    let prompt = text
      .replace(/\/agent\s+(claude-code|opencode|codex|pi)\s*/i, '')
      .replace(/\/model\s+\S+\s*/i, '')
      .replace(/^\/(help|status|clear|reset|model|agents|config)\s*/i, '')
      .trim();

    return { command: '', args: [], agent, model, prompt };
  }

  private static readonly ALL_AGENTS: CodingAgent[] = ['claude-code', 'opencode', 'codex', 'pi'];

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

  private async waitForNetworkRetry(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return;
    await new Promise<void>(resolve => {
      const timer = setTimeout(done, ms);
      const onAbort = () => done();
      function done() {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  private async runAgentWithNetworkRetry(agent: CodingAgent, request: AgentRequest): Promise<AgentResponse> {
    let response = await this.agentFactory.run(agent, request);
    for (let retry = 1; retry <= MAX_NETWORK_RETRIES; retry++) {
      if (request.signal?.aborted || !isRetryableNetworkFailure(response)) break;
      // 1s, 2s, 4s, 8s, 8s: enough breathing room for transient outages
      // without leaving the chat apparently frozen for a long time.
      const delayMs = Math.min(1000 * 2 ** (retry - 1), 8000);
      const message = `Network error — retrying ${retry}/${MAX_NETWORK_RETRIES} in ${delayMs / 1000}s`;
      this.logger.warn(`${agent}: ${message}`);
      request.onStatus?.({ type: 'info', message });
      await this.waitForNetworkRetry(delayMs, request.signal);
      if (request.signal?.aborted) break;
      response = await this.agentFactory.run(agent, request);
    }
    return response;
  }

  private async runWithFallback(agent: CodingAgent, request: AgentRequest): Promise<AgentResponse> {
    // Global tier: any caller that didn't set an explicit chat/worker effort
    // inherits the agent's configured default. Applied here rather than at each
    // of the ~20 call sites.
    if (request.effort === undefined) {
      request = { ...request, effort: this.getDefaultEffort(agent) };
    }
    const response = await this.runAgentWithNetworkRetry(agent, request);
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
      const fallbackResponse = await this.runAgentWithNetworkRetry(entry.agent, {
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
        fallbackResponse.fallback = { from: fromLabel, to: label, reason: summarizeFailure(response) };
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

  /**
   * Emit `unwiredAllModelWarning` at most once per model per process.
   * getModelConfig runs on every turn and every fallback resolution, so a
   * per-turn line would bury the rest of the log.
   */
  private warnUnwiredAllModel(model: ModelConfig, keyRef?: string): void {
    const warning = unwiredAllModelWarning(model, keyRef);
    if (!warning || this.warnedUnwiredModels.has(model.model)) return;
    this.warnedUnwiredModels.add(model.model);
    this.logger.warn(warning);
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
      const bound = bindModelToApiKey(catalogEntry, apiKey);
      this.warnUnwiredAllModel(bound, catalogEntry.apiKeyRef);
      return bound;
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
      browserTools: true,
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
    let chat = this.chatManager.get(chatId);
    if (!chat) throw new Error(`Chat not found: ${chatId}`);
    if (chat.executionMode === 'isolated-worktree') {
      chat = chat.chatWorkspace
        ? await this.ensureChatWorkspace(chatId)
        : this.chatManager.setExecutionMode(chatId, 'shared-checkout');
    }

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
    workingDir = this.resolveChatWorkingDir(chat);

    // Aide agent/model if configured, else the chat's effective agent/model.
    const aideCfg = this.config.aide;
    let agent: CodingAgent;
    let model: ModelConfig | undefined;
    let effort: ThinkingEffort | undefined;
    try {
      if (aideCfg?.agent || aideCfg?.model) {
        ({ agent, model } = this.getAideAgentAndModel());
        // Deliberately no chat effort here: the Aide override replaces agent AND
        // model wholesale, so the chat's tier would land on a model picked for
        // speed. Left undefined so runWithFallback applies the Aide agent's own
        // configured default instead.
        effort = undefined;
      } else {
        agent = (chat.agent ?? this.getDefaultAgent()) as CodingAgent;
        effort = resolveEffort({ chat: chat.effort });
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
        // The tool name drives the UI's activity word ("Reading", "Searching");
        // some adapters send it with no human-readable message at all.
        if (parsed?.message || parsed?.tool) {
          sink({
            type: 'tool',
            chatId,
            message: parsed.message ? String(parsed.message) : '',
            tool: parsed.tool ? String(parsed.tool) : undefined,
          });
        }
      } catch { /* non-JSON status */ }
    };

    try {
      const response = await this.runWithFallback(agent, {
        prompt,
        agent,
        model,
        effort,
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
    let chat = this.chatManager.get(chatId);
    if (!chat) throw new Error(`Chat not found: ${chatId}`);
    let workspaceAdoptedBeforeTurn = false;
    // Recover a checkout created during a previous interrupted turn before
    // selecting this turn's cwd.
    if (!chat.chatWorkspace) {
      const adopted = await this.adoptAgentCreatedWorktree(chatId);
      if (adopted) {
        chat = adopted;
        workspaceAdoptedBeforeTurn = true;
      }
    }
    if (chat.executionMode === 'isolated-worktree') {
      chat = chat.chatWorkspace
        ? await this.ensureChatWorkspace(chatId)
        : this.chatManager.setExecutionMode(chatId, 'shared-checkout');
    }

    // Resolvable copy of the incoming text. A digit reply to a paused team is
    // rewritten to the chosen option's text BEFORE it is persisted as the user
    // message and handed to the resume path.
    let userText = userTextParam;

    // Detect a paused team or a structured choice from the last normal-chat
    // response. A digit reply must be resolved here as well as in the channel
    // handler: Mac-origin turns call sendToChat directly and bypass
    // handleMessage's choice mapping.
    const pendingTeam = chat.pendingTeam;
    // A channel-origin explicit `/skill` invoke arrives with userText already
    // rewritten to the raw task (handleMessage stripped the slash), so count
    // it as a slash turn here: it must cancel a paused team like any other
    // slash command — NOT be delivered as the answer to the paused worker.
    const isSlashTurn = userText.trimStart().startsWith('/') || !!origin?.skillInvoke;
    if (pendingTeam) {
      if (isSlashTurn) {
        this.chatManager.setPendingTeam(chatId, null);
      } else if (pendingTeam.options && pendingTeam.options.length > 0) {
        const resolved = resolveChoiceDigit(userText, pendingTeam.options);
        if (resolved !== null) userText = resolved;
      }
    } else if (!isSlashTurn && chat.lastAskedOptions?.options.length) {
      const resolved = resolveChoiceDigit(userText, chat.lastAskedOptions.options);
      if (resolved !== null) userText = resolved;
    }

    // A structured choice applies to exactly one subsequent user message,
    // whether it came from a channel or the Mac app.
    if (chat.lastAskedOptions) {
      this.chatManager.clearLastAskedOptions(chatId);
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
    if (workspaceAdoptedBeforeTurn) sink({ type: 'workspace_ready', chatId });

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
    // Automation chats never resolve suggestions: an unattended brief starting
    // with "yes"/"no" must not be consumed as a suggestion reply.
    if (chat.pendingSkillSuggestion && !isSlashTurn && !pendingTeam && chat.kind !== 'automation') {
      const s = chat.pendingSkillSuggestion;
      const reply = userText.trim().toLowerCase();
      const renameMatch = reply.match(/^rename\s+([a-z][a-z0-9-]{2,29})$/);
      if (reply === 'yes' || reply === 'no' || renameMatch) {
        // Skills are per-workspace: use the CHAT's workspace store.
        const store = await this.resolveSkillStore(chat.workspaceName);
        let responseText: string;
        if (reply === 'no') {
          store.rejectSuggestion(s.name, s.description);
          responseText = `Got it — I won't suggest "${s.name}" again.`;
        } else {
          const name = renameMatch ? renameMatch[1] : s.name;
          if (renameMatch && store.get(name)) {
            // Keep the suggestion pending so the user can pick another name.
            return finishSkillReply(`A skill named "${name}" already exists. Reply "rename <different-name>", "yes", or "no".`);
          }
          store.add({ name, description: s.description, whenToUse: s.whenToUse,
                      steps: s.steps, sourceRunId: 'user-confirmed',
                      // If this upserts an existing skill (evolving its steps),
                      // record what the user confirmed as the trigger.
                      trigger: { runId: 'user-confirmed', promptSummary: s.description },
                      // Present only when the suggestion came from an induced template.
                      parameters: s.parameters, inducedFrom: s.inducedFrom });
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
        // Skills are per-workspace: use the CHAT's workspace store.
        const store = await this.resolveSkillStore(chat.workspaceName);
        const skill = store.getActive().find(sk => sk.name === name);
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

    workingDir = this.resolveChatWorkingDir(chat);

    // Per-chat override takes precedence over the gateway default.
    const agent = (chat.agent ?? this.getDefaultAgent()) as CodingAgent;
    const chatEffort = resolveEffort({ chat: chat.effort });
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
    const warmAnchor = canResume
      ? this.chatManager.getSessionAnchor(chatId, agent, model?.model)
      : undefined;

    let prompt: string;
    let resumeSessionId: string | undefined;
    let newSessionId: string | undefined;
    // Named, not created: `git worktree add` makes the leading directories, and
    // pre-creating them would leave empty folders inside the user's project.
    const agentWorktreeParent = chat.executionMode !== 'isolated-worktree' && !chat.chatWorkspace
      ? chatWorktreeParent(this.resolveWorkspaceWorkingDir(chat.workspaceName))
      : undefined;
    const chatWorkspaceInstruction = chat.executionMode === 'isolated-worktree'
      ? '\n\n[Codey chat workspace]\nThis chat owns the current worktree and starts on its own same-named branch. You may rename or switch branches as the task evolves; do not operate in another chat’s worktree.'
      : agentWorktreeParent
        ? `\n\n[Codey chat workspace]\nThis chat uses the shared checkout. Work there; do not create a worktree on your own initiative. Only when the user explicitly asks for one, choose a short semantic lower-kebab name with no slash, then run \`git worktree add -b <name> ${JSON.stringify(path.join(agentWorktreeParent, '<name>'))} HEAD\` and perform all subsequent work in that new directory. Create it only as a direct child of ${JSON.stringify(agentWorktreeParent)} so Codey can bind and display it.`
        : '\n\n[Codey chat workspace]\nThis chat already has a user-managed worktree. Continue using the selected checkout; do not create another worktree.';
    if (warmAnchor) {
      // Resume the agent's own session. If other agents produced messages
      // while it was inactive, replay only that unseen gap before the new turn.
      prompt = selPrefix + (warmAnchor.syncedThroughMessageId
        ? buildChatCatchupPrompt(chat, warmAnchor.syncedThroughMessageId, userText, attachments)
        : buildChatResumePrompt(chat, userText, attachments));
      resumeSessionId = warmAnchor.sessionId;
    } else {
      // Bootstrap turn: include prior history once. For claude-code, pre-allocate
      // a session id so we can resume on the next turn without parsing CLI output.
      prompt = selPrefix + buildChatBootstrapPrompt(chat, userText, attachments);
      if (canResume && agent === 'claude-code') {
        newSessionId = randomUUID();
      }
    }
    prompt += chatWorkspaceInstruction;

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
        // Unattended automation runs execute a frozen brief — never auto-apply skills.
        && chat.kind !== 'automation'
        && chat.selection.type !== 'team' && !isSlashTurn) {
      // Skills are per-workspace: match against the CHAT's workspace store
      // (mirrors how workingDir/teams above come from chat.workspaceName).
      const chatSkillStore = await this.resolveSkillStore(chat.workspaceName);
      const match = matchSkill(userText, chatSkillStore.getActive());
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
    // Automation chats keep their authoritative "Automation: <name>" title —
    // no LLM title generation.
    const titlePromise: Promise<string> | undefined =
      afterUser.messages.length === 1 && this.isAideConfigured() && chat.kind !== 'automation'
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
        if (isPersistableToolCall(parsed.type)) {
          toolCalls.push({
            id: randomUUID(),
            type: parsed.type ?? 'info',
            tool: parsed.tool,
            message: parsed.message ?? '',
            input: parsed.input,
            output: parsed.output,
          });
        }
        if (parsed.type === 'checklist' && parsed.checklist?.length) {
          // Persist so a client that adopts this run mid-flight (or reloads)
          // sees the list without waiting for the agent's next revision.
          this.chatManager.setChecklist(chatId, parsed.checklist);
        }
        const event = chatStreamEventForStatus(chatId, parsed);
        if (event) sink(event);
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
      let detachedSoloAdvisorRun = false;
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
            this.chatManager.updateMessage(chatId, askingMsg.id, {
              workerStatus: 'done',
              workerNextUserAction: undefined,
              workerSummaryExcluded: true,
            });
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
        const r = await this.runTeamForChat(teamName, team, prompt, workingDir, sink, chatId, chat, abortController.signal, { routingTask: userText }, agent, model);
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
          effort: chatEffort,
          context: { workingDir },
          browserTools: true,
          browserChatId: chatId,
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
          this.chatManager.clearSessionAnchor(chatId, agent, model?.model);
          streamedText = '';
          resumeSessionId = undefined;
          newSessionId = canResume && agent === 'claude-code' ? randomUUID() : undefined;
          prompt = selPrefix + buildChatBootstrapPrompt(chat, userText, attachments) + chatWorkspaceInstruction;
          // Re-apply the skill banner: the rebuilt bootstrap prompt replaced
          // the one that carried it (still exactly once per prompt build).
          if (appliedChatSkill) prompt = applySkill(prompt, appliedChatSkill);
          response = await this.runWithFallback(agent, {
            prompt,
            agent,
            model,
            effort: chatEffort,
            context: { workingDir },
            browserTools: true,
            browserChatId: chatId,
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
          detachedSoloAdvisorRun = true;
          response = await this.runWithFallback(agent, {
            prompt: followup,
            agent,
            model,
            effort: chatEffort,
            context: { workingDir },
            browserTools: true,
            browserChatId: chatId,
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
        // The cursor is advanced after the assistant message is persisted.
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
        const adoptedWorkspace = await this.adoptAgentCreatedWorktree(chatId);
        if (adoptedWorkspace) sink({ type: 'workspace_ready', chatId });
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

      // Fallback metadata already carries the exact successful identity as
      // "agent(model)". Persist that identity instead of the failed primary;
      // otherwise use the configured agent/model for this turn.
      const fallbackIdentity = singleAgentResponse?.fallback?.to.match(/^([^()]+)\((.+)\)$/);
      const responseAgent = (fallbackIdentity?.[1] ?? agent) as CodingAgent;
      const responseModel = fallbackIdentity?.[2] ?? model?.model;
      const terminalTeamMessages = teamTurnId
        ? this.chatManager.get(chatId)?.messages.filter(message => message.teamTurnId === teamTurnId) ?? []
        : [];
      const terminalTeamSummary: TeamRunSummary | undefined = teamTurnId
        && !this.chatManager.get(chatId)?.pendingTeam
        ? finalizeTeamRunSummary(terminalTeamMessages) ?? undefined
        : undefined;
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
        agent: responseAgent,
        ...(responseModel ? { model: responseModel } : {}),
        ...(surfacedChoices ? { choices: surfacedChoices } : {}),
        ...(agentUserQuestion ? { userQuestion: agentUserQuestion } : {}),
        ...(singleAgentResponse?.fallback ? { fallback: singleAgentResponse.fallback } : {}),
        ...(terminalTeamSummary ? { teamSummary: terminalTeamSummary } : {}),
      };
      // For per-worker team runs the transcript was already persisted as
      // individual worker messages by the WorkerMessageEmitter. Persist only a
      // group-level footer (Advisor summary / formatted blackboard), identified
      // by teamTurnId and no worker, rather than a standalone duplicate bubble.
      let teamSummaryMessageId: string | undefined;
      if (!teamTurnId) {
        const updated = this.chatManager.appendMessage(chatId, assistantMessage);

        if (canResume && singleAgentResponse?.success && !detachedSoloAdvisorRun) {
          // A fallback response belongs to the fallback adapter's emitted
          // session, never the primary adapter's resume/new session id.
          const anchorId = singleAgentResponse.fallback
            ? (singleAgentResponse as any)?.sessionId
            : resumeSessionId ?? newSessionId ?? (singleAgentResponse as any)?.sessionId;
          if (anchorId) {
            this.chatManager.setSessionAnchor(chatId, {
              agent: responseAgent,
              model: responseModel,
              sessionId: anchorId,
              syncedThroughMessageId: assistantMessage.id,
            });
          }
        }

        // Persist lastAskedOptions on non-team chats so the next user reply can
        // be digit-mapped. Team flows track this via pendingTeam.options.
        if (plainAskOptions && !updated.pendingTeam) {
          this.chatManager.setLastAskedOptions(chatId, assistantMessage.id, plainAskOptions);
        }
      } else if (output.trim()) {
        const workerMessage = this.chatManager.get(chatId)?.messages.find(m => m.teamTurnId === teamTurnId && m.worker);
        this.chatManager.appendMessage(chatId, {
          ...assistantMessage,
          teamTurnId,
          teamName: workerMessage?.teamName,
          teamMode: workerMessage?.teamMode,
        });
        teamSummaryMessageId = assistantMessage.id;
      } else if (terminalTeamSummary) {
        const lastWorkerMessage = this.chatManager.get(chatId)?.messages
          .filter(message => message.teamTurnId === teamTurnId && message.worker)
          .pop();
        if (lastWorkerMessage) {
          teamSummaryMessageId = lastWorkerMessage.id;
          this.chatManager.updateMessage(chatId, lastWorkerMessage.id, { teamSummary: terminalTeamSummary });
        }
      }

      if (teamTurnId && terminalTeamSummary) {
        let finalTeamSummary = terminalTeamSummary;
        let terminalTaskBrief: TaskBrief | undefined;
        if (this.isAideConfigured()) {
          const terminalChat = this.chatManager.get(chatId);
          if (terminalChat) {
            try {
              const digest = await generateAideTurnDigest(terminalChat, this.getAideOptions(), terminalTeamSummary);
              terminalTaskBrief = { ...digest.taskBrief, teamTurnId };
              finalTeamSummary = digest.teamSummary ?? terminalTeamSummary;
              this.chatManager.setTaskBrief(chatId, terminalTaskBrief);
              if (teamSummaryMessageId) {
                this.chatManager.updateMessage(chatId, teamSummaryMessageId, { teamSummary: finalTeamSummary });
              }
            } catch (err) {
              this.logger.warn(`Aide terminal team digest generation failed: ${(err as Error).message}`);
            }
          }
        }
        sink({ type: 'team_end', chatId, teamTurnId, summary: finalTeamSummary, ...(terminalTaskBrief ? { taskBrief: terminalTaskBrief } : {}) });
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

      const adoptedWorkspace = await this.adoptAgentCreatedWorktree(chatId);
      if (adoptedWorkspace) sink({ type: 'workspace_ready', chatId });
      sink({ type: 'done', chatId, response: output, thinking: singleAgentResponse?.thinking, tokens, durationSec, agent: responseAgent, ...(responseModel ? { model: responseModel } : {}), title: finalTitle, choices: surfacedChoices, userQuestion: agentUserQuestion, fallback: singleAgentResponse?.fallback, ...(teamTurnId ? { teamTurnId } : {}) });

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
      // Automation chats still contribute traces — scheduled work is the most
      // repetitive work there is, so excluding it starves the distiller of its
      // best signal. Only the SUGGESTION is suppressed: an unattended run has
      // nobody there to answer "save this as a skill?".
      const unattended = chat.kind === 'automation';
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
        // What the run DID — the procedure clustering and the distiller work
        // on. Argument VALUES stay here; only their shapes reach the trace file.
        const steps = stepsFrom(toolCalls);
        const chatTrace: RunTrace = {
          runId: `chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          promptSummary: userText.slice(0, 200),
          outputPreview: (output || '').slice(0, 300),
          workerSequence: workerSequence && workerSequence.length > 0 ? workerSequence : undefined,
          steps,
          toolSequence: steps.map(s => s.tool),
          timestamp: Date.now(),
          mode: teamTurnId ? 'team-sequential' : 'solo',
        };
        // afterRunSkillPass never rejects (stage-isolated try/catch inside).
        void this.afterRunSkillPass({
          trace: chatTrace,
          appliedSkill: appliedChatSkill,
          clean: runSucceeded,
          // Per-workspace store, resolved from the CHAT's workspace binding.
          store: await this.resolveSkillStore(chat.workspaceName),
          // A turn that ended by asking the user something (choice buttons or
          // a structured AskUserQuestion) must not get a skill suggestion
          // stacked on top — the user's "yes" would resolve the suggestion
          // instead of the agent's question. Trace/evolve still run.
          suppressSuggestion: unattended || !!surfacedChoices || !!agentUserQuestion,
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
        const adoptedWorkspace = await this.adoptAgentCreatedWorktree(chatId);
        if (adoptedWorkspace) sink({ type: 'workspace_ready', chatId });
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
        agent,
        ...(model?.model ? { model: model.model } : {}),
      };
      this.chatManager.appendMessage(chatId, assistantMessage);
      const adoptedWorkspace = await this.adoptAgentCreatedWorktree(chatId);
      if (adoptedWorkspace) sink({ type: 'workspace_ready', chatId });
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
