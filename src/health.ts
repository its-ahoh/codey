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

type MessageHandler = (prompt: string) => Promise<string>;
type WorkspaceListHandler = () => string[];
type WorkspaceSwitchHandler = (name: string) => Promise<boolean>;

export class ApiServer {
  private server?: http.Server;
  private port: number;
  private getStatus: () => HealthStatus;
  private handleMessage?: MessageHandler;
  private listWorkspaces?: WorkspaceListHandler;
  private switchWorkspace?: WorkspaceSwitchHandler;
  private configManager: ConfigManager;

  constructor(port: number, getStatus: () => HealthStatus, configManager: ConfigManager) {
    this.port = port;
    this.getStatus = getStatus;
    this.configManager = configManager;
  }

  setMessageHandler(handler: MessageHandler): void {
    this.handleMessage = handler;
  }

  setWorkspaceHandlers(list: WorkspaceListHandler, switchFn: WorkspaceSwitchHandler): void {
    this.listWorkspaces = list;
    this.switchWorkspace = switchFn;
  }

  async start(): Promise<void> {
    this.server = http.createServer(async (req, res) => {
      // CORS headers
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
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

      if (url === '/message' && req.method === 'POST') {
        if (!this.handleMessage) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Message handler not configured' }));
          return;
        }

        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
          try {
            const { prompt } = JSON.parse(body);
            const response = await this.handleMessage!(prompt);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ response }));
          } catch (error) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: String(error) }));
          }
        });
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

      if (url === '/workspaces' && req.method === 'GET') {
        const workspaces = this.listWorkspaces ? this.listWorkspaces() : [];
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(workspaces));
        return;
      }

      if (url === '/workspace' && req.method === 'POST') {
        if (!this.switchWorkspace) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Workspace handler not configured' }));
          return;
        }

        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
          try {
            const { name } = JSON.parse(body);
            const success = await this.switchWorkspace!(name);
            if (success) {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ success: true, workspace: name }));
            } else {
              res.writeHead(404, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: `Workspace "${name}" not found` }));
            }
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
