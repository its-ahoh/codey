import { spawn, ChildProcess } from 'child_process';
import { AgentRequest, AgentResponse, AgentStateEntry, StatusUpdate } from '../types';
import { BaseAgentAdapter } from './base';
import { AgentSpawnError } from '../errors';
import { thinkingDeltaFrom } from './thinking-stream';
import { writeClaudeMcpConfig } from './mcp-config';
import { ChecklistTracker, checklistFromTodos, isChecklistTool } from './checklist';
import { claudeEffortArgs } from './effort';

export interface StreamEvent {
  type: string;
  subtype?: string;
  session_id?: string;
  // result event
  result?: string;
  is_error?: boolean;
  total_cost_usd?: number;
  duration_ms?: number;
  duration_api_ms?: number;
  num_turns?: number;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  // assistant event
  message?: {
    content: Array<{
      type: string;
      text?: string;
      thinking?: string;   // thinking block: reasoning text
      name?: string;       // tool_use block: tool name
      id?: string;         // tool_use block: call id
      input?: Record<string, unknown>; // tool_use block: input
      tool_use_id?: string; // tool_result block in a user message
      content?: unknown;   // tool_result payload (string or content blocks)
      is_error?: boolean;
    }>;
  };
  // tool_result event
  content?: Array<{
    type: string;
    text?: string;
    content?: string;
  }>;
  tool_use_id?: string;
  // stream_event (emitted with --include-partial-messages)
  event?: {
    type: string;
    delta?: { type?: string; text?: string; thinking?: string };
    content_block?: { type?: string; name?: string; id?: string };
  };
  // permission_denials in result event
  permission_denials?: Array<{ tool_name: string; tool_input?: Record<string, unknown> }>;
}

export interface ClaudeToolResult {
  toolUseId?: string;
  text?: string;
  isError?: boolean;
  backgroundTask?: ClaudeBackgroundTask;
}

export interface ClaudeBackgroundTask {
  id: string;
  outputPath?: string;
}

const FOREGROUND_ONLY_SYSTEM_PROMPT = [
  'Codey owns the lifecycle of this non-interactive turn and cannot receive deferred wakeups.',
  'Run every command and subagent in the foreground and wait for it to finish before ending the turn.',
  'Do not use run_in_background, ScheduleWakeup, detached processes, shell &, nohup, or similar mechanisms.',
  'If a command cannot finish within this turn, stop it and clearly tell the user what remains.',
].join(' ');

function toolResultText(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .map(block => {
      if (typeof block === 'string') return block;
      if (!block || typeof block !== 'object') return '';
      const item = block as { text?: unknown; content?: unknown };
      if (typeof item.text === 'string') return item.text;
      return typeof item.content === 'string' ? item.content : '';
    })
    .filter(Boolean)
    .join('\n');
  return text || undefined;
}

/**
 * Normalize tool results across Claude CLI stream-json versions.
 *
 * Current CLIs emit results as `user.message.content[]` blocks. Older SDK
 * streams and a few MCP integrations have emitted a top-level `tool_result`
 * event instead, so retain support for both shapes.
 */
export function extractClaudeToolResults(event: StreamEvent): ClaudeToolResult[] {
  const normalize = (toolUseId: string | undefined, content: unknown, isError: boolean | undefined): ClaudeToolResult => {
    const text = toolResultText(content);
    return { toolUseId, text, isError, backgroundTask: extractClaudeBackgroundTask(text) };
  };
  if (event.type === 'tool_result') {
    return [normalize(event.tool_use_id, event.content, event.is_error)];
  }
  if (event.type === 'user' && event.tool_use_id) {
    return [normalize(event.tool_use_id, event.content, event.is_error)];
  }
  if (event.type !== 'user' || !Array.isArray(event.message?.content)) return [];
  return event.message.content
    .filter(block => block.type === 'tool_result')
    .map(block => normalize(block.tool_use_id, block.content, block.is_error));
}

