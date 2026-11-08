import { spawn, ChildProcess } from 'child_process';
import { AgentRequest, AgentResponse, ChecklistItem, ChecklistStatus } from '../types';
import { BaseAgentAdapter } from './base';
import { AgentSpawnError } from '../errors';
import { ObservedToolEvent, ToolCallCollector } from './tool-events';
import { ChecklistTracker } from './checklist';
import { withCommonBinPaths } from './env';
import { cursorToolPolicyArgs } from './tool-policy';
import { agentSpawnOptions, cleanupProcessTreeAfterClose, terminateProcessTree, withForegroundPolicy } from './process-tree';

/**
 * Cursor CLI (`cursor-agent`) adapter.
 *
 * `cursor-agent -p --output-format stream-json "<prompt>"` runs headless and
 * writes one JSON object per line. The shapes below were read out of the
 * shipped CLI bundle (2026.05.01), not just the docs:
 *
 *   {type:"system", subtype:"init", session_id, model, cwd, ...}
 *   {type:"assistant", message:{content:[{type:"text", text}]}, session_id}
 *       — one line per text SEGMENT: text is buffered and flushed whenever a
 *         tool call starts and at the end. Segments do not repeat each other.
 *   {type:"thinking", subtype:"delta"|"completed", text?}
 *   {type:"tool_call", subtype:"started"|"completed", call_id, tool_call}
 *       — `tool_call` is a protobuf oneof serialized to JSON, so it has exactly
 *         one key naming the tool (`shellToolCall`, `readToolCall`,
 *         `mcpToolCall`, ...) holding `{args, result?}`.
 *   {type:"result", subtype:"success", is_error, result, session_id, usage?}
 *       — `result` is every text segment of the run joined; `usage` is
 *         {inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens} with
 *         cache already subtracted from inputTokens.
 *
 * `--stream-partial-output` is deliberately NOT used: with it the CLI emits
 * each delta AND still flushes the buffered segment, so every word would
 * arrive twice.
 *
 * MCP: cursor-agent only reads servers from `.cursor/mcp.json` /
 * `~/.cursor/mcp.json` and has no per-run flag, so `request.mcpServers` is
 * ignored (as with pi) rather than written into the user's project. The
 * browser skill does not need MCP, so it still works.
 *
 * Auth: a model saved with API type 'cursor' carries the Cursor API key,
 * handed over as CURSOR_API_KEY. With none, cursor-agent uses its own login.
 *
 * Effort: Cursor encodes reasoning in the model name (`sonnet-4-thinking`),
 * so there is no effort flag to map.
 */

export interface CursorUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface CursorEvent {
  type: string;
  subtype?: string;
  session_id?: string;
  // assistant
  message?: { role?: string; content?: Array<{ type?: string; text?: string }> | string };
  // thinking
  text?: string;
  // tool_call
  call_id?: string;
  tool_call?: Record<string, unknown>;
  // result
  is_error?: boolean;
  result?: string;
  usage?: CursorUsage;
  // error-ish events
  error?: string | { message?: string };
}

/**
 * Whether this run's model is meant for Cursor. A model saved with apiType
 * 'cursor' is; one with no apiType is a bare name the user typed (`/model
 * sonnet-4`), so it is trusted too. An anthropic/openai/all model belongs to
 * another CLI: its name means nothing to Cursor and its key is not a Cursor
 * key, so the run ignores it and Cursor uses its own default.
 */
export function isCursorModel(model?: AgentRequest['model']): model is NonNullable<AgentRequest['model']> {
  return !!model?.model && (model.apiType === undefined || model.apiType === 'cursor');
}

/** Env for the Cursor key bound to a cursor model. Without one, cursor-agent
 *  falls back to its own login or an ambient CURSOR_API_KEY. */
export function cursorModelEnv(model?: AgentRequest['model']): Record<string, string> {
  return model?.apiType === 'cursor' && model.apiKey ? { CURSOR_API_KEY: model.apiKey } : {};
}

/** The argv for one cursor-agent run, minus the binary. Split out so the flag
 *  mapping is testable without spawning anything. */
