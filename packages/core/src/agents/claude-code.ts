import { spawn, ChildProcess } from 'child_process';
import { AgentRequest, AgentResponse, AgentStateEntry, StatusUpdate } from '../types';
import { BaseAgentAdapter } from './base';
import { AgentSpawnError } from '../errors';

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
}

export class ClaudeCodeAdapter extends BaseAgentAdapter {
  name = 'claude-code';
  private sessionId?: string;
  private debug: (msg: string) => void;

  constructor(debug?: (msg: string) => void) {
    super();
    this.debug = debug ?? (() => {});
  }

  async run(request: AgentRequest): Promise<AgentResponse> {
    return new Promise((resolve) => {
      const args = [
        '--verbose',
        '--output-format', 'stream-json',
      ];

      // Only skip permissions for non-interactive (chat platform) usage
      if (!request.interactive) {
        args.push('--dangerously-skip-permissions');
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

      // -p with prompt must be last (matches tested CLI format)
      args.push('-p', request.prompt);

      // Clean env: remove CLAUDECODE to avoid nested session detection
      const env = { ...process.env };
      delete env.CLAUDECODE;
      // Route credentials by apiType (defaults to anthropic for claude-code)
      const { applyModelEnv } = require('./env') as typeof import('./env');
      applyModelEnv(env, request.model, 'anthropic');

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

      const safeResolve = (response: AgentResponse) => {
        if (!resolved) {
          resolved = true;
          resolve(response);
        }
      };

      const processEvent = (event: StreamEvent) => {
        this.debug(`[claude-code] Event: ${event.type} ${event.subtype || ''}`);

        if (event.type === 'system' && event.session_id) {
          this.sessionId = event.session_id;
        } else if (event.type === 'assistant' && event.message?.content) {
          for (const block of event.message.content) {
            if (block.type === 'text' && block.text) {
              streamedText += block.text;
              request.onStream?.(block.text);
            } else if (block.type === 'tool_use' && block.name) {
              // Tool invocation — record it
              const toolName = block.name;
              if (block.id) {
                pendingTools.set(block.id, { name: toolName, input: block.input });
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

        if (code === 0 && output) {
          safeResolve(this.createResponse(output, true, tokens, finalDuration, statusUpdates, states));
        } else {
          // Clear session on failure to avoid "session already in use" errors
          this.sessionId = undefined;
          const error = stderr || (code !== 0 ? `Claude Code exited with code ${code}` : 'Claude Code returned empty response');
          this.debug(`[claude-code] Error: ${error}`);
          safeResolve(this.createResponse(error, false, undefined, finalDuration, statusUpdates, states));
        }
      });

      childProcess.on('error', (err: Error) => {
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
}
