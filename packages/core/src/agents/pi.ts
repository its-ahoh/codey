import { spawn, ChildProcess } from 'child_process';
import { AgentRequest, AgentResponse } from '../types';
import { BaseAgentAdapter } from './base';
import { AgentSpawnError } from '../errors';
import { ObservedToolEvent, ToolCallCollector } from './tool-events';
import { ChecklistTracker, checklistFromTodos, isChecklistTool } from './checklist';
import { piEffortArgs } from './effort';
import { agentSpawnOptions, cleanupProcessTreeAfterClose, terminateProcessTree, withForegroundPolicy } from './process-tree';

/**
 * pi (https://pi.dev) adapter.
 *
 * `pi --mode json "<prompt>"` runs non-interactively and writes newline-
 * delimited events to stdout. The first line is a session header; the rest are
 * `AgentEvent` records. Shapes below follow pi's `docs/json.md`; unknown fields
 * are tolerated.
 *
 * Two pi behaviours shape this adapter:
 *
 *   - Non-interactive modes (`-p`, `--mode json`, `--mode rpc`) never show a
 *     trust prompt, so there is nothing to "skip" for permissions. What project
 *     trust decides is whether pi loads project-local settings/extensions, and
 *     `--approve`/`-a` forces that on for one run — which is what
 *     `skipPermissions` means here. pi ships no sandbox to bypass.
 *   - pi has no MCP surface, so `request.mcpServers` is deliberately ignored;
 *     the browser plugin and external MCP servers stay claude-code/opencode/
 *     codex only.
 */

export interface PiUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  reasoning?: number;
  totalTokens?: number;
}

/** An assistant content block. pi mixes text, thinking and tool calls in one
 *  array, and only the text blocks are the answer. */
export interface PiContentBlock {
  type?: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  arguments?: Record<string, unknown>;
}

export interface PiMessage {
  role?: string;
  content?: PiContentBlock[] | string;
  usage?: PiUsage;
  stopReason?: string;
  errorMessage?: string;
}

export interface PiEvent {
  type: string;
  // `session` header
  id?: string;
  cwd?: string;
  version?: number;
  // `message_update` — delta-only; `usage` is the latest cumulative usage.
  usage?: PiUsage;
  assistantMessageEvent?: {
    type?: string;
    contentIndex?: number;
    delta?: string;
    content?: string;
  };
  // `message_start` / `message_end` / `turn_end`
  message?: PiMessage;
  // `tool_execution_start` / `tool_execution_update` / `tool_execution_end`
  toolCallId?: string;
  toolName?: string;
  args?: Record<string, unknown>;
  result?: unknown;
  isError?: boolean;
}

/** The argv for one pi run, minus the binary. Split out so the flag mapping is
 *  testable without spawning anything. */
export function piArgs(
  request: Pick<AgentRequest, 'prompt' | 'model' | 'effort' | 'skipPermissions' | 'resumeSessionId'>,
): string[] {
  const args = ['--mode', 'json'];

  // pi generates the session id itself; we capture it from the header line and
  // hand it back on the next turn.
  if (request.resumeSessionId) {
    args.push('--session', request.resumeSessionId);
  }
  if (request.model?.model) {
    args.push('--model', request.model.model);
  }
  args.push(...piEffortArgs(request.effort));
  if (request.skipPermissions) {
    args.push('-a');
  }
  args.push(withForegroundPolicy(request.prompt));
  return args;
}

/** Map a pi tool execution event onto an observed tool event, or null when the
 *  event is anything else. pi reports both ends of a call and pairs them by
 *  `toolCallId`, so no start has to be synthesized. */
export function piToolEvent(event: PiEvent): ObservedToolEvent | null {
  if (event.type !== 'tool_execution_start' && event.type !== 'tool_execution_end') return null;
  if (!event.toolName) return null;
  const key = event.toolCallId ?? event.toolName;
  if (event.type === 'tool_execution_start') {
    return {
      tool: event.toolName,
      key,
      phase: 'start',
      ...(event.args ? { input: event.args } : {}),
    };
  }
  return {
    tool: event.toolName,
    key,
    phase: 'end',
    status: event.isError ? 'failed' : 'completed',
    ...(event.result !== undefined ? { output: event.result } : {}),
  };
}

/** The answer text of an assistant message: text blocks only, in order. */
export function piTextFromMessage(message?: PiMessage): string {
  if (!message || message.role !== 'assistant') return '';
  if (typeof message.content === 'string') return message.content;
  if (!Array.isArray(message.content)) return '';
  return message.content
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('');
}

/** Add one message's usage to the run total. pi reports usage per assistant
 *  message, so a multi-turn run has to sum rather than overwrite. `total` is
 *  derived: pi's own `totalTokens` counts cache reads/writes too, and the rest
 *  of the gateway treats `total` as input+output. */
