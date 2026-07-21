import { spawn, ChildProcess } from 'child_process';
import { AgentRequest, AgentResponse, AgentStateEntry, StatusUpdate } from '../types';
import { BaseAgentAdapter } from './base';
import { AgentSpawnError } from '../errors';
import { thinkingDeltaFrom } from './thinking-stream';
import { writeClaudeMcpConfig } from './mcp-config';

interface StreamEvent {
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
      const args = [
        '--verbose',
        '--output-format', 'stream-json',
        '--include-partial-messages',
      ];

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

      // MCP tool calls can legitimately block for minutes (e.g. the browser
      // permission gate waits for the user). Default to generous timeouts,
      // but let explicit user env win.
      if (request.mcpServers && Object.keys(request.mcpServers).length > 0) {
        if (!env.MCP_TIMEOUT) env.MCP_TIMEOUT = '60000';
        if (!env.MCP_TOOL_TIMEOUT) env.MCP_TOOL_TIMEOUT = '600000';
      }

      // Ensure common bin paths are available (Electron apps may have minimal PATH)
      const homedir = process.env.HOME || '';
      const extraPaths = [
        `${homedir}/.local/bin`,
        '/usr/local/bin',
        '/opt/homebrew/bin',
      ].filter(Boolean);
      const currentPath = env.PATH || '';
      for (const p of extraPaths) {
        if (!currentPath.includes(p)) {
          env.PATH = `${p}:${env.PATH}`;
        }
      }

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
      let tokens: AgentResponse['tokens'];
      let durationSec: number | undefined;
      const statusUpdates: string[] = [];
      const states: AgentStateEntry[] = [];
      // Track pending tool_use calls by id so we can pair them with tool_result
      const pendingTools = new Map<string, { name: string; input?: Record<string, unknown> }>();
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
        } else if (event.type === 'tool_result' || (event.type === 'user' && event.tool_use_id)) {
          // Tool result — match to pending call
          const toolId = event.tool_use_id;
          const pending = toolId ? pendingTools.get(toolId) : undefined;
          const toolName = pending?.name || 'tool';
          const resultText = event.content
            ?.map(c => c.text || c.content || '')
            .filter(Boolean)
            .join('\n');

          statusUpdates.push(`${toolName}: done`);
          states.push({
            source: toolName,
            status: 'done',
            input: pending?.input,
            output: resultText ? resultText.substring(0, 1000) : undefined,
          });
          request.onStatus?.({
            type: 'tool_end',
            tool: toolName,
            message: `${toolName}: done`,
            output: resultText,
          });

          if (toolId) pendingTools.delete(toolId);
        } else if (event.type === 'result') {
          if (event.session_id) {
            this.sessionId = event.session_id;
          }
          if (event.result) {
            result = event.result;
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

        if (userQuestion) {
          const resp = this.createResponse(output || userQuestion.question, true, tokens, finalDuration, statusUpdates, states);
          resp.userQuestion = userQuestion;
          safeResolve(resp);
        } else if (code === 0 && output) {
          const successResp = this.createResponse(output, true, tokens, finalDuration, statusUpdates, states, permissionDenials);
          successResp.thinking = thinkingText.trim() || undefined;
          safeResolve(successResp);
        } else {
          // Clear session on failure to avoid "session already in use" errors
          this.sessionId = undefined;
          const error = stderr || (code !== 0 ? `Claude Code exited with code ${code}` : 'Claude Code returned empty response');
          this.debug(`[claude-code] Error: ${error}`);
          safeResolve(this.createResponse(error, false, undefined, finalDuration, statusUpdates, states));
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
      const timeout = request.timeout || 900000;
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
