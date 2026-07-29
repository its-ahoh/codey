import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { AgentRequest, AgentResponse, AgentStateEntry } from '../types';
import { BaseAgentAdapter } from './base';
import { AgentSpawnError } from '../errors';
import { ToolCallCollector } from './tool-events';
import { codexMcpArgs } from './mcp-config';

/**
 * Codex emits JSONL events to stdout when invoked with `--json`.
 * The shapes below are observed; unknown fields are tolerated.
 */
interface CodexEvent {
  type: string;
  thread_id?: string;
  message?: string;
  text?: string;
  delta?: string;
  // tool_use-shaped events
  name?: string;
  input?: Record<string, unknown>;
  output?: unknown;
  status?: string;
  // turn.completed
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
  };
  error?: { message?: string };
  // item.started / item.updated / item.completed carry the work in `item`.
  item?: CodexItem;
}

/** The unit of work in codex's current event stream. `type` names the kind of
 *  work, which is what stands in for a tool name here. */
export interface CodexItem {
  id?: string;
  type?: string;
  status?: string;
  // command_execution
  command?: string;
  aggregated_output?: string;
  exit_code?: number;
  // file_change
  path?: string;
  changes?: unknown;
  // mcp_tool_call
  server?: string;
  tool?: string;
  arguments?: Record<string, unknown>;
  result?: unknown;
  // web_search
  query?: string;
}

/** Item types that represent the agent DOING something, as opposed to saying
 *  something. Anything else on an item.* event is ignored. */
export const CODEX_TOOL_ITEMS = new Set(['command_execution', 'file_change', 'mcp_tool_call', 'web_search']);

/** Name, input: what a codex item looks like as a tool call. An mcp tool keeps
 *  its own identity ("server.tool") — those are the distinctive ones for
 *  procedure clustering, so collapsing them all to "mcp_tool_call" would throw
 *  away the signal. */
export function codexItemAsTool(item: CodexItem): { tool: string; input?: Record<string, unknown>; output?: unknown } | null {
  switch (item.type) {
    case 'command_execution':
      return {
        tool: 'command_execution',
        ...(item.command ? { input: { command: item.command } } : {}),
        output: item.aggregated_output,
      };
    case 'file_change':
      return {
        tool: 'file_change',
        ...(item.path ? { input: { path: item.path } } : {}),
        output: item.changes,
      };
    case 'mcp_tool_call':
      return {
        tool: item.server && item.tool ? `${item.server}.${item.tool}` : (item.tool ?? 'mcp_tool_call'),
        ...(item.arguments ? { input: item.arguments } : {}),
        output: item.result,
      };
    case 'web_search':
      return {
        tool: 'web_search',
        ...(item.query ? { input: { query: item.query } } : {}),
      };
    default:
      return null;
  }
}

/**
 * Codex adapter using the real CLI surface (`codex exec` / `codex exec resume`).
 *
 * The previous implementation called a non-existent `codex complete --prompt`
 * subcommand. We now:
 *   - spawn `codex exec --json -o <file>` for fresh runs;
 *   - spawn `codex exec resume <thread_id> --json -o <file>` when the gateway
 *     hands us a `resumeSessionId`;
 *   - read the final assistant message from the `--output-last-message` file
 *     (most reliable single source of truth for response text);
 *   - extract the thread id from the `thread.started` event so the gateway
 *     can resume on later turns.
 */
export class CodexAdapter extends BaseAgentAdapter {
  name = 'codex';
  private activeProcess?: ChildProcess;

