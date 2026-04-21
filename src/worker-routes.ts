import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { WorkerManager } from './workers';
import { WorkspaceManager } from './workspace';
import { AgentFactory } from './agents';
import { CodingAgent, ModelConfig } from './types/index';
import { generateWorker } from './worker-generator';

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

interface PutWorkerBody {
  personality?: { role?: string; soul?: string; instructions?: string };
  config?: { codingAgent?: string; model?: string; tools?: unknown };
}

const VALID_AGENTS = ['claude-code', 'opencode', 'codex'] as const;
type ValidAgent = typeof VALID_AGENTS[number];

function assemblePersonalityMd(name: string, role: string, soul: string, instructions: string): string {
  return [
    `# Worker: ${name}`,
    '',
    '## Role',
    role.trim(),
    '',
    '## Soul',
    soul.trim(),
    '',
    '## Instructions',
    instructions.trim(),
    '',
  ].join('\n');
}

export async function handlePutWorker(
  deps: WorkerRouteDeps,
  workerName: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  workersDir: string = './workers',
): Promise<void> {
  const existing = deps.workerManager.getWorker(workerName);
  if (!existing) { sendJson(res, 404, { error: `Worker "${workerName}" not found` }); return; }

  const raw = await readBody(req);
  let body: PutWorkerBody;
  try { body = JSON.parse(raw); } catch { sendJson(res, 400, { error: 'Invalid JSON body' }); return; }

  const role = body.personality?.role ?? existing.personality.role;
  const soul = body.personality?.soul ?? existing.personality.soul;
  const instructions = body.personality?.instructions ?? existing.personality.instructions;

  const codingAgent = body.config?.codingAgent ?? existing.config.codingAgent;
  const model = body.config?.model ?? existing.config.model;
  const tools = Array.isArray(body.config?.tools) ? body.config!.tools as string[] : existing.config.tools;

  if (!VALID_AGENTS.includes(codingAgent as ValidAgent)) {
    sendJson(res, 400, { error: `codingAgent must be one of ${VALID_AGENTS.join(', ')}` });
    return;
  }
  if (!model || typeof model !== 'string') {
    sendJson(res, 400, { error: 'model must be a non-empty string' });
    return;
  }

  const dir = path.join(workersDir, existing.name);
  try {
    fs.writeFileSync(path.join(dir, 'personality.md'), assemblePersonalityMd(existing.name, role, soul, instructions));
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ codingAgent, model, tools }, null, 2) + '\n');
  } catch (err) {
    sendJson(res, 500, { error: `Failed to write worker files: ${err}` });
    return;
  }

  await deps.workerManager.loadWorkers();
  sendJson(res, 200, { worker: serializeWorker(deps.workerManager.getWorker(workerName)) });
}

export async function handleDeleteWorker(
  deps: WorkerRouteDeps,
  workerName: string,
  res: http.ServerResponse,
  workersDir: string = './workers',
): Promise<void> {
  const existing = deps.workerManager.getWorker(workerName);
  if (!existing) { sendJson(res, 404, { error: `Worker "${workerName}" not found` }); return; }

  const dir = path.join(workersDir, existing.name);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    sendJson(res, 500, { error: `Failed to remove worker folder: ${err}` });
    return;
  }

  const cascadeErrors: string[] = [];
  if (fs.existsSync(deps.workspacesDir)) {
    for (const entry of fs.readdirSync(deps.workspacesDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const cfgPath = path.join(deps.workspacesDir, entry.name, 'workspace.json');
      if (!fs.existsSync(cfgPath)) continue;
      try {
        const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
        if (!cfg.teams) continue;
        let changed = false;
        for (const [teamName, members] of Object.entries(cfg.teams as Record<string, string[]>)) {
          const filtered = members.filter(m => m.toLowerCase() !== workerName.toLowerCase());
          if (filtered.length !== members.length) {
            changed = true;
            if (filtered.length === 0) delete cfg.teams[teamName];
            else cfg.teams[teamName] = filtered;
          }
        }
        if (changed) {
          if (Object.keys(cfg.teams).length === 0) delete cfg.teams;
          fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
        }
      } catch (err) {
        cascadeErrors.push(`${cfgPath}: ${err}`);
      }
    }
  }

  await deps.workerManager.loadWorkers();
  const current = deps.workspaceManager.getCurrentWorkspace();
  await deps.workspaceManager.switchWorkspace(current).catch(() => { /* best-effort */ });

  if (cascadeErrors.length > 0) {
    sendJson(res, 200, { ok: true, cascadeWarnings: cascadeErrors });
  } else {
    sendJson(res, 200, { ok: true });
  }
}

export async function handlePutTeams(
  deps: WorkerRouteDeps,
  workspaceName: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const wsPath = path.join(deps.workspacesDir, workspaceName, 'workspace.json');
  if (!fs.existsSync(wsPath)) { sendJson(res, 404, { error: `Workspace "${workspaceName}" not found` }); return; }

  const raw = await readBody(req);
  let body: { teams?: Record<string, string[]> };
  try { body = JSON.parse(raw); } catch { sendJson(res, 400, { error: 'Invalid JSON body' }); return; }

  const teams = body.teams || {};
  const unknown: string[] = [];
  for (const members of Object.values(teams)) {
    if (!Array.isArray(members)) { sendJson(res, 400, { error: 'Each team must be an array of worker names' }); return; }
    for (const m of members) if (!deps.workerManager.hasWorker(m)) unknown.push(m);
  }
  if (unknown.length > 0) { sendJson(res, 400, { error: 'Team references unknown workers', unknown }); return; }

  try {
    const cfg = JSON.parse(fs.readFileSync(wsPath, 'utf-8'));
    if (Object.keys(teams).length === 0) delete cfg.teams;
    else cfg.teams = teams;
    fs.writeFileSync(wsPath, JSON.stringify(cfg, null, 2) + '\n');
  } catch (err) {
    sendJson(res, 500, { error: `Failed to update workspace.json: ${err}` });
    return;
  }

  if (deps.workspaceManager.getCurrentWorkspace() === workspaceName) {
    await deps.workspaceManager.switchWorkspace(workspaceName).catch(() => { /* best-effort */ });
  }

  sendJson(res, 200, { teams });
}

export { sendJson, readBody };

export interface GenerateRouteDeps extends WorkerRouteDeps {
  agentFactory: AgentFactory;
  getActiveAgent: () => CodingAgent;
  getActiveModel: () => ModelConfig;
  getWorkingDir: () => string;
  workersDir: string;
}

export async function handleGenerateWorker(
  deps: GenerateRouteDeps,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const raw = await readBody(req);
  let body: { prompt?: string };
  try { body = JSON.parse(raw); } catch { sendJson(res, 400, { error: 'Invalid JSON body' }); return; }
  if (!body.prompt || typeof body.prompt !== 'string') { sendJson(res, 400, { error: 'prompt is required' }); return; }

  const result = await generateWorker({
    agentFactory: deps.agentFactory,
    workerManager: deps.workerManager,
    workersDir: deps.workersDir,
    activeAgent: deps.getActiveAgent(),
    activeModel: deps.getActiveModel(),
    workingDir: deps.getWorkingDir(),
  }, body.prompt);

  if (result.ok) { sendJson(res, 200, { worker: serializeWorker(deps.workerManager.getWorker(result.worker.name)) }); return; }
  const errBody: Record<string, unknown> = { error: result.error };
  if ('raw' in result && result.raw) errBody.raw = result.raw;
  sendJson(res, result.status, errBody);
}
