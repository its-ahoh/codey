import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { WorkerManager } from './workers';
import { WorkspaceManager } from './workspace';

export interface WorkerRouteDeps {
  workerManager: WorkerManager;
  workspaceManager: WorkspaceManager;
  workspacesDir: string;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function serializeWorker(worker: ReturnType<WorkerManager['getWorker']>) {
  if (!worker) return null;
  return {
    name: worker.name,
    personality: worker.personality,
    config: worker.config,
  };
}

export function handleListWorkers(deps: WorkerRouteDeps, res: http.ServerResponse): void {
  const workers = deps.workerManager.getAllWorkers().map(serializeWorker);
  sendJson(res, 200, { workers });
}

export function handleGetTeams(
  deps: WorkerRouteDeps,
  workspaceName: string,
  res: http.ServerResponse,
): void {
  const wsPath = path.join(deps.workspacesDir, workspaceName, 'workspace.json');
  if (!fs.existsSync(wsPath)) {
    sendJson(res, 404, { error: `Workspace "${workspaceName}" not found` });
    return;
  }
  try {
    const cfg = JSON.parse(fs.readFileSync(wsPath, 'utf-8'));
    sendJson(res, 200, { teams: cfg.teams || {} });
  } catch (err) {
    sendJson(res, 500, { error: `Failed to read workspace.json: ${err}` });
  }
}

export function matchWorkerPath(url: string): string | null {
  const m = url.match(/^\/workers\/([a-z0-9_-]+)\/?$/i);
  return m ? m[1] : null;
}

export function matchWorkspaceTeamsPath(url: string): string | null {
  const m = url.match(/^\/workspaces\/([a-z0-9_-]+)\/teams\/?$/i);
  return m ? m[1] : null;
}

export { sendJson, readBody };
