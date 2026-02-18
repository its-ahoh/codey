import { spawn } from 'child_process';
import { AgentRequest, AgentResponse } from '../types';
import { BaseAgentAdapter } from './base';

export class OpenCodeAdapter extends BaseAgentAdapter {
  name = 'opencode';

  async run(request: AgentRequest): Promise<AgentResponse> {
    return new Promise((resolve) => {
      const args = [
        '--print',
        '-p',
        request.prompt
      ];

      if (request.context?.workingDir) {
        args.push('--cwd', request.context.workingDir);
      }

      const process = spawn('opencode', args, {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';

      process.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      process.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      process.on('close', (code) => {
        if (code === 0) {
          resolve(this.createResponse(stdout.trim()));
        } else {
          resolve(this.createResponse(stderr || 'OpenCode failed', false));
        }
      });

      process.on('error', (err) => {
        resolve(this.createResponse(err.message, false));
      });

      // Timeout after 5 minutes
      setTimeout(() => {
        process.kill();
        resolve(this.createResponse('Timeout after 5 minutes', false));
      }, 300000);
    });
  }
}
