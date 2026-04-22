import * as http from 'http';
import { ConfigManager } from './config';
import { StatusUpdate } from '@codey/core';
import { WorkerRouteDeps, GenerateRouteDeps, handleListWorkers, handleGetTeams, handlePutTeams, matchWorkerPath, matchWorkspaceTeamsPath, handlePutWorker, handleDeleteWorker, handleGenerateWorker } from './worker-routes';

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

type SSECallback = (event: string, data: string) => void;
type MessageHandler = (prompt: string, sse?: SSECallback, conversationId?: string) => Promise<{ response: string; conversationId: string }>;
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
  private workerRoutes?: GenerateRouteDeps;

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

  setWorkerRoutes(deps: GenerateRouteDeps): void {
    this.workerRoutes = deps;
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
            const { prompt, conversationId } = JSON.parse(body);

            // Use SSE to stream status updates and the final response
            res.writeHead(200, {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache',
              'Connection': 'keep-alive',
            });

            const sse: SSECallback = (event, data) => {
              res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
            };

            const { response } = await this.handleMessage!(prompt, sse, conversationId);
            sse('done', response);
            res.end();
          } catch (error) {
            // If headers already sent, send error as SSE event
            if (res.headersSent) {
              res.write(`event: error\ndata: ${JSON.stringify(String(error))}\n\n`);
              res.end();
            } else {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: String(error) }));
            }
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

      if (url === '/workers' && req.method === 'GET') {
        if (!this.workerRoutes) { res.writeHead(500); res.end(JSON.stringify({ error: 'Worker routes not configured' })); return; }
        handleListWorkers(this.workerRoutes, res);
        return;
      }

      if (url === '/workers/generate' && req.method === 'POST') {
        if (!this.workerRoutes) { res.writeHead(500); res.end(JSON.stringify({ error: 'Worker routes not configured' })); return; }
        await handleGenerateWorker(this.workerRoutes, req, res);
        return;
      }

      if (url && (req.method === 'PUT' || req.method === 'DELETE')) {
        const workerName = matchWorkerPath(url);
        if (workerName) {
          if (!this.workerRoutes) { res.writeHead(500); res.end(JSON.stringify({ error: 'Worker routes not configured' })); return; }
          if (req.method === 'PUT') { await handlePutWorker(this.workerRoutes, workerName, req, res); return; }
          if (req.method === 'DELETE') { await handleDeleteWorker(this.workerRoutes, workerName, res); return; }
        }
      }

      if (url && req.method === 'GET') {
        const teamsName = matchWorkspaceTeamsPath(url);
        if (teamsName) {
          if (!this.workerRoutes) { res.writeHead(500); res.end(JSON.stringify({ error: 'Worker routes not configured' })); return; }
          handleGetTeams(this.workerRoutes, teamsName, res);
          return;
        }
      }

      if (url && req.method === 'PUT') {
        const teamsName = matchWorkspaceTeamsPath(url);
        if (teamsName) {
          if (!this.workerRoutes) { res.writeHead(500); res.end(JSON.stringify({ error: 'Worker routes not configured' })); return; }
          await handlePutTeams(this.workerRoutes, teamsName, req, res);
          return;
        }
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
