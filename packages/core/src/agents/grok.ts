import { spawn, ChildProcess } from 'child_process';
import { AgentRequest, AgentResponse, ChecklistItem, ChecklistStatus, McpServerSpec, ThinkingEffort, ToolPolicy } from '../types';
import { BaseAgentAdapter } from './base';
import { AgentSpawnError } from '../errors';
import { ObservedToolEvent, ToolCallCollector } from './tool-events';
import { ChecklistTracker } from './checklist';
import { AcpClient, AcpRequestError } from './acp-client';
import { withCommonBinPaths } from './env';
import { agentSpawnOptions, cleanupProcessTreeAfterClose, terminateProcessTree, withForegroundPolicy } from './process-tree';

/**
 * Grok Build (`grok`) adapter, driven over the Agent Client Protocol.
 *
 * Grok's simple headless mode (`grok -p --output-format streaming-json`) only
 * streams text, thoughts and an end marker — no tool calls — so the tool
 * timeline, the task-list panel and playbook tool sequences would all stay
 * empty. ACP (`grok agent stdio`) reports all of them, so that is what this
 * adapter speaks. One process per turn:
 *
 *   initialize -> session/new | session/load -> [set effort] -> session/prompt
 *
 * while `session/update` notifications stream text, thoughts, tool calls and
 * the plan, and `session/request_permission` requests are answered here.
 *
 * Shapes below follow the ACP spec and were checked against grok 0.2.102:
 * its `initialize` reply (loadSession, http/sse MCP), its "Authentication
 * required" error, and the struct names in the binary (Usage with
 * inputTokens/outputTokens/thoughtTokens/cachedReadTokens/cachedWriteTokens,
 * config options with a `thought_level` category). A full prompt turn has not
 * been run against a signed-in Grok yet.
 *
 * Permissions: Codey declares no fs/terminal client capability, so Grok does
 * its own file and shell work and asks us before anything that needs
 * approval. Read-like tool kinds are always allowed; anything else is allowed
 * only when permissions are skipped, and otherwise refused and reported as a
 * permission denial — the same contract as claude-code. A tool policy refuses
 * everything that is not read-like ('none' refuses even reads). That boundary
 * only holds for tools Grok asks about: a user config that turns on Grok's
 * own always-approve would bypass it.
 */

// ── Wire shapes (ACP) ──────────────────────────────────────────────────

export interface AcpUsage {
  totalTokens?: number;
  /** Full prompt size, cache included. */
  inputTokens?: number;
  outputTokens?: number;
  thoughtTokens?: number;
  cachedReadTokens?: number;
  cachedWriteTokens?: number;
}

export interface AcpToolCall {
  toolCallId?: string;
  title?: string;
  /** read | edit | delete | move | search | execute | think | fetch | other */
  kind?: string;
  /** pending | in_progress | completed | failed */
  status?: string;
  rawInput?: unknown;
  rawOutput?: unknown;
  content?: Array<{ type?: string; content?: { type?: string; text?: string } }>;
}

export interface AcpPlanEntry {
  content?: string;
  priority?: string;
  status?: string;
}

export interface AcpSessionUpdate extends AcpToolCall {
  sessionUpdate: string;
  content?: any;
  entries?: AcpPlanEntry[];
}

export interface AcpPermissionOption {
  optionId: string;
  name?: string;
  /** allow_once | allow_always | reject_once | reject_always */
  kind?: string;
}

export interface AcpConfigOption {
  id?: string;
  category?: string;
  currentValue?: unknown;
  options?: Array<{ value?: unknown; name?: string; options?: Array<{ value?: unknown }> }>;
}

// ── Pure helpers (tested without spawning) ─────────────────────────────

/**
 * Whether this run's model is meant for Grok: one saved with apiType 'grok',
 * or a bare name the user typed (no apiType). An anthropic/openai/all/cursor
 * model belongs to another CLI, so the run ignores it and Grok uses its own
 * default.
 */
export function isGrokModel(model?: AgentRequest['model']): model is NonNullable<AgentRequest['model']> {
  return !!model?.model && (model.apiType === undefined || model.apiType === 'grok');
}

