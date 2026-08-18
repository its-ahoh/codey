import { spawn, ChildProcess } from 'child_process';
import { AgentRequest, AgentResponse } from '../types';
import { BaseAgentAdapter } from './base';
import { AgentSpawnError } from '../errors';
import { writeOpenCodeMcpConfig } from './mcp-config';
import { ObservedToolEvent, ToolCallCollector } from './tool-events';
import { ChecklistTracker, checklistFromTodos, isChecklistTool } from './checklist';
import { opencodeEffortArgs } from './effort';
import { agentSpawnOptions, cleanupProcessTreeAfterClose, terminateProcessTree, withForegroundPolicy } from './process-tree';

export interface OpenCodeEvent {
  type: string;
  sessionID?: string;
  part?: {
    type: string;
    text?: string;
    reason?: string;
    tool?: string;
    id?: string;
    callID?: string;
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

/** Map one opencode `tool_use` part onto an observed tool event.
 *
 *  Verified against a real `run --format json` stream (opencode 1.14.18):
 *  the part carries `tool`, `callID`, and a `state` holding status, input and
 *  output. Only terminal states are reported — there is no "running" event —
 *  which is why ToolCallCollector synthesizes the start. */
export function opencodeToolEvent(part: NonNullable<OpenCodeEvent['part']>): ObservedToolEvent | null {
  if (!part.state) return null;
  return {
    tool: part.tool || 'tool_use',
    // callID identifies the call; `id` is absent on tool parts.
    key: part.callID ?? part.id ?? part.tool,
    status: part.state.status,
    input: part.state.input,
    output: part.state.output,
  };
}

export function isBackgroundOpenCodeTool(part: NonNullable<OpenCodeEvent['part']>): boolean {
  const input = part.state?.input;
  if (!input) return false;
  return input.run_in_background === true
    || input.background === true
    || input.detach === true;
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
      // --pure is an official OpenCode boundary: Codey cannot supervise task
      // IDs owned by external plugins, so external plugins are not loaded in
      // a foreground-only gateway turn.
      const args = ['run', '--format', 'json', '--pure'];
      if (request.skipPermissions) {
        args.push('--dangerously-skip-permissions');
      }

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
      args.push(...opencodeEffortArgs(request.effort));

      let mcpCleanup: (() => void) | undefined;
      let mcpEnv: Record<string, string> = {};
      if (request.mcpServers && Object.keys(request.mcpServers).length > 0) {
        const mcp = writeOpenCodeMcpConfig(request.mcpServers);
        mcpEnv = mcp.env;
        mcpCleanup = mcp.cleanup;
      }
      args.push(withForegroundPolicy(request.prompt));

      this.debug(`[opencode] Spawning: opencode ${args.slice(0, -1).join(' ')} "<prompt>"`);

      const { applyModelEnv, withCommonBinPaths } = require('./env') as typeof import('./env');
      // OpenCode is provider-agnostic; default to openai if apiType unset.
      const env = withCommonBinPaths(applyModelEnv({ ...process.env }, request.model, 'openai'));
      if (request.extraEnv) Object.assign(env, request.extraEnv);
      // User/plugin config must not re-enable OpenCode's own experimental
      // background-subagent facility for a Codey-owned foreground turn.
      env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS = 'false';
      // Deliberately after extraEnv: plugin MCP config must win even over a
      // user-supplied OPENCODE_CONFIG, or enabled plugins would silently vanish.
      Object.assign(env, mcpEnv);
      const childProcess: ChildProcess = spawn('opencode', args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: request.context?.workingDir || undefined,
        env,
        ...agentSpawnOptions(),
      });
      this.activeProcess = childProcess;

      childProcess.on('close', () => {
        mcpCleanup?.();
        cleanupProcessTreeAfterClose(childProcess);
        this.activeProcess = undefined;
      });

      // Track start time for duration calculation
      const startTime = Date.now();
      let resolved = false;
      let allData = '';
      let stderr = '';
      // opencode reports a tool once it has finished, so the collector
      // synthesizes the tool_start the chat surface needs to see a procedure.
      const tools = new ToolCallCollector(request.onStatus);
      const statusUpdates = tools.statusUpdates;
      const states = tools.states;
      const checklist = new ChecklistTracker(request.onStatus);
      // Captured from the top-level `sessionID` field present on every event
      // (e.g. `step_start`, `text`, `step_finish`). The first event we see
      // tells us which session OpenCode opened so the gateway can resume it.
      let capturedSessionId: string | undefined;
      let backgroundViolation: string | undefined;
      let timeoutTimer: NodeJS.Timeout | undefined;
      let abortHandler: (() => void) | undefined;

      const activityTimer = setInterval(() => {
        if (!resolved) {
          request.onStatus?.({
            type: 'info',
            message: 'OpenCode is still working; this CLI reports tool details when each tool finishes.',
          });
        }
      }, 15_000);
      activityTimer.unref?.();

      const safeResolve = (response: AgentResponse) => {
        if (!resolved) {
          resolved = true;
          clearInterval(activityTimer);
          if (timeoutTimer) clearTimeout(timeoutTimer);
          if (abortHandler && request.signal) request.signal.removeEventListener('abort', abortHandler);
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

            if (event.type === 'tool_use' && event.part) {
              if (isBackgroundOpenCodeTool(event.part)) {
                backgroundViolation = `Blocked background tool request: ${event.part.tool ?? 'tool_use'}`;
                terminateProcessTree(childProcess);
              }
              const observed = opencodeToolEvent(event.part);
              if (observed) tools.record(observed);
              if (isChecklistTool(event.part.tool)) {
                checklist.record(checklistFromTodos(event.part.state?.input));
              }
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
        tools.finish();
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
        if (backgroundViolation) {
          const resp = this.createResponse(backgroundViolation, false, undefined, duration, statusUpdates, states);
          resp.sessionId = capturedSessionId;
          safeResolve(resp);
        } else if (output) {
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
        mcpCleanup?.();
        const duration = Math.round((Date.now() - startTime) / 1000);
        this.debug(`[opencode] Spawn error: ${err.message}`);
        const spawnError = new AgentSpawnError(this.name, err.message);
        safeResolve(this.createResponse(spawnError.message, false, undefined, duration));
      });

      // Timeout (default 15 minutes)
      const timeout = request.timeout || 900000;
      timeoutTimer = setTimeout(() => {
        if (!resolved) {
          terminateProcessTree(childProcess);
          const duration = Math.round((Date.now() - startTime) / 1000);
          safeResolve(this.createResponse(`Timeout after ${Math.round(timeout / 60000)} minutes`, false, undefined, duration));
        }
      }, timeout);

      if (request.signal) {
        abortHandler = () => {
          if (resolved) return;
          terminateProcessTree(childProcess);
          const duration = Math.round((Date.now() - startTime) / 1000);
          safeResolve(this.createResponse('Stopped', false, undefined, duration, statusUpdates, states));
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
