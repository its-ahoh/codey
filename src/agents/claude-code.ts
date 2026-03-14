import { spawn, ChildProcess } from 'child_process';
import { AgentRequest, AgentResponse, ModelConfig } from '../types';
import { BaseAgentAdapter } from './base';
import { Logger } from '../logger';

interface StreamEvent {
  type: string;
  subtype?: string;
  session_id?: string;
  // result event
  result?: string;
  is_error?: boolean;
  // assistant event
  message?: {
    content: Array<{ type: string; text?: string }>;
  };
}

export class ClaudeCodeAdapter extends BaseAgentAdapter {
  name = 'claude-code';
  private sessionId?: string;
  private logger = Logger.getInstance();

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

      // Note: session resumption is not used with -p mode.
      // Conversation context is managed by the gateway's ConversationManager.

      // Add model configuration if provided
      if (request.model) {
        args.push('--model', request.model.model);

        // Add provider-specific settings
        if (request.model.provider === 'anthropic' && request.model.apiKey) {
          args.push('--api-key', request.model.apiKey);
        }
        if (request.model.baseUrl) {
          args.push('--base-url', request.model.baseUrl);
        }
      }

      // -p with prompt must be last (matches tested CLI format)
      args.push('-p', request.prompt);

      // Clean env: remove CLAUDECODE to avoid nested session detection
      const env = { ...process.env };
      delete env.CLAUDECODE;
      if (request.model?.apiKey) {
        env.ANTHROPIC_API_KEY = request.model.apiKey;
      }

      this.logger.debug(`[claude-code] Spawning: claude ${args.slice(0, -1).join(' ')} "<prompt>"`);

      const childProcess: ChildProcess = spawn('claude', args, {
        stdio: [request.interactive ? 'inherit' : 'pipe', 'pipe', request.interactive ? 'inherit' : 'pipe'],
        cwd: request.context?.workingDir || undefined,
        env,
      });

      // Close stdin for non-interactive mode so the child process doesn't hang
      if (!request.interactive) {
        childProcess.stdin?.end();
      }

      let resolved = false;
      let result = '';
      let streamedText = '';
      let buffer = '';
      let stderr = '';

      const safeResolve = (response: AgentResponse) => {
        if (!resolved) {
          resolved = true;
          resolve(response);
        }
      };

      const processEvent = (event: StreamEvent) => {
        this.logger.debug(`[claude-code] Event: ${event.type} ${event.subtype || ''}`);

        if (event.type === 'system' && event.session_id) {
          this.sessionId = event.session_id;
        } else if (event.type === 'assistant' && event.message?.content) {
          for (const block of event.message.content) {
            if (block.type === 'text' && block.text) {
              streamedText += block.text;
              request.onStream?.(block.text);
            }
          }
        } else if (event.type === 'result') {
          if (event.session_id) {
            this.sessionId = event.session_id;
          }
          if (event.result) {
            result = event.result;
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
        this.logger.debug(`[claude-code] Process exited with code ${code}`);

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

        if (code === 0 && output) {
          safeResolve(this.createResponse(output));
        } else {
          // Clear session on failure to avoid "session already in use" errors
          this.sessionId = undefined;
          const error = stderr || (code !== 0 ? `Claude Code exited with code ${code}` : 'Claude Code returned empty response');
          this.logger.debug(`[claude-code] Error: ${error}`);
          safeResolve(this.createResponse(error, false));
        }
      });

      childProcess.on('error', (err: Error) => {
        this.logger.debug(`[claude-code] Spawn error: ${err.message}`);
        safeResolve(this.createResponse(err.message, false));
      });

      // Safety timeout so we don't hang forever if the CLI never responds.
      // Timeout (default 5 minutes)
      const timeout = request.timeout || 300000;
      setTimeout(() => {
        if (!resolved) {
          childProcess.kill();
          safeResolve(this.createResponse(`Timeout after ${Math.round(timeout / 60000)} minutes`, false));
        }
      }, timeout);
    });
  }

  resetSession(): void {
    this.sessionId = undefined;
  }
}