export function piTokensFrom(
  current: AgentResponse['tokens'],
  usage?: PiUsage,
): AgentResponse['tokens'] {
  if (!usage) return current;
  const input = (current?.input ?? 0) + (usage.input ?? 0);
  const output = (current?.output ?? 0) + (usage.output ?? 0);
  const read = (current?.cache?.read ?? 0) + (usage.cacheRead ?? 0);
  const write = (current?.cache?.write ?? 0) + (usage.cacheWrite ?? 0);
  const reasoning = usage.reasoning !== undefined
    ? (current?.reasoning ?? 0) + usage.reasoning
    : current?.reasoning;
  return {
    input,
    output,
    total: input + output,
    ...(reasoning !== undefined ? { reasoning } : {}),
    ...(read || write ? { cache: { read, write } } : {}),
  };
}

export interface PiRunResult {
  code: number | null;
  /** Text of the last assistant `message_end` — authoritative when present. */
  finalText: string;
  /** Text assembled from `text_delta` updates, used when no message_end came. */
  streamedText: string;
  stderr: string;
  /** Set when pi reported an errored assistant message. */
  errorMessage?: string;
}

/** Decide whether a finished pi run succeeded, and what to show for it.
 *  A reported error wins over any partial text: pi can stream a sentence and
 *  then fail the turn, and calling that a success would hide the failure from
 *  the gateway's fallback chain. */
export function classifyPiRunResult(run: PiRunResult): { success: boolean; output: string; error?: string } {
  const output = run.finalText.trim() || run.streamedText.trim();
  const success = run.code === 0 && !run.errorMessage && !!output;
  let error = run.errorMessage
    ?? (run.code !== 0 ? (run.stderr.trim() || `pi exited with code ${run.code}`) : undefined);
  if (!success && !error) error = 'pi returned empty response';
  return { success, output, error };
}

export class PiAdapter extends BaseAgentAdapter {
  name = 'pi';
  private debug: (msg: string) => void;
  private activeProcess?: ChildProcess;

  constructor(debug?: (msg: string) => void) {
    super();
    this.debug = debug ?? (() => {});
  }

  async run(request: AgentRequest): Promise<AgentResponse> {
    return new Promise((resolve) => {
      const args = piArgs(request);
      this.debug(`[pi] Spawning: pi ${args.slice(0, -1).join(' ')} "<prompt>"`);

      const { applyModelEnv, withCommonBinPaths } = require('./env') as typeof import('./env');
      // pi is provider-agnostic and picks the provider from the model pattern;
      // anthropic is the closest thing to a house default.
      const env = withCommonBinPaths(applyModelEnv({ ...process.env }, request.model, 'anthropic'));
      if (request.extraEnv) Object.assign(env, request.extraEnv);

      const childProcess: ChildProcess = spawn('pi', args, {
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
      let finalText = '';
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

      const handleEvent = (event: PiEvent) => {
        switch (event.type) {
          case 'session':
            if (event.id) capturedSessionId = event.id;
            break;
          case 'message_update': {
            const update = event.assistantMessageEvent;
            if (!update?.delta) break;
            if (update.type === 'text_delta') {
              streamedText += update.delta;
              request.onStream?.(update.delta);
            } else if (update.type === 'thinking_delta') {
              thinkingText += update.delta;
              request.onThinking?.(update.delta);
            }
            break;
          }
          case 'message_end':
            // The final authoritative message. A later assistant message
            // replaces an earlier one — the last turn is the answer.
            if (event.message?.role === 'assistant') {
              const text = piTextFromMessage(event.message);
              if (text) finalText = text;
              tokens = piTokensFrom(tokens, event.message.usage);
              if (event.message.stopReason === 'error' || event.message.stopReason === 'aborted') {
                errorMessage = event.message.errorMessage || `pi turn ${event.message.stopReason}`;
              }
            }
            break;
          case 'tool_execution_start':
          case 'tool_execution_end': {
            const observed = piToolEvent(event);
            if (observed) tools.record(observed);
            // pi's task-list tool, if the model uses one, arrives as an
            // ordinary tool call with a `todos` argument.
            if (event.type === 'tool_execution_start' && isChecklistTool(event.toolName)) {
              checklist.record(checklistFromTodos(event.args));
            }
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
            handleEvent(JSON.parse(trimmed) as PiEvent);
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
          try { handleEvent(JSON.parse(buffer.trim()) as PiEvent); } catch { /* ignore */ }
        }

        const duration = Math.round((Date.now() - startTime) / 1000);
        const cls = classifyPiRunResult({ code, finalText, streamedText, stderr, errorMessage });
        this.debug(`[pi] Exit ${code}, ${cls.output.length} chars, tokens: ${tokens?.total ?? 'none'}`);

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
        this.debug(`[pi] Spawn error: ${err.message}`);
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
