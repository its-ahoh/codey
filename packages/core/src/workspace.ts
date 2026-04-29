import * as fs from 'fs';
import * as path from 'path';
import { CoreLogger } from './types';
import { WorkerManager } from './workers';
import { MemoryStore } from './memory';

const defaultLogger: CoreLogger = {
  info: (msg: string) => console.log(msg),
  warn: (msg: string) => console.warn(msg),
  error: (msg: string) => console.error(msg),
};

export interface WorkspaceJson {
  workingDir: string;
  teams?: Record<string, string[]>;
}

export class WorkspaceManager {
  private workspacesDir: string;
  private currentWorkspace: string = '';
  private config: WorkspaceJson | null = null;
  private workerManager: WorkerManager;
  private memoryStore: MemoryStore;
  private teams: Map<string, string[]> = new Map();
  private logger: CoreLogger;

  constructor(workerManager: WorkerManager, workspacesDir: string = './workspaces', logger?: CoreLogger) {
    this.workspacesDir = workspacesDir;
    this.workerManager = workerManager;
    this.memoryStore = new MemoryStore(this.getWorkspacePath());
    this.logger = logger || defaultLogger;
  }

  private getWorkspacePath(): string {
    return path.join(this.workspacesDir, this.currentWorkspace);
  }

  private getConfigPath(): string {
    return path.join(this.getWorkspacePath(), 'workspace.json');
  }

  private getMemoryPath(): string {
    return path.join(this.getWorkspacePath(), 'memory.md');
  }

  async load(): Promise<void> {
    if (!this.currentWorkspace) {
      // Auto-select a workspace so callers (logger setup, etc.) get real paths
      // instead of resolving against the workspaces root — which would create
      // phantom "logs"/"memory" entries and trip ENOENT on first write.
      const existing = this.listWorkspaces();
      const pick = existing.includes('default') ? 'default' : existing[0];
      if (pick) {
        this.currentWorkspace = pick;
      } else {
        const fallback = 'default';
        const fallbackPath = path.join(this.workspacesDir, fallback);
        fs.mkdirSync(fallbackPath, { recursive: true });
        fs.writeFileSync(
          path.join(fallbackPath, 'workspace.json'),
          JSON.stringify({ workingDir: process.cwd() }, null, 2),
        );
        this.currentWorkspace = fallback;
      }
    }
    const configPath = this.getConfigPath();
    const workspacePath = this.getWorkspacePath();

    if (fs.existsSync(configPath)) {
      const data = fs.readFileSync(configPath, 'utf-8');
      this.config = JSON.parse(data);
      this.logger.info(`[Workspace] Loaded workspace: ${this.currentWorkspace}`);
    } else {
      this.config = { workingDir: process.cwd() };
      this.logger.info(`[Workspace] No config found for ${this.currentWorkspace}, using defaults`);
    }

    // Parse + validate teams against the global worker library.
    this.teams.clear();
    const rawTeams = this.config?.teams || {};
    for (const [teamName, members] of Object.entries(rawTeams)) {
      if (!Array.isArray(members)) {
        this.logger.error(`[Workspace] Team "${teamName}" is not an array — skipping`);
        continue;
      }
      const unknown = members.filter(m => !this.workerManager.hasWorker(m));
      if (unknown.length > 0) {
        this.logger.error(`[Workspace] Team "${teamName}" references unknown workers: ${unknown.join(', ')} — skipping`);
        continue;
      }
      this.teams.set(teamName.toLowerCase(), members);
    }

    if (!fs.existsSync(this.getMemoryPath())) {
      fs.writeFileSync(this.getMemoryPath(), `# ${this.currentWorkspace} — Project Memory\n`);
    }

    const logsDir = this.getLogsDir();
    if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

    this.memoryStore = new MemoryStore(workspacePath);
    await this.memoryStore.load();
  }

  async switchWorkspace(workspaceId: string): Promise<boolean> {
    if (!workspaceId || !workspaceId.trim()) return false;
    const workspacePath = path.join(this.workspacesDir, workspaceId);
    if (!fs.existsSync(workspacePath) || !fs.statSync(workspacePath).isDirectory()) return false;
    this.currentWorkspace = workspaceId;
    await this.load();
    return true;
  }