/** Parse both timeout-driven and explicitly requested Bash background results. */
export function extractClaudeBackgroundTask(text?: string): ClaudeBackgroundTask | undefined {
  if (!text) return undefined;
  const id = text.match(/moved to the background \(ID:\s*([^)\s]+)\)/i)?.[1]
    ?? text.match(/running in background with ID:\s*([^\s.]+)/i)?.[1];
  if (!id) return undefined;
  const outputPath = text.match(/Output is being written to:\s*([^\n]+?)(?:\.\s|\n|$)/i)?.[1]?.trim();
  return { id, ...(outputPath ? { outputPath } : {}) };
}

/** Keep Claude's shell work inside the lifecycle of the print-mode process. */
export function applyClaudeForegroundGuard(env: NodeJS.ProcessEnv, turnTimeoutMs = 900_000): void {
  // This is a correctness requirement: detached tasks are killed when the
  // non-interactive Claude process exits, so an extraEnv override is unsafe.
  env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS = '1';

  // Claude otherwise auto-backgrounds eligible Bash commands after its
  // 120-second default. Give the command almost the whole Codey turn while
  // reserving enough time for Claude to consume the result and reply.
  const boundedTurnTimeout = Number.isFinite(turnTimeoutMs) && turnTimeoutMs > 0
    ? turnTimeoutMs
    : 900_000;
  const graceMs = Math.min(30_000, Math.max(1_000, Math.floor(boundedTurnTimeout / 10)));
  const bashTimeoutMs = Math.max(1_000, Math.floor(boundedTurnTimeout - graceMs));
  if (!env.BASH_DEFAULT_TIMEOUT_MS) env.BASH_DEFAULT_TIMEOUT_MS = String(bashTimeoutMs);
  if (!env.BASH_MAX_TIMEOUT_MS) env.BASH_MAX_TIMEOUT_MS = String(bashTimeoutMs);
}

export interface ClaudeRunClassification {
  success: boolean;
  output: string;
  error?: string;
}

/**
 * Classify a finished `claude` process into a success or failure response.
 *
 * The CLI reports API-level failures (402 Insufficient Balance, session
 * limits, unknown models) as a stream-json `result` event with `is_error:
 * true` and the message in `result` — and it can exit 0 for those. Exit code
 * alone is therefore not a reliable failure signal; the result event's
 * `is_error` flag must win. When it is set, the API message is also preferred
 * over stderr, which may only hold an auth-source warning.
 */
export function classifyClaudeRunResult(input: {
  code: number | null;
  result: string;
  streamedText: string;
  stderr: string;
  resultIsError: boolean;
  hasUserQuestion: boolean;
}): ClaudeRunClassification {
  const { code, result, streamedText, stderr, resultIsError, hasUserQuestion } = input;
  const output = result || streamedText;
  if (hasUserQuestion) return { success: true, output };
  if (code === 0 && output && !resultIsError) return { success: true, output };
  const error = resultIsError
    ? (output || stderr || `Claude Code exited with code ${code}`)
    : (stderr || (code !== 0 ? `Claude Code exited with code ${code}` : 'Claude Code returned empty response'));
  return { success: false, output, error };
}

export class ClaudeCodeAdapter extends BaseAgentAdapter {
  name = 'claude-code';
  private sessionId?: string;
  private debug: (msg: string) => void;
  private activeProcess?: ChildProcess;

  constructor(debug?: (msg: string) => void) {
    super();
    this.debug = debug ?? (() => {});
  }