export function cursorArgs(
  request: Pick<AgentRequest, 'prompt' | 'model' | 'skipPermissions' | 'resumeSessionId' | 'toolPolicy' | 'context'>,
): string[] {
  // `--trust` is required for any headless run: without it the CLI stops to
  // ask whether the workspace is trusted, and nobody is there to answer.
  const args = ['-p', '--output-format', 'stream-json', '--trust'];

  if (request.resumeSessionId) {
    args.push('--resume', request.resumeSessionId);
  }
  if (isCursorModel(request.model)) {
    args.push('--model', request.model.model);
  }
  if (request.context?.workingDir) {
    args.push('--workspace', request.context.workingDir);
  }
  // A policy turn never gets --force: force approves the very commands the
  // read-only mode is there to block.
  if (request.toolPolicy) {
    args.push(...cursorToolPolicyArgs(request.toolPolicy));
  } else if (request.skipPermissions) {
    args.push('--force', '--approve-mcps');
  }
  args.push(withForegroundPolicy(request.prompt));
  return args;
}

/** `shellToolCall` -> `shell`. Keeps the timeline readable and matches the
 *  short names the other adapters report. */
function shortToolName(key: string): string {
  return key.endsWith('ToolCall') ? key.slice(0, -'ToolCall'.length) : key;
}

/** Pull the one tool out of a serialized `tool_call` oneof. Accepts the JSON
 *  form (`{shellToolCall:{args}}`), the raw protobuf-es form
 *  (`{tool:{case, value}}`), and the older documented `{function:{name,
 *  arguments}}` form. */
export function cursorToolFromCall(
  toolCall?: Record<string, unknown>,
): { key: string; name: string; args?: Record<string, unknown>; result?: unknown } | null {
  if (!toolCall || typeof toolCall !== 'object') return null;

  let key: string | undefined;
  let body: Record<string, unknown> | undefined;
  const raw = toolCall.tool as { case?: string; value?: Record<string, unknown> } | undefined;
  if (raw && typeof raw === 'object' && typeof raw.case === 'string') {
    key = raw.case;
    body = raw.value;
  } else {
    key = Object.keys(toolCall).find(k => toolCall[k] && typeof toolCall[k] === 'object');
    body = key ? toolCall[key] as Record<string, unknown> : undefined;
  }
  if (!key || !body) return null;

  if (key === 'function') {
    const name = typeof body.name === 'string' ? body.name : 'function';
    let args: Record<string, unknown> | undefined;
    if (typeof body.arguments === 'string') {
      try { args = JSON.parse(body.arguments); } catch { /* leave undefined */ }
    } else if (body.arguments && typeof body.arguments === 'object') {
      args = body.arguments as Record<string, unknown>;
    }
    return { key, name, args, result: body.result };
  }

  const args = body.args && typeof body.args === 'object' ? body.args as Record<string, unknown> : undefined;
  // An MCP tool keeps its own identity ("server.tool"), as in the codex
  // adapter — those are the distinctive ones for procedure clustering.
  if (key === 'mcpToolCall' && args) {
    const server = typeof args.providerIdentifier === 'string' ? args.providerIdentifier : undefined;
    const tool = typeof args.toolName === 'string' ? args.toolName
      : typeof args.name === 'string' ? args.name : undefined;
    const name = server && tool ? `${server}.${tool}` : (tool ?? 'mcp');
    const input = args.args && typeof args.args === 'object' ? args.args as Record<string, unknown> : args;
    return { key, name, args: input, result: body.result };
  }
  return { key, name: shortToolName(key), args, result: body.result };
}

/** True when a completed tool's result is the `error`/`rejected` branch. */
function resultFailed(result: unknown): boolean {
  if (!result || typeof result !== 'object') return false;
  const r = result as Record<string, unknown>;
  return 'error' in r || 'rejected' in r || 'failure' in r;
}

/** Map a `tool_call` event onto an observed tool event, or null for anything
 *  else. Cursor reports both ends and pairs them by `call_id`. */
export function cursorToolEvent(event: CursorEvent): ObservedToolEvent | null {
  if (event.type !== 'tool_call') return null;
  const tool = cursorToolFromCall(event.tool_call);
  if (!tool) return null;
  const key = event.call_id ?? tool.name;
  if (event.subtype === 'started') {
    return { tool: tool.name, key, phase: 'start', ...(tool.args ? { input: tool.args } : {}) };
  }
  if (event.subtype !== 'completed') return null;
  return {
    tool: tool.name,
    key,
    phase: 'end',
    status: resultFailed(tool.result) ? 'failed' : 'completed',
    ...(tool.result !== undefined ? { output: tool.result } : {}),
  };
}

/** Cursor's todo statuses are proto enum names (`TODO_STATUS_IN_PROGRESS`),
 *  or their numbers when the call was not run through toJson. */