/** Env for the xAI key bound to a grok model. Without one, grok uses its own
 *  login or an ambient XAI_API_KEY. Never passed on the command line. */
export function grokModelEnv(model?: AgentRequest['model']): Record<string, string> {
  return model?.apiType === 'grok' && model.apiKey ? { XAI_API_KEY: model.apiKey } : {};
}

/** argv for `grok`, minus the binary. Options belong to `grok agent` and
 *  must come before the `stdio` mode name. */
export function grokSpawnArgs(
  request: Pick<AgentRequest, 'model' | 'skipPermissions' | 'toolPolicy'>,
): string[] {
  const args = ['agent'];
  if (isGrokModel(request.model)) args.push('--model', request.model.model);
  // A policy turn never auto-approves: that is what the policy forbids.
  if (request.skipPermissions && !request.toolPolicy) args.push('--always-approve');
  args.push('stdio');
  return args;
}

/** Codey's MCP servers in ACP's `mcpServers` shape. A remote server goes over
 *  http (Grok advertises http and sse); env/headers are name/value lists. */
export function acpMcpServers(servers?: Record<string, McpServerSpec>): unknown[] {
  if (!servers) return [];
  return Object.entries(servers).map(([name, spec]) => spec.url
    ? { type: 'http', name, url: spec.url, headers: [] }
    : {
      name,
      command: spec.command,
      args: spec.args ?? [],
      env: Object.entries(spec.env ?? {}).map(([k, v]) => ({ name: k, value: v })),
    });
}

/** Tool kinds that only look at things. */
const READ_KINDS = new Set(['read', 'search', 'think', 'fetch']);

export type PermissionVerdict = { allow: boolean; record: boolean };

/** Decide one permission request. `record` marks a refusal the user should
 *  hear about (a denial they could lift by skipping permissions). */
export function grokPermissionVerdict(
  kind: string | undefined,
  opts: { skipPermissions?: boolean; toolPolicy?: ToolPolicy },
): PermissionVerdict {
  const readLike = READ_KINDS.has((kind ?? '').toLowerCase());
  if (opts.toolPolicy) {
    return { allow: opts.toolPolicy !== 'none' && readLike, record: false };
  }
  if (readLike || opts.skipPermissions) return { allow: true, record: false };
  return { allow: false, record: true };
}

/** The ACP reply to a permission request: pick the matching option, or
 *  cancel when the agent offered none of that kind. One-shot options are
 *  preferred, so a single Codey turn never grants a lasting rule. */
export function grokPermissionOutcome(options: AcpPermissionOption[] | undefined, allow: boolean): unknown {
  const order = allow ? ['allow_once', 'allow_always'] : ['reject_once', 'reject_always'];
  for (const kind of order) {
    const option = options?.find(o => o.kind === kind);
    if (option) return { outcome: { outcome: 'selected', optionId: option.optionId } };
  }
  return { outcome: { outcome: 'cancelled' } };
}

/** A tool call's display name: its kind (stable, good for procedures), else
 *  its title. */
function toolNameOf(call: AcpToolCall): string {
  return call.kind && call.kind !== 'other' ? call.kind : (call.title || call.kind || 'tool');
}

function inputOf(call: AcpToolCall): Record<string, unknown> | undefined {
  const raw = call.rawInput;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  return call.title ? { title: call.title } : undefined;
}

function outputOf(call: AcpToolCall): unknown {
  if (call.rawOutput !== undefined) return call.rawOutput;
  const text = (call.content ?? [])
    .map(block => block?.content?.type === 'text' ? block.content.text ?? '' : '')
    .filter(Boolean)
    .join('\n');
  return text || undefined;
}

const TERMINAL_STATUSES = new Set(['completed', 'failed']);

/** Map a `tool_call` / `tool_call_update` onto an observed tool event.
 *  Non-terminal updates are dropped; the collector already holds the start.
 *  `names` remembers each call's name, since an update may omit kind/title. */
