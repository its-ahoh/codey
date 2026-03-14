import * as http from 'http';

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

export class HealthServer {
  private server?: http.Server;
  private port: number;
  private getStatus: () => HealthStatus;

  constructor(port: number, getStatus: () => HealthStatus) {
    this.port = port;
    this.getStatus = getStatus;
  }

  async start(): Promise<void> {
    this.server = http.createServer(async (req, res) => {
      // CORS headers
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
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

      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Not found' }));
    });

    return new Promise((resolve) => {
      this.server!.listen(this.port, () => {
        console.log(`[Health] Server running on port ${this.port}`);
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