function cursorTodoStatus(raw: unknown): ChecklistStatus | null {
  const word = typeof raw === 'number'
    ? ['', 'pending', 'in_progress', 'completed', 'cancelled'][raw] ?? ''
    : typeof raw === 'string' ? raw.toLowerCase().replace(/^todo_status_/, '') : '';
  if (word === 'completed') return 'completed';
  if (word === 'in_progress') return 'in_progress';
  // Cancelled items are dropped rather than shown as pending work.
  if (word === 'cancelled') return null;
  return 'pending';
}

/** The task list from an `updateTodosToolCall`, or null for any other call. */
export function cursorChecklistFromEvent(event: CursorEvent): ChecklistItem[] | null {
  if (event.type !== 'tool_call' || event.subtype !== 'started') return null;
  const tool = cursorToolFromCall(event.tool_call);
  if (!tool || tool.key !== 'updateTodosToolCall') return null;
  const todos = tool.args?.todos;
  if (!Array.isArray(todos)) return null;
  const items: ChecklistItem[] = [];
  for (const raw of todos) {
    if (!raw || typeof raw !== 'object') continue;
    const todo = raw as Record<string, unknown>;
    const text = typeof todo.content === 'string' ? todo.content : '';
    const status = cursorTodoStatus(todo.status);
    if (text && status) items.push({ text, status });
  }
  return items.length ? items : null;
}

/** The text of an `assistant` line. */
export function cursorTextFromEvent(event: CursorEvent): string {
  if (event.type !== 'assistant' || !event.message) return '';
  const content = event.message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('');
}

/** Convert Cursor's usage. `inputTokens` already excludes cache, so `total`
 *  is input+output like everywhere else in the gateway. */
export function cursorTokensFrom(usage?: CursorUsage): AgentResponse['tokens'] {
  if (!usage) return undefined;
  const input = Number(usage.inputTokens ?? 0);
  const output = Number(usage.outputTokens ?? 0);
  const read = Number(usage.cacheReadTokens ?? 0);
  const write = Number(usage.cacheWriteTokens ?? 0);
  return {
    input,
    output,
    total: input + output,
    ...(read || write ? { cache: { read, write } } : {}),
  };
}

export interface CursorRunResult {
  code: number | null;
  /** `result.result` — authoritative when present. */
  finalText?: string;
  /** Joined `assistant` segments, used when no result line came. */
  streamedText: string;
  stderr: string;
  /** Set when a result line said `is_error`, or an error event came. */
  errorMessage?: string;
}

/** Decide whether a finished run succeeded, and what to show for it. A
 *  reported error wins over partial text, so the gateway's fallback chain
 *  still sees the failure. */
export function classifyCursorRunResult(run: CursorRunResult): { success: boolean; output: string; error?: string } {
  const output = (run.finalText ?? '').trim() || run.streamedText.trim();
  const success = run.code === 0 && !run.errorMessage && !!output;
  let error = run.errorMessage
    ?? (run.code !== 0 ? (run.stderr.trim() || `cursor-agent exited with code ${run.code}`) : undefined);
  if (!success && !error) error = 'cursor-agent returned empty response';
  return { success, output, error };
}

export class CursorAdapter extends BaseAgentAdapter {
  name = 'cursor';
  private debug: (msg: string) => void;
  private activeProcess?: ChildProcess;

  constructor(debug?: (msg: string) => void) {
    super();
    this.debug = debug ?? (() => {});
  }