export function grokToolEvent(update: AcpSessionUpdate, names: Map<string, string>): ObservedToolEvent | null {
  if (update.sessionUpdate !== 'tool_call' && update.sessionUpdate !== 'tool_call_update') return null;
  const key = update.toolCallId;
  if (!key) return null;
  // The opening tool_call names the call; updates reuse that name so start
  // and end always agree.
  if (update.sessionUpdate === 'tool_call' || !names.has(key)) names.set(key, toolNameOf(update));
  const name = names.get(key)!;

  const status = update.status;
  if (status && TERMINAL_STATUSES.has(status)) {
    const output = outputOf(update);
    return {
      tool: name,
      key,
      phase: 'end',
      status,
      ...(update.sessionUpdate === 'tool_call' && inputOf(update) ? { input: inputOf(update) } : {}),
      ...(output !== undefined ? { output } : {}),
    };
  }
  if (update.sessionUpdate !== 'tool_call') return null;
  const input = inputOf(update);
  return { tool: name, key, phase: 'start', ...(input ? { input } : {}) };
}

/** The agent's plan, as the task-list panel's items. */
export function grokChecklistFromPlan(entries?: AcpPlanEntry[]): ChecklistItem[] | null {
  if (!Array.isArray(entries)) return null;
  const items: ChecklistItem[] = [];
  for (const entry of entries) {
    if (!entry?.content) continue;
    const status: ChecklistStatus = entry.status === 'completed' ? 'completed'
      : entry.status === 'in_progress' ? 'in_progress' : 'pending';
    items.push({ text: entry.content, status });
  }
  return items.length ? items : null;
}

/** ACP usage to Codey tokens. ACP's inputTokens is the FULL prompt (cache
 *  included), while Codey's `input` is uncached, so the cache is taken out. */
export function grokTokensFrom(usage?: AcpUsage): AgentResponse['tokens'] {
  if (!usage) return undefined;
  const read = Number(usage.cachedReadTokens ?? 0);
  const write = Number(usage.cachedWriteTokens ?? 0);
  const input = Math.max(Number(usage.inputTokens ?? 0) - read - write, 0);
  const output = Number(usage.outputTokens ?? 0);
  return {
    input,
    output,
    total: input + output,
    ...(usage.thoughtTokens !== undefined ? { reasoning: Number(usage.thoughtTokens) } : {}),
    ...(read || write ? { cache: { read, write } } : {}),
  };
}

/** The config option to set for an effort level, or null when Grok exposes
 *  no reasoning option or that level is not one of its values. Lenient on
 *  purpose: an unsupported level is skipped, never a failed run. */
export function grokEffortOption(
  configOptions: AcpConfigOption[] | undefined,
  effort?: ThinkingEffort,
): { configId: string; value: string } | null {
  if (!effort || !Array.isArray(configOptions)) return null;
  const option = configOptions.find(o => o?.category === 'thought_level' && o.id);
  if (!option?.id) return null;
  const values = new Set<string>();
  for (const choice of option.options ?? []) {
    if (typeof choice?.value === 'string') values.add(choice.value);
    for (const inner of choice?.options ?? []) if (typeof inner?.value === 'string') values.add(inner.value);
  }
  return values.has(effort) ? { configId: option.id, value: effort } : null;
}

/** True when a session/load error means the session is gone (rather than,
 *  say, an auth failure). */
export function isMissingGrokSession(err: unknown): boolean {
  if (err instanceof AcpRequestError && err.rpc.code === -32002) return true;
  const text = err instanceof AcpRequestError ? err.detail : String(err);
  return /not.?found|no such|does not exist|unknown session/i.test(text);
}

/** A friendlier message for the errors a user can fix themselves. */
export function grokErrorMessage(err: unknown): string {
  const text = err instanceof AcpRequestError ? err.detail : err instanceof Error ? err.message : String(err);
  if (/authentication required|not (?:signed|logged) in|unauthori[sz]ed/i.test(text)) {
    return `Grok is not signed in. Run \`grok login\`, or add a model of type "grok" with an xAI API key. (${text})`;
  }
  return text;
}

// ── Adapter ────────────────────────────────────────────────────────────

const CLIENT_INFO = { name: 'codey', title: 'Codey' };

