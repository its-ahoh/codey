import { spawn, ChildProcess } from 'child_process';
import { AgentRequest, AgentResponse } from '../types';
import { BaseAgentAdapter } from './base';
import { AgentSpawnError } from '../errors';

export class CodexAdapter extends BaseAgentAdapter {
  name = 'codex';

  async run(request: AgentRequest): Promise<AgentResponse> {
    return new Promise((resolve) => {
      const args = [
        'complete',
        '--prompt',
        request.prompt,
        '--stream',
        'false'
      ];

      // Add model configuration if provided
      if (request.model) {
        args.push('--model', request.model.model);
        
        if (request.model.baseUrl) {
          args.push('--api-base', request.model.baseUrl);
        }
      }

      if (request.context?.workingDir) {
        args.push('--dir', request.context.workingDir);
      }

      const { applyModelEnv } = require('./env') as typeof import('./env');
      const env = applyModelEnv({ ...process.env }, request.model, 'openai');
      const childProcess: ChildProcess = spawn('codex', args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env,
      });

      let stdout = '';
      let stderr = '';

      childProcess.stdout?.on('data', (data: Buffer) => {
        stdout += data.toString();
      });

      childProcess.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      childProcess.on('close', (code: number | null) => {
        if (code === 0) {
          resolve(this.createResponse(stdout.trim()));
        } else {
          resolve(this.createResponse(stderr || 'Codex failed', false));
        }
      });

      childProcess.on('error', (err: Error) => {
        const spawnError = new AgentSpawnError(this.name, err.message);
        resolve(this.createResponse(spawnError.message, false));
      });

      // Timeout (default 15 minutes)
      const timeout = request.timeout || 900000;
      setTimeout(() => {
        childProcess.kill();
        resolve(this.createResponse(`Timeout after ${Math.round(timeout / 60000)} minutes`, false));
      }, timeout);
    });
  }
}