  async run(request: AgentRequest): Promise<AgentResponse> {
    return new Promise((resolve) => {
      const args = cursorArgs(request);
      this.debug(`[cursor] Spawning: cursor-agent ${args.slice(0, -1).join(' ')} "<prompt>"`);

      // Cursor authenticates with a Cursor key, never with Anthropic/OpenAI
      // keys, so applyModelEnv is not used. The key travels in env, not as
      // `--api-key`, so it never shows up in a process listing. A key bound to
      // the model wins over one from the agent's env box.
      const env = withCommonBinPaths({ ...process.env });
      if (request.extraEnv) Object.assign(env, request.extraEnv);
      Object.assign(env, cursorModelEnv(request.model));

      const childProcess: ChildProcess = spawn('cursor-agent', args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: request.context?.workingDir || undefined,
        env,
        ...agentSpawnOptions(),
      });
      this.activeProcess = childProcess;
      childProcess.on('close', () => {
        cleanupProcessTreeAfterClose(childProcess);
        this.activeProcess = undefined;
      });

      const startTime = Date.now();
      let resolved = false;
      let buffer = '';
      let stderr = '';
      let streamedText = '';
      let thinkingText = '';
      let finalText: string | undefined;
      let errorMessage: string | undefined;
      let capturedSessionId: string | undefined;
      let tokens: AgentResponse['tokens'];
      let timeoutTimer: NodeJS.Timeout | undefined;
      let abortHandler: (() => void) | undefined;
      const tools = new ToolCallCollector(request.onStatus);
      const statusUpdates = tools.statusUpdates;
      const states = tools.states;
      const checklist = new ChecklistTracker(request.onStatus);

      const safeResolve = (response: AgentResponse) => {
        if (resolved) return;
        resolved = true;
        if (timeoutTimer) clearTimeout(timeoutTimer);
        if (abortHandler && request.signal) request.signal.removeEventListener('abort', abortHandler);
        resolve(response);
      };

      const handleEvent = (event: CursorEvent) => {
        if (event.session_id && !capturedSessionId) capturedSessionId = event.session_id;
        switch (event.type) {
          case 'assistant': {
            const text = cursorTextFromEvent(event);
            if (text) {
              streamedText += text;
              request.onStream?.(text);
            }
            break;
          }
          case 'thinking':
            if (event.subtype === 'delta' && event.text) {
              thinkingText += event.text;
              request.onThinking?.(event.text);
            }
            break;
          case 'tool_call': {
            const observed = cursorToolEvent(event);
            if (observed) tools.record(observed);
            checklist.record(cursorChecklistFromEvent(event));
            break;
          }
          case 'result':
            if (typeof event.result === 'string') finalText = event.result;
            tokens = cursorTokensFrom(event.usage) ?? tokens;
            if (event.is_error || (event.subtype && event.subtype !== 'success')) {
              errorMessage = event.result || `cursor-agent run ${event.subtype ?? 'failed'}`;
            }
            break;
          case 'error': {
            const e = event.error;
            errorMessage = (typeof e === 'string' ? e : e?.message) || 'cursor-agent error';
            break;
          }
        }
      };

      childProcess.stdout?.on('data', (data: Buffer) => {
        buffer += data.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('{')) continue;
          try {
            handleEvent(JSON.parse(trimmed) as CursorEvent);
          } catch {
            // Not JSON, or a partial line — skip.
          }
        }
      });

      childProcess.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      childProcess.on('close', (code: number | null) => {
        tools.finish();
        if (buffer.trim().startsWith('{')) {
          try { handleEvent(JSON.parse(buffer.trim()) as CursorEvent); } catch { /* ignore */ }
        }

        const duration = Math.round((Date.now() - startTime) / 1000);
        const cls = classifyCursorRunResult({ code, finalText, streamedText, stderr, errorMessage });
        this.debug(`[cursor] Exit ${code}, ${cls.output.length} chars, tokens: ${tokens?.total ?? 'none'}`);

        safeResolve({
          success: cls.success,
          output: cls.output,
          error: cls.error,
          duration,
          tokens,
          statusUpdates,
          states,
          sessionId: capturedSessionId,
          thinking: thinkingText || undefined,
        });
      });

      childProcess.on('error', (err: Error) => {
        const duration = Math.round((Date.now() - startTime) / 1000);
        this.debug(`[cursor] Spawn error: ${err.message}`);
        const spawnError = new AgentSpawnError(this.name, err.message);
        safeResolve({
          success: false,
          output: spawnError.message,
          error: spawnError.message,
          duration,
        });
      });

      const timeout = request.timeout || 900000;
      timeoutTimer = setTimeout(() => {
        if (resolved) return;
        terminateProcessTree(childProcess);
        const duration = Math.round((Date.now() - startTime) / 1000);
        safeResolve({
          success: false,
          output: `Timeout after ${Math.round(timeout / 60000)} minutes`,
          error: 'timeout',
          duration,
        });
      }, timeout);

      if (request.signal) {
        abortHandler = () => {
          if (resolved) return;
          terminateProcessTree(childProcess);
          const duration = Math.round((Date.now() - startTime) / 1000);
          safeResolve({
            success: false,
            output: 'Stopped',
            error: 'aborted',
            duration,
            statusUpdates,
            states,
          });
        };
        if (request.signal.aborted) abortHandler();
        else request.signal.addEventListener('abort', abortHandler, { once: true });
      }
    });
  }

  dispose(): void {
    if (this.activeProcess) {
      terminateProcessTree(this.activeProcess);
      this.activeProcess = undefined;
    }
  }
}