export class GrokAdapter extends BaseAgentAdapter {
  name = 'grok';
  private debug: (msg: string) => void;
  private activeProcess?: ChildProcess;

  constructor(debug?: (msg: string) => void) {
    super();
    this.debug = debug ?? (() => {});
  }

  async run(request: AgentRequest): Promise<AgentResponse> {
    const args = grokSpawnArgs(request);
    this.debug(`[grok] Spawning: grok ${args.join(' ')}`);

    // Grok authenticates with an xAI key or its own login, never with
    // Anthropic/OpenAI keys, so applyModelEnv is not used.
    const env = withCommonBinPaths({ ...process.env });
    if (request.extraEnv) Object.assign(env, request.extraEnv);
    Object.assign(env, grokModelEnv(request.model));

    const cwd = request.context?.workingDir || process.cwd();
    const startTime = Date.now();
    const elapsed = () => Math.round((Date.now() - startTime) / 1000);

    let child: ChildProcess;
    try {
      child = spawn('grok', args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd,
        env,
        ...agentSpawnOptions(),
      });
    } catch (err) {
      const spawnError = new AgentSpawnError(this.name, err instanceof Error ? err.message : String(err));
      return { success: false, output: spawnError.message, error: spawnError.message, duration: 0 };
    }
    this.activeProcess = child;

    const tools = new ToolCallCollector(request.onStatus);
    const checklist = new ChecklistTracker(request.onStatus);
    const toolNames = new Map<string, string>();
    const permissionDenials: NonNullable<AgentResponse['permissionDenials']> = [];
    let text = '';
    let thinking = '';
    let afterTool = false;
    let sessionId: string | undefined;
    let stderr = '';
    // session/load replays the old conversation as updates; none of it is
    // this turn's output.
    let replaying = false;

    const onUpdate = (update: AcpSessionUpdate) => {
      if (replaying || !update) return;
      switch (update.sessionUpdate) {
        case 'agent_message_chunk': {
          const chunk = update.content?.type === 'text' ? update.content.text ?? '' : '';
          if (!chunk) break;
          // Text before and after a tool call are separate thoughts; keep
          // them apart instead of gluing "Let me look.Done." together.
          const piece = afterTool && text ? `\n\n${chunk}` : chunk;
          afterTool = false;
          text += piece;
          request.onStream?.(piece);
          break;
        }
        case 'agent_thought_chunk': {
          const chunk = update.content?.type === 'text' ? update.content.text ?? '' : '';
          if (chunk) {
            thinking += chunk;
            request.onThinking?.(chunk);
          }
          break;
        }
        case 'tool_call':
        case 'tool_call_update': {
          const observed = grokToolEvent(update, toolNames);
          if (observed) {
            tools.record(observed);
            afterTool = true;
          }
          break;
        }
        case 'plan':
          checklist.record(grokChecklistFromPlan(update.entries));
          break;
      }
    };