  async findOrCreateByDir(dir: string): Promise<string> {
    const workspaces = this.listWorkspaces();
    for (const ws of workspaces) {
      const configPath = path.join(this.workspacesDir, ws, 'workspace.json');
      if (fs.existsSync(configPath)) {
        const data = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        if (data.workingDir === dir) {
          await this.switchWorkspace(ws);
          return ws;
        }
      }
    }

    let name = path.basename(dir).toLowerCase().replace(/[^a-z0-9-_]/g, '-');
    if (workspaces.includes(name)) {
      let i = 2;
      while (workspaces.includes(`${name}-${i}`)) i++;
      name = `${name}-${i}`;
    }

    const workspacePath = path.join(this.workspacesDir, name);
    fs.mkdirSync(workspacePath, { recursive: true });

    const config: WorkspaceJson = { workingDir: dir };
    fs.writeFileSync(path.join(workspacePath, 'workspace.json'), JSON.stringify(config, null, 2));
    fs.writeFileSync(path.join(workspacePath, 'memory.md'), `# ${name} — Project Memory\n`);

    this.logger.info(`[Workspace] Created new workspace: ${name} -> ${dir}`);
    await this.switchWorkspace(name);
    return name;
  }

  getLogsDir(): string { return path.join(this.getWorkspacePath(), 'logs'); }
  getLogPath(): string { return path.join(this.getLogsDir(), 'app.log'); }
  getErrorLogPath(): string { return path.join(this.getLogsDir(), 'error.log'); }

  getWorkingDir(): string { return this.config?.workingDir || process.cwd(); }
  getCurrentWorkspace(): string { return this.currentWorkspace; }
  getWorkspacesRoot(): string { return this.workspacesDir; }
  getWorkerManager(): WorkerManager { return this.workerManager; }
  getMemoryStore(): MemoryStore { return this.memoryStore; }

  getMemory(): string {
    const memoryPath = this.getMemoryPath();
    return fs.existsSync(memoryPath) ? fs.readFileSync(memoryPath, 'utf-8') : '';
  }

  async deleteWorkspace(name: string): Promise<void> {
    if (name === 'default') {
      throw new Error('The "default" workspace is protected and cannot be deleted.');
    }
    const target = path.join(this.workspacesDir, name);
    if (!fs.existsSync(target)) {
      throw new Error(`Workspace "${name}" does not exist`);
    }
    const resolved = path.resolve(target);
    const root = path.resolve(this.workspacesDir);
    if (!resolved.startsWith(root + path.sep)) {
      throw new Error(`Refusing to delete workspace outside of workspaces root`);
    }
    const wasActive = name === this.currentWorkspace;
    await fs.promises.rm(resolved, { recursive: true, force: true });
    this.logger.info(`[Workspace] Deleted workspace: ${name}`);

    if (wasActive) {
      this.currentWorkspace = '';
      this.config = null;
      this.teams.clear();
      const remaining = this.listWorkspaces();
      if (remaining.length > 0) {
        await this.switchWorkspace(remaining[0]);
      }
    }
  }

  listWorkspaces(): string[] {
    if (!fs.existsSync(this.workspacesDir)) return [];
    return fs.readdirSync(this.workspacesDir).filter(d => {
      const dir = path.join(this.workspacesDir, d);
      if (!fs.statSync(dir).isDirectory()) return false;
      // Only directories with a workspace.json count as workspaces; this
      // filters out stray dirs (logs/, memory/) that may have leaked into
      // the workspaces root.
      return fs.existsSync(path.join(dir, 'workspace.json'));
    });
  }

  getTeam(name: string): string[] | undefined {
    return this.teams.get(name.toLowerCase());
  }

  getTeamNames(): string[] {
    return Array.from(this.teams.keys());
  }

  listTeams(): string {
    if (this.teams.size === 0) return 'No teams declared for this workspace.';
    return Array.from(this.teams.entries())
      .map(([name, members]) => `• **${name}** → ${members.join(' → ')}`)
      .join('\n');
  }

  async setTeams(teams: Record<string, string[]>): Promise<void> {
    this.teams.clear();
    for (const [name, members] of Object.entries(teams)) {
      this.teams.set(name, members);
    }
    const configPath = this.getConfigPath();
    const existing = JSON.parse(await fs.promises.readFile(configPath, 'utf-8'));
    existing.teams = teams;
    await fs.promises.writeFile(configPath, JSON.stringify(existing, null, 2), 'utf-8');
  }

  getTeams(): Record<string, string[]> {
    const result: Record<string, string[]> = {};
    for (const [name, members] of this.teams.entries()) {
      result[name] = members;
    }
    return result;
  }
}