  async run(request: AgentRequest): Promise<AgentResponse> {
    return new Promise((resolve) => {
      const timeout = request.timeout || 900000;
      const args = [
        '--verbose',
        '--output-format', 'stream-json',
        '--include-partial-messages',
        '--append-system-prompt', FOREGROUND_ONLY_SYSTEM_PROMPT,
      ];
      args.push(...claudeEffortArgs(request.effort));

      if (request.skipPermissions) {
        args.push('--dangerously-skip-permissions');
      }

      if (request.allowedTools && request.allowedTools.length > 0) {
        args.push('--allowedTools', request.allowedTools.join(' '));
      }

      // The gateway decides whether to resume a warm session or bootstrap
      // a fresh one with full history. `--resume` continues an existing
      // session; `--session-id` pins a pre-allocated UUID so the gateway
      // can resume the same id on later turns without parsing it back out.
      if (request.resumeSessionId) {
        args.push('--resume', request.resumeSessionId);
      } else if (request.newSessionId) {
        args.push('--session-id', request.newSessionId);
      }

      // Add model configuration if provided
      if (request.model) {
        args.push('--model', request.model.model);
      }

      let mcpCleanup: (() => void) | undefined;
      if (request.mcpServers && Object.keys(request.mcpServers).length > 0) {
        const mcp = writeClaudeMcpConfig(request.mcpServers);
        args.push(...mcp.args);
        mcpCleanup = mcp.cleanup;
      }

      // -p with prompt must be last (matches tested CLI format)
      args.push('-p', request.prompt);

      // Clean env: remove CLAUDECODE to avoid nested session detection
      const env = { ...process.env };
      delete env.CLAUDECODE;
      // Route credentials by apiType (defaults to anthropic for claude-code)
      const { applyModelEnv } = require('./env') as typeof import('./env');
      applyModelEnv(env, request.model, 'anthropic');
      // User-configured per-agent env wins over credentials — lets power users
      // pin CLAUDE_CONFIG_DIR / ANTHROPIC_AUTH_TOKEN explicitly when needed.
      if (request.extraEnv) Object.assign(env, request.extraEnv);

      // Claude Code background tasks detach from the foreground tool call but
      // do not survive print-mode teardown. Codey cannot receive a later
      // completion notification, so the UI would otherwise mark the turn done
      // even though the requested work never completed. The native CLI switch
      // removes run_in_background support and the Bash timeout is kept just
      // inside this turn's own timeout.
      applyClaudeForegroundGuard(env, timeout);

      // MCP tool calls can legitimately block for minutes (e.g. the browser
      // permission gate waits for the user). Default to generous timeouts,
      // but let explicit user env win.
      if (request.mcpServers && Object.keys(request.mcpServers).length > 0) {
        if (!env.MCP_TIMEOUT) env.MCP_TIMEOUT = '60000';
        if (!env.MCP_TOOL_TIMEOUT) env.MCP_TOOL_TIMEOUT = '600000';
      }

      // Ensure common bin paths are available (Electron apps may have minimal PATH)
      const { withCommonBinPaths } = require('./env') as typeof import('./env');
      withCommonBinPaths(env);

      const claudeBin = process.env.CLAUDE_BIN || 'claude';
      this.debug(`[claude-code] Spawning: ${claudeBin} ${args.slice(0, -1).join(' ')} "<prompt>"`);
      const childProcess: ChildProcess = spawn(claudeBin, args, {
        stdio: [request.interactive ? 'inherit' : 'pipe', 'pipe', request.interactive ? 'inherit' : 'pipe'],
        cwd: request.context?.workingDir || undefined,
        env,
      });
      this.activeProcess = childProcess;

      childProcess.on('close', () => {
        mcpCleanup?.();
        this.activeProcess = undefined;
      });

      // Close stdin for non-interactive mode so the child process doesn't hang
      if (!request.interactive) {
        childProcess.stdin?.end();
      }

      const startTime = Date.now();
      let resolved = false;
      let result = '';
      let streamedText = '';
      let buffer = '';
      let stderr = '';
      // The CLI reports API failures (402, session limit, unknown model) as a
      // `result` event with is_error:true — sometimes with a 0 exit code.
      // Track it so the close handler can classify the run as a failure.
      let resultIsError = false;
      let tokens: AgentResponse['tokens'];
      let durationSec: number | undefined;
      const statusUpdates: string[] = [];
      const states: AgentStateEntry[] = [];
      // Track pending tool_use calls by id so we can pair them with tool_result
      const pendingTools = new Map<string, { name: string; input?: Record<string, unknown> }>();
      const detachedBackgroundTasks = new Map<string, ClaudeBackgroundTask>();
      const checklist = new ChecklistTracker(request.onStatus);
      let permissionDenials: Array<{ toolName: string; toolInput?: Record<string, unknown> }> = [];
      let userQuestion: AgentResponse['userQuestion'];
      let askUserInputJson = '';
      let collectingAskUser = false;

      const safeResolve = (response: AgentResponse) => {
        if (!resolved) {
          resolved = true;
          resolve(response);
        }
      };

      // With --include-partial-messages, the SDK emits stream_event deltas
      // before the final assistant event. We stream from those deltas so the
      // UI updates token-by-token; the final assistant event then re-emits
      // the same text in one block — skip the onStream call there to avoid
      // double-rendering, but still record blocks (tool_use) and tally.
      let thinkingText = '';
      let streamedThinkingFromDeltas = false;
      let streamedFromDeltas = false;
      const processEvent = (event: StreamEvent) => {
        this.debug(`[claude-code] Event: ${event.type} ${event.subtype || ''}`);

        const toolResults = extractClaudeToolResults(event);
        for (const toolResult of toolResults) {
          const pending = toolResult.toolUseId ? pendingTools.get(toolResult.toolUseId) : undefined;
          const toolName = pending?.name || 'tool';
          if (toolResult.backgroundTask) {
            detachedBackgroundTasks.set(toolResult.backgroundTask.id, toolResult.backgroundTask);
          }
          const outcome = toolResult.isError || toolResult.backgroundTask ? 'failed' : 'done';

          statusUpdates.push(`${toolName}: ${outcome}`);
          states.push({
            source: toolName,
            status: outcome,
            input: pending?.input,
            output: toolResult.text ? toolResult.text.substring(0, 1000) : undefined,
          });
          request.onStatus?.({
            type: 'tool_end',
            tool: toolName,
            message: `${toolName}: ${outcome}`,
            output: toolResult.text,
          });

          if (toolResult.toolUseId) pendingTools.delete(toolResult.toolUseId);
        }

        if (event.type === 'system' && event.session_id) {
          this.sessionId = event.session_id;
        } else if (event.type === 'stream_event' && event.event?.type === 'content_block_start') {
          const cb = event.event.content_block;
          if (cb?.type === 'tool_use' && cb.name === 'AskUserQuestion') {
            collectingAskUser = true;
            askUserInputJson = '';
          }
          // thinking blocks need no start-time setup; captured in the delta branch below
        } else if (event.type === 'stream_event' && event.event?.type === 'content_block_delta') {
          const thinking = thinkingDeltaFrom(event);
          if (thinking !== null) {
            thinkingText += thinking;
            request.onThinking?.(thinking);
            streamedThinkingFromDeltas = true;
          }
          const delta = event.event.delta;
          if (delta?.type === 'text_delta' && delta.text) {
            streamedText += delta.text;
            request.onStream?.(delta.text);
            streamedFromDeltas = true;
          } else if (collectingAskUser && delta?.type === 'input_json_delta') {
            askUserInputJson += (delta as any).partial_json ?? (delta as any).text ?? '';
          }
        } else if (event.type === 'stream_event' && event.event?.type === 'content_block_stop') {
          if (collectingAskUser && askUserInputJson) {
            collectingAskUser = false;
            try {
              const inp = JSON.parse(askUserInputJson);
              const questions = Array.isArray(inp.questions) ? inp.questions : [];
              const q = questions[0];
              if (q?.question && Array.isArray(q.options) && q.options.length >= 2) {
                userQuestion = {
                  question: q.question,
                  options: q.options
                    .filter((o: any) => o && typeof o.label === 'string')
                    .map((o: any) => ({ label: o.label, description: o.description })),
                  multiSelect: q.multiSelect === true,
                };
                childProcess.kill('SIGTERM');
              }
            } catch { /* ignore parse failure */ }
          }
        } else if (event.type === 'assistant' && event.message?.content) {
          for (const block of event.message.content) {
            if (block.type === 'thinking' && block.thinking) {
              if (!streamedThinkingFromDeltas) {
                thinkingText += block.thinking;
              }
            } else if (block.type === 'text' && block.text) {
              if (!streamedFromDeltas) {
                streamedText += block.text;
                request.onStream?.(block.text);
              }
            } else if (block.type === 'tool_use' && block.name) {
              // Tool invocation — record it
              const toolName = block.name;
              if (block.id) {
                pendingTools.set(block.id, { name: toolName, input: block.input });
              }

              if (toolName === 'AskUserQuestion' && block.input) {
                const inp = block.input as any;
                const questions = Array.isArray(inp.questions) ? inp.questions : [];
                const q = questions[0];
                if (q?.question && Array.isArray(q.options)) {
                  userQuestion = {
                    question: q.question,
                    options: q.options
                      .filter((o: any) => o && typeof o.label === 'string')
                      .map((o: any) => ({ label: o.label, description: o.description })),
                    multiSelect: q.multiSelect === true,
                  };
                  // Kill the process — it's waiting for interactive input we can't provide.
                  // The gateway will resume the session with the user's answer on the next turn.
                  childProcess.kill('SIGTERM');
                }
              }

              const inputSummary = block.input
                ? Object.entries(block.input).map(([k, v]) => {
                    const val = typeof v === 'string' ? v : JSON.stringify(v);
                    return `${k}: ${val && val.length > 80 ? val.substring(0, 80) + '...' : val}`;
                  }).join(', ')
                : '';
              if (isChecklistTool(toolName)) {
                checklist.record(checklistFromTodos(block.input));
              }

              statusUpdates.push(`${toolName}: running`);
              states.push({
                source: toolName,
                status: 'running',
                input: block.input,
              });
              request.onStatus?.({
                type: 'tool_start',
                tool: toolName,
                message: inputSummary ? `${toolName}(${inputSummary})` : toolName,
                input: block.input,
              });
            }
          }
        } else if (event.type === 'result') {
          if (event.session_id) {
            this.sessionId = event.session_id;
          }
          if (event.result) {
            result = event.result;
          }
          if (event.is_error) {
            resultIsError = true;
          }
          if (event.usage) {
            const input = event.usage.input_tokens;
            const output = event.usage.output_tokens;
            tokens = {
              total: input + output,
              input,
              output,
              cache: (event.usage.cache_read_input_tokens || event.usage.cache_creation_input_tokens)
                ? {
                    read: event.usage.cache_read_input_tokens || 0,
                    write: event.usage.cache_creation_input_tokens || 0,
                  }
                : undefined,
            };
          }
          if (event.duration_ms != null) {
            durationSec = Math.round(event.duration_ms / 1000);
          }
          if (event.permission_denials && event.permission_denials.length > 0) {
            permissionDenials = event.permission_denials.map(d => ({
              toolName: d.tool_name,
              toolInput: d.tool_input,
            }));
          }
        }
      };

      childProcess.stdout?.on('data', (data: Buffer) => {
        buffer += data.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            processEvent(JSON.parse(line));
          } catch {
            // Skip non-JSON lines
          }
        }
      });

      childProcess.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      childProcess.on('close', (code: number | null) => {
        this.debug(`[claude-code] Process exited with code ${code}`);

        // Process any remaining buffer
        if (buffer.trim()) {
          try {
            processEvent(JSON.parse(buffer));
          } catch {
            // Skip
          }
        }

        // Use result from result event, fall back to accumulated streamed text
        const output = result || streamedText;
        // Fall back to wall-clock duration if the result event didn't include one
        const finalDuration = durationSec ?? Math.round((Date.now() - startTime) / 1000);

        // Fallback: parse AskUserQuestion JSON from streamed text if the
        // tool_use block detection didn't fire (e.g. assistant event never
        // arrived because CLI blocked on interactive input).
        if (!userQuestion && output) {
          const parsed = ClaudeCodeAdapter.parseAskUserQuestionFromText(output);
          if (parsed) userQuestion = parsed;
        }

        const cls = classifyClaudeRunResult({
          code,
          result,
          streamedText,
          stderr,
          resultIsError,
          hasUserQuestion: !!userQuestion,
        });

        // Older Claude versions can ignore the foreground switch and return a
        // background task handle. Such a task is killed during print-mode
        // teardown, so never turn a friendly assistant sentence into a false
        // successful completion.
        if (detachedBackgroundTasks.size > 0) {
          this.sessionId = undefined;
          const tasks = [...detachedBackgroundTasks.values()]
            .map(task => task.outputPath ? `${task.id} (${task.outputPath})` : task.id)
            .join(', ');
          const message = `Claude Code detached background task ${tasks}; it did not complete and was stopped when the CLI turn exited. Please retry the command in the foreground.`;
          safeResolve(this.createResponse(message, false, tokens, finalDuration, statusUpdates, states));
          return;
        }

        if (userQuestion) {
          const resp = this.createResponse(cls.output || userQuestion.question, true, tokens, finalDuration, statusUpdates, states);
          resp.userQuestion = userQuestion;
          safeResolve(resp);
        } else if (cls.success) {
          const successResp = this.createResponse(cls.output, true, tokens, finalDuration, statusUpdates, states, permissionDenials);
          successResp.thinking = thinkingText || undefined;
          safeResolve(successResp);
        } else {
          // Clear session on failure to avoid "session already in use" errors
          this.sessionId = undefined;
          const message = cls.error ?? (code !== 0 ? `Claude Code exited with code ${code}` : 'Claude Code returned empty response');
          this.debug(`[claude-code] Error: ${message}`);
          safeResolve(this.createResponse(message, false, undefined, finalDuration, statusUpdates, states));
        }
      });

      childProcess.on('error', (err: Error) => {
        mcpCleanup?.();
        const duration = Math.round((Date.now() - startTime) / 1000);
        this.debug(`[claude-code] Spawn error: ${err.message}`);
        const spawnError = new AgentSpawnError(this.name, err.message);
        safeResolve(this.createResponse(spawnError.message, false, undefined, duration));
      });

      // Safety timeout so we don't hang forever if the CLI never responds.
      // Timeout (default 15 minutes)
      setTimeout(() => {
        if (!resolved) {
          childProcess.kill();
          const duration = Math.round((Date.now() - startTime) / 1000);
          safeResolve(this.createResponse(`Timeout after ${Math.round(timeout / 60000)} minutes`, false, undefined, duration));
        }
      }, timeout);

      // Caller-driven cancellation
      if (request.signal) {
        const onAbort = () => {
          if (resolved) return;
          this.sessionId = undefined;
          try { childProcess.kill('SIGTERM'); } catch { /* already dead */ }
          const duration = Math.round((Date.now() - startTime) / 1000);
          safeResolve(this.createResponse('Stopped', false, undefined, duration, statusUpdates, states));
        };
        if (request.signal.aborted) onAbort();
        else request.signal.addEventListener('abort', onAbort, { once: true });
      }
    });
  }

  resetSession(): void {
    this.sessionId = undefined;
  }

  dispose(): void {
    if (this.activeProcess) {
      this.activeProcess.kill('SIGTERM');
      this.activeProcess = undefined;
    }
  }

  static parseAskUserQuestionFromText(text: string): AgentResponse['userQuestion'] | null {
    // Match a JSON object containing "questions" with "options" arrays.
    // The JSON may be embedded in surrounding text.
    const idx = text.indexOf('"questions"');
    if (idx === -1) return null;
    // Walk backwards to find the opening brace
    let braceStart = text.lastIndexOf('{', idx);
    if (braceStart === -1) return null;
    // Try progressively larger substrings to find valid JSON
    for (let end = text.indexOf('}', idx); end !== -1; end = text.indexOf('}', end + 1)) {
      try {
        const obj = JSON.parse(text.substring(braceStart, end + 1));
        const questions = Array.isArray(obj.questions) ? obj.questions : [];
        const q = questions[0];
        if (q?.question && Array.isArray(q.options) && q.options.length >= 2) {
          return {
            question: q.question,
            options: q.options
              .filter((o: any) => o && typeof o.label === 'string')
              .map((o: any) => ({ label: o.label, description: o.description })),
            multiSelect: q.multiSelect === true,
          };
        }
      } catch { /* keep searching */ }
    }
    return null;
  }
}
