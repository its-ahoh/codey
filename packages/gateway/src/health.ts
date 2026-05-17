import * as http from 'http';
import { ConfigManager } from './config';

export type HealthStatusType = 'healthy' | 'degraded' | 'down';

export interface HealthStatus {
  status: HealthStatusType;
  uptime: number;
  timestamp: string;
  channels: {
    telegram: boolean;
    discord: boolean;
    imessage: boolean;
  };
  stats: {
    messagesProcessed: number;
    activeConversations: number;
    errors: number;
  };
}

export class ApiServer {
  private server?: http.Server;
  private port: number;
  private getStatus: () => HealthStatus;
  private configManager: ConfigManager;
  private _voiceStatus: string = 'idle';

  constructor(port: number, getStatus: () => HealthStatus, configManager: ConfigManager) {
    this.port = port;
    this.getStatus = getStatus;
    this.configManager = configManager;
  }

  async start(): Promise<void> {
    this.server = http.createServer(async (req, res) => {
      // CORS headers
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

      if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
      }

      const url = req.url?.split('?')[0];

      if (url === '/health' || url === '/') {
        const status = this.getStatus();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(status, null, 2));
        return;
      }

      if (url === '/metrics') {
        const status = this.getStatus();
        const metrics = {
          uptime_seconds: status.uptime,
          messages_total: status.stats.messagesProcessed,
          errors_total: status.stats.errors,
          active_conversations: status.stats.activeConversations,
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(metrics, null, 2));
        return;
      }

      if (url === '/ready') {
        const status = this.getStatus();
        const ready = status.status !== 'down';
        res.writeHead(ready ? 200 : 503);
        res.end(JSON.stringify({ ready }));
        return;
      }

      // ── Voice endpoints ───────────────────────────────────────────

      // CORS: block browser-origin requests to /voice/* (native clients send no Origin)
      if (url?.startsWith('/voice/') && req.headers.origin) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Browser requests to voice endpoints are not allowed' }));
        return;
      }

      if (url?.startsWith('/voice/') && process.platform !== 'darwin') {
        res.writeHead(501, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Voice input is only supported on macOS' }));
        return;
      }

      if (url === '/voice/status' && req.method === 'GET') {
        const voice = this.configManager.get().voice;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          configured: !!voice,
          enabled: voice?.enabled ?? false,
          state: this._voiceStatus ?? null,
        }));
        return;
      }

      if (url === '/voice/status' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
          try {
            const { status } = JSON.parse(body);
            // Store latest helper status in memory (not persisted to config)
            this._voiceStatus = status;
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
          } catch {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid JSON' }));
          }
        });
        return;
      }

      if (url === '/voice/config' && req.method === 'GET') {
        const voice = this.configManager.get().voice;
        if (!voice) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Voice not configured' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(voice, null, 2));
        return;
      }

      if (url === '/voice/config' && req.method === 'PUT') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
          try {
            const patch = JSON.parse(body);

            const current = this.configManager.get();
            const updated = { ...current, voice: { ...current.voice, ...patch } };
            this.configManager.update(updated);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(updated.voice, null, 2));
          } catch {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid JSON' }));
          }
        });
        return;
      }

      // ── Existing endpoints ────────────────────────────────────────

      if (url === '/config' && req.method === 'GET') {
        try {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(this.configManager.get(), null, 2));
        } catch (error) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: String(error) }));
        }
        return;
      }

      if (url === '/config' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
          try {
            const config = JSON.parse(body);
            this.configManager.update(config);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true }));
          } catch (error) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: String(error) }));
          }
        });
        return;
      }

      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Not found' }));
    });

    return new Promise((resolve) => {
      this.server!.listen(this.port, () => {
        console.log(`[API] Server running on port ${this.port}`);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }
}