  async run(request: AgentRequest): Promise<AgentResponse> {
    return new Promise((resolve) => {
      // Tempfile for `--output-last-message`. Cleaned up after the run.
      const outFile = path.join(os.tmpdir(), `codex-out-${randomUUID()}.txt`);

      const args = ['exec'];
      if (request.resumeSessionId) {
        args.push('resume', request.resumeSessionId);
      }
      args.push(
        '--json',
        '--skip-git-repo-check',
      );
      if (request.skipPermissions) {
        args.push('--dangerously-bypass-approvals-and-sandbox');
      }
      args.push('-o', outFile);
      if (request.model?.model) {
        args.push('--model', request.model.model);
      }
      if (request.context?.workingDir) {
        args.push('--cd', request.context.workingDir);
      }
      if (request.mcpServers && Object.keys(request.mcpServers).length > 0) {
        args.push(...codexMcpArgs(request.mcpServers));
      }
      args.push(request.prompt);

      const { applyModelEnv } = require('./env') as typeof import('./env');
      const env = applyModelEnv({ ...process.env }, request.model, 'openai');
      if (request.extraEnv) Object.assign(env, request.extraEnv);

      const childProcess: ChildProcess = spawn('codex', args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env,
        cwd: request.context?.workingDir || undefined,
      });
      this.activeProcess = childProcess;

      childProcess.on('close', () => {
        this.activeProcess = undefined;
      });

      const startTime = Date.now();
      let resolved = false;
      let stderr = '';
      let buffer = '';
      let capturedThreadId: string | undefined;
      let streamedText = '';
      let errorMessage: string | undefined;
      // codex reports finished work, so the collector synthesizes the
      // tool_start the chat surface needs to see a procedure.
      const tools = new ToolCallCollector(request.onStatus);
      const statusUpdates = tools.statusUpdates;
      const states = tools.states;

      const safeResolve = (response: AgentResponse) => {
        if (resolved) return;
        resolved = true;
        try { fs.unlinkSync(outFile); } catch { /* best-effort cleanup */ }
        resolve(response);
      };

      const handleEvent = (event: CodexEvent) => {
        switch (event.type) {
          case 'thread.started':
            if (event.thread_id) capturedThreadId = event.thread_id;
            break;
          case 'agent.message.delta':
          case 'message.delta':
          case 'response.output_text.delta':
            // Stream incremental text — field names vary between codex
            // versions; accept whichever carries it.
            if (event.delta) {
              streamedText += event.delta;
              request.onStream?.(event.delta);
            } else if (event.text) {
              streamedText += event.text;
              request.onStream?.(event.text);
            }
            break;
          case 'item.started':
          case 'item.updated':
          case 'item.completed': {
            // The current codex surface: work is reported as items, and only
            // some item types are tool activity.
            if (!event.item || !CODEX_TOOL_ITEMS.has(event.item.type ?? '')) break;
            const asTool = codexItemAsTool(event.item);
            if (!asTool) break;
            tools.record({
              ...asTool,
              key: event.item.id ?? asTool.tool,
              phase: event.type === 'item.started' ? 'start' : 'end',
              status: event.item.status,
            });
            break;
          }
          case 'tool_use':
          case 'tool_call':
          case 'shell_command':
            // Older codex builds. Kept because these event names shipped for a
            // while and cost nothing to keep accepting.
            if (event.name || event.status) {
              tools.record({
                tool: event.name ?? 'tool',
                status: event.status,
                input: event.input,
                output: event.output,
              });
            }
            break;
          case 'turn.failed':
          case 'error':
            errorMessage = event.error?.message ?? event.message ?? 'Codex turn failed';
            break;
          // 'turn.started' / 'turn.completed' carry no text we need here.
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
            handleEvent(JSON.parse(trimmed) as CodexEvent);
          } catch {
            // Non-JSON or partial — skip.
          }
        }
      });

      childProcess.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      childProcess.on('close', (code: number | null) => {
        tools.finish();
        // Drain any leftover line.
        if (buffer.trim().startsWith('{')) {
          try { handleEvent(JSON.parse(buffer.trim()) as CodexEvent); } catch { /* ignore */ }
        }

        const duration = Math.round((Date.now() - startTime) / 1000);

        // Prefer the final-message file (deterministic), fall back to streamed
        // deltas if the file is missing or empty.
        let output = '';
        try {
          if (fs.existsSync(outFile)) {
            output = fs.readFileSync(outFile, 'utf-8').trim();
          }
        } catch { /* fall through to streamedText */ }
        if (!output) output = streamedText.trim();

        const response: AgentResponse = {
          success: code === 0 && !errorMessage && !!output,
          output,
          error: errorMessage ?? (code !== 0 ? (stderr.trim() || `Codex exited with code ${code}`) : undefined),
          duration,
          statusUpdates,
          states,
          sessionId: capturedThreadId,
        };

        if (!response.success && !response.error) {
          response.error = 'Codex returned empty response';
        }

        safeResolve(response);
      });

      childProcess.on('error', (err: Error) => {
        const duration = Math.round((Date.now() - startTime) / 1000);
        const spawnError = new AgentSpawnError(this.name, err.message);
        safeResolve({
          success: false,
          output: spawnError.message,
          error: spawnError.message,
          duration,
        });
      });

      const timeout = request.timeout || 900000;
      setTimeout(() => {
        if (resolved) return;
        childProcess.kill();
        const duration = Math.round((Date.now() - startTime) / 1000);
        safeResolve({
          success: false,
          output: `Timeout after ${Math.round(timeout / 60000)} minutes`,
          error: 'timeout',
          duration,
        });
      }, timeout);

      if (request.signal) {
        const onAbort = () => {
          if (resolved) return;
          try { childProcess.kill('SIGTERM'); } catch { /* already dead */ }
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
