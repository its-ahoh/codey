import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export type LogCallback = (line: string, isError: boolean) => void;

class IPCService {
  private process: ChildProcess | null = null;
  private isRunning = false;
  private logCallback: LogCallback | null = null;

  start(gatewayPath: string, onLog?: LogCallback): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.isRunning) {
        resolve();
        return;
      }

      this.logCallback = onLog || null;

      // Check if gateway exists
      const distPath = path.join(gatewayPath, 'dist', 'index.js');
      const srcPath = path.join(gatewayPath, 'src', 'index.ts');

      let entryPoint: string;
      if (fs.existsSync(distPath)) {
        entryPoint = 'node';
        this.process = spawn('node', [distPath], {
          cwd: gatewayPath,
          env: process.env,
        });
      } else if (fs.existsSync(srcPath)) {
        entryPoint = 'npx ts-node';
        this.process = spawn('npx', ['ts-node', 'src/index.ts'], {
          cwd: gatewayPath,
          env: process.env,
        });
      } else {
        reject(new Error('Gateway not found. Run npm run build first.'));
        return;
      }

      this.process.stdout?.on('data', (data: Buffer) => {
        const lines = data.toString().split('\n').filter(Boolean);
        lines.forEach(line => {
          this.logCallback?.(line, false);
        });
      });

      this.process.stderr?.on('data', (data: Buffer) => {
        const lines = data.toString().split('\n').filter(Boolean);
        lines.forEach(line => {
          this.logCallback?.(line, true);
        });
      });

      this.process.on('error', (error) => {
        this.isRunning = false;
        this.logCallback?.(`Process error: ${error.message}`, true);
      });

      this.process.on('exit', (code) => {
        this.isRunning = false;
        this.logCallback?.(`Process exited with code ${code}`, true);
      });

      // Give it a moment to start
      setTimeout(() => {
        this.isRunning = true;
        resolve();
      }, 1000);
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.process || !this.isRunning) {
        resolve();
        return;
      }

      this.process.on('exit', () => {
        this.isRunning = false;
        this.process = null;
        resolve();
      });

      this.process.kill('SIGTERM');

      setTimeout(() => {
        if (this.process) {
          this.process.kill('SIGKILL');
        }
        this.isRunning = false;
        this.process = null;
        resolve();
      }, 5000);
    });
  }

  getRunning(): boolean {
    return this.isRunning;
  }
}

export const ipcService = new IPCService();
