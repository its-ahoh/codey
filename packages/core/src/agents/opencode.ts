import { spawn, ChildProcess } from 'child_process';
import { AgentRequest, AgentResponse } from '../types';
import { BaseAgentAdapter } from './base';
import { AgentSpawnError } from '../errors';

interface OpenCodeEvent {
  type: string;
  sessionID?: string;
  part?: {
    type: string;
    text?: string;
    reason?: string;
    tool?: string;
    state?: {
      status?: string;
      input?: Record<string, unknown>;
      output?: unknown;
    };
    tokens?: {
      total: number;
      input: number;
      output: number;
      reasoning?: number;
      cache?: {
        read: number;
        write: number;
      };
    };
  };
}

export class OpenCodeAdapter extends BaseAgentAdapter {
  name = 'opencode';
  private debug: (msg: string) => void;
  private activeProcess?: ChildProcess;

  constructor(debug?: (msg: string) => void) {
    super();
    this.debug = debug ?? (() => {});
  }

  async run(request: AgentRequest): Promise<AgentResponse> {
    return new Promise((resolve) => {
      const args = ['run', '--format', 'json'];

      // Resume an existing session when the gateway has a warm anchor for
      // this conversation. OpenCode generates the session id itself on
      // bootstrap; we capture it from the first event below.
      if (request.resumeSessionId) {
        args.push('-s', request.resumeSessionId);
      }

      // Add model configuration if provided
      if (request.model?.model) {
        args.push('--model', request.model.model);
      }

      args.push(request.prompt);

      this.debug(`[opencode] Spawning: opencode ${args.slice(0, -1).join(' ')} "<prompt>"`);

      const { applyModelEnv } = require('./env') as typeof import('./env');
      // OpenCode is provider-agnostic; default to openai if apiType unset.
      const env = applyModelEnv({ ...process.env }, request.model, 'openai');
      const childProcess: ChildProcess = spawn('opencode', args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: request.context?.workingDir || undefined,
        env,
      });
      this.activeProcess = childProcess;

      childProcess.on('close', () => {
        this.activeProcess = undefined;
      });

      // Track start time for duration calculation
      const startTime = Date.now();
      let resolved = false;
      let allData = '';
      let stderr = '';
      const statusUpdates: string[] = [];
      const states: NonNullable<AgentResponse['states']> = [];
      // Captured from the top-level `sessionID` field present on every event
      // (e.g. `step_start`, `text`, `step_finish`). The first event we see
      // tells us which session OpenCode opened so the gateway can resume it.
      let capturedSessionId: string | undefined;

      const safeResolve = (response: AgentResponse) => {
        if (!resolved) {
          resolved = true;
          resolve(response);
        }
      };

      // Collect and parse stdout in real-time for streaming
      let buffer = '';
      childProcess.stdout?.on('data', (data: Buffer) => {
        buffer += data.toString();
        allData += data.toString();

        // Parse complete lines (newline-terminated)
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const event: OpenCodeEvent = JSON.parse(line);

            if (!capturedSessionId && event.sessionID) {
              capturedSessionId = event.sessionID;
            }

            // Stream text events immediately
            if (event.type === 'text' && event.part?.text) {
              request.onStream?.(event.part.text);
            }

            if (event.type === 'tool_use' && event.part?.state) {
              const toolName = event.part.tool || 'tool_use';
              if (event.part.state.status) {
                statusUpdates.push(`${toolName}: ${event.part.state.status}`);
              }
              states.push({
                source: toolName,
                status: event.part.state.status,
                input: event.part.state.input,
                output: event.part.state.output,
              });
            }
          } catch {
            // Not JSON, skip
          }
        }
      });

      childProcess.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      // Process close - collect remaining buffer and resolve
      childProcess.on('close', (code: number | null) => {
        // Process remaining buffer
        if (buffer.trim()) {
          try {
            const event: OpenCodeEvent = JSON.parse(buffer);
            if (event.type === 'text' && event.part?.text) {
              request.onStream?.(event.part.text);
            }
          } catch {
            // Not JSON
          }
        }

        // Parse all collected output for final response
        const textParts: string[] = [];
        const cleanData = allData.replace(/\r/g, '');

        // Extract JSON lines
        const jsonLines = cleanData.split('\n')
          .map(l => l.trim())
          .filter(l => l.startsWith('{'));

        // Track tokens from step_finish events
        let tokens: AgentResponse['tokens'];

        for (const line of jsonLines) {
          try {
            const event: OpenCodeEvent = JSON.parse(line);

            // Handle text events
            if (event.type === 'text' && event.part?.text) {
              textParts.push(event.part.text);
            }

            // Handle tool_use events
            if (event.type === 'tool_use' && event.part?.state?.output) {
              const output = event.part.state.output;
              if (output && typeof output === 'object') {
                const outputStr = JSON.stringify(output);
                textParts.push(`[${event.part.tool}: ${outputStr.substring(0, 500)}]\n`);
              }
            }

            // Extract tokens from step_finish
            if (event.type === 'step_finish' && event.part?.tokens) {
              tokens = event.part.tokens;
            }
          } catch {
            // Not JSON
          }
        }

        this.debug(`[opencode] Parsed ${textParts.length} text parts from ${jsonLines.length} JSON lines, tokens: ${tokens?.total || 'none'}`);

        // Calculate duration
        const duration = Math.round((Date.now() - startTime) / 1000);

        const output = textParts.join('');
        if (output) {
          const resp = this.createResponse(output, true, tokens, duration, statusUpdates, states);
          resp.sessionId = capturedSessionId;
          safeResolve(resp);
        } else {
          const error = stderr.trim() || `OpenCode exited with code ${code}`;
          this.debug(`[opencode] Error: ${error}`);
          const resp = this.createResponse(error, false, undefined, duration, statusUpdates, states);
          resp.sessionId = capturedSessionId;
          safeResolve(resp);
        }
      });

      childProcess.on('error', (err: Error) => {
        const duration = Math.round((Date.now() - startTime) / 1000);
        this.debug(`[opencode] Spawn error: ${err.message}`);
        const spawnError = new AgentSpawnError(this.name, err.message);
        safeResolve(this.createResponse(spawnError.message, false, undefined, duration));
      });

      // Timeout (default 15 minutes)
      const timeout = request.timeout || 900000;
      setTimeout(() => {
        if (!resolved) {
          childProcess.kill();
          const duration = Math.round((Date.now() - startTime) / 1000);
          safeResolve(this.createResponse(`Timeout after ${Math.round(timeout / 60000)} minutes`, false, undefined, duration));
        }
      }, timeout);

      if (request.signal) {
        const onAbort = () => {
          if (resolved) return;
          try { childProcess.kill('SIGTERM'); } catch { /* already dead */ }
          const duration = Math.round((Date.now() - startTime) / 1000);
          safeResolve(this.createResponse('Stopped', false, undefined, duration, statusUpdates, states));
        };
        if (request.signal.aborted) onAbort();
        else request.signal.addEventListener('abort', onAbort, { once: true });
      }
    });
  }

  dispose(): void {
    if (this.activeProcess) {
      this.activeProcess.kill('SIGTERM');
      this.activeProcess = undefined;
    }
  }
}