    const client = new AcpClient(child.stdout!, child.stdin!, {
      onNotification: (method, params) => {
        if (method === 'session/update') onUpdate(params?.update);
      },
      onRequest: (method, params) => {
        if (method === 'session/request_permission') {
          const call: AcpToolCall = params?.toolCall ?? {};
          const verdict = grokPermissionVerdict(call.kind, request);
          if (verdict.record) {
            const toolInput = inputOf(call);
            permissionDenials.push({ toolName: toolNameOf(call), ...(toolInput ? { toolInput } : {}) });
          }
          this.debug(`[grok] permission ${call.kind ?? '?'} -> ${verdict.allow ? 'allow' : 'reject'}`);
          return grokPermissionOutcome(params?.options, verdict.allow);
        }
        throw new AcpRequestError(method, { code: -32601, message: `Method not found: ${method}` });
      },
    });

    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });

    let timeoutTimer: NodeJS.Timeout | undefined;
    let abortHandler: (() => void) | undefined;
    let stopReason: 'timeout' | 'aborted' | undefined;

    const exited = new Promise<number | null>(resolve => {
      child.on('close', code => {
        cleanupProcessTreeAfterClose(child);
        this.activeProcess = undefined;
        client.close(new Error(stderr.trim() || `grok exited with code ${code}`));
        resolve(code);
      });
      child.on('error', err => {
        client.close(new AgentSpawnError(this.name, err.message));
        resolve(null);
      });
    });

    const stop = (reason: 'timeout' | 'aborted') => {
      if (stopReason) return;
      stopReason = reason;
      if (sessionId) client.notify('session/cancel', { sessionId });
      terminateProcessTree(child);
    };
    const timeout = request.timeout || 900000;
    timeoutTimer = setTimeout(() => stop('timeout'), timeout);
    if (request.signal) {
      abortHandler = () => stop('aborted');
      if (request.signal.aborted) abortHandler();
      else request.signal.addEventListener('abort', abortHandler, { once: true });
    }

    const finish = (response: AgentResponse): AgentResponse => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (abortHandler && request.signal) request.signal.removeEventListener('abort', abortHandler);
      tools.finish();
      if (this.activeProcess === child) terminateProcessTree(child);
      return response;
    };

    try {
      const init = await client.request<any>('initialize', {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: CLIENT_INFO,
      });

      const mcpServers = acpMcpServers(request.mcpServers);
      let session: any;
      if (request.resumeSessionId && init?.agentCapabilities?.loadSession) {
        replaying = true;
        try {
          session = await client.request('session/load', { sessionId: request.resumeSessionId, cwd, mcpServers });
        } catch (err) {
          if (isMissingGrokSession(err)) {
            throw new Error(`Could not resume session ${request.resumeSessionId}: ${grokErrorMessage(err)}`);
          }
          throw err;
        } finally {
          replaying = false;
        }
        sessionId = request.resumeSessionId;
      } else {
        session = await client.request('session/new', { cwd, mcpServers });
        sessionId = session?.sessionId;
      }
      if (!sessionId) throw new Error('grok did not return a session id');

      const effort = grokEffortOption(session?.configOptions, request.effort);
      if (effort) {
        try {
          await client.request('session/set_config_option', { sessionId, ...effort });
        } catch (err) {
          this.debug(`[grok] effort not applied: ${grokErrorMessage(err)}`);
        }
      }

      const result = await client.request<any>('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: withForegroundPolicy(request.prompt) }],
      });

      const tokens = grokTokensFrom(result?.usage ?? result?._meta?.usage);
      const output = text.trim();
      const reason: string | undefined = result?.stopReason;
      let error: string | undefined;
      if (reason === 'refusal') error = 'Grok refused this request';
      else if (reason === 'cancelled') error = stopReason ?? 'aborted';
      else if (!output) error = 'grok returned empty response';
      const success = !error;
      this.debug(`[grok] stop ${reason}, ${output.length} chars, tokens: ${tokens?.total ?? 'none'}`);

      return finish({
        success,
        output: output || (error ?? ''),
        error,
        duration: elapsed(),
        tokens,
        statusUpdates: tools.statusUpdates,
        states: tools.states,
        sessionId: success ? sessionId : undefined,
        startedSessionId: sessionId,
        thinking: thinking || undefined,
        permissionDenials: permissionDenials.length ? permissionDenials : undefined,
      });
    } catch (err) {
      // A stop we caused explains the failure better than the dead pipe does.
      if (stopReason) await exited;
      const message = stopReason === 'timeout'
        ? `Timeout after ${Math.round(timeout / 60000)} minutes`
        : stopReason === 'aborted'
          ? 'Stopped'
          : grokErrorMessage(err);
      return finish({
        success: false,
        output: stopReason ? message : (text.trim() || message),
        error: stopReason === 'timeout' ? 'timeout' : stopReason === 'aborted' ? 'aborted' : message,
        duration: elapsed(),
        statusUpdates: tools.statusUpdates,
        states: tools.states,
        startedSessionId: sessionId,
        permissionDenials: permissionDenials.length ? permissionDenials : undefined,
      });
    }
  }

  dispose(): void {
    if (this.activeProcess) {
      terminateProcessTree(this.activeProcess);
      this.activeProcess = undefined;
    }
  }
}
