import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { AgentRequest, AgentResponse, AgentStateEntry } from '../types';
import { BaseAgentAdapter } from './base';
import { AgentSpawnError } from '../errors';

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
        '--dangerously-bypass-approvals-and-sandbox',
        '-o', outFile,
      );
      if (request.model?.model) {
        args.push('--model', request.model.model);
      }
      if (request.context?.workingDir) {
        args.push('--cd', request.context.workingDir);
      }
      args.push(request.prompt);

      const { applyModelEnv } = require('./env') as typeof import('./env');
      const env = applyModelEnv({ ...process.env }, request.model, 'openai');

      const childProcess: ChildProcess = spawn('codex', args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env,
        cwd: request.context?.workingDir || undefined,
      });

      const startTime = Date.now();
      let resolved = false;
      let stderr = '';
      let buffer = '';
      let capturedThreadId: string | undefined;
      let streamedText = '';
      let errorMessage: string | undefined;
      const statusUpdates: string[] = [];
      const states: AgentStateEntry[] = [];

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
          case 'tool_use':
          case 'tool_call':
          case 'shell_command':
            if (event.name || event.status) {
              statusUpdates.push(`${event.name ?? 'tool'}: ${event.status ?? 'running'}`);
              states.push({
                source: event.name ?? 'tool',
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
    });
  }
}
