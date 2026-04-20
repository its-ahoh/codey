import * as fs from 'fs';
import * as path from 'path';
import { WorkerManager } from './workers';
import { MemoryStore } from './memory';

export interface WorkspaceJson {
  workingDir: string;
  teams?: Record<string, string[]>;
}

export class WorkspaceManager {
  private workspacesDir: string;
  private currentWorkspace: string = 'default';
  private config: WorkspaceJson | null = null;
  private workerManager: WorkerManager;
  private memoryStore: MemoryStore;
  private teams: Map<string, string[]> = new Map();

  constructor(workerManager: WorkerManager, workspacesDir: string = './workspaces') {
    this.workspacesDir = workspacesDir;
    this.workerManager = workerManager;
    this.memoryStore = new MemoryStore(this.getWorkspacePath());
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
    const configPath = this.getConfigPath();
    const workspacePath = this.getWorkspacePath();

    if (fs.existsSync(configPath)) {
      const data = fs.readFileSync(configPath, 'utf-8');
      this.config = JSON.parse(data);
      console.log(`[Workspace] Loaded workspace: ${this.currentWorkspace}`);
    } else {
      this.config = { workingDir: process.cwd() };
      console.log(`[Workspace] No config found for ${this.currentWorkspace}, using defaults`);
    }

    // Parse + validate teams against the global worker library.
    this.teams.clear();
    const rawTeams = this.config?.teams || {};
    for (const [teamName, members] of Object.entries(rawTeams)) {
      if (!Array.isArray(members)) {
        console.error(`[Workspace] Team "${teamName}" is not an array — skipping`);
        continue;
      }
      const unknown = members.filter(m => !this.workerManager.hasWorker(m));
      if (unknown.length > 0) {
        console.error(`[Workspace] Team "${teamName}" references unknown workers: ${unknown.join(', ')} — skipping`);
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
    const workspacePath = path.join(this.workspacesDir, workspaceId);
    if (!fs.existsSync(workspacePath)) return false;
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

    console.log(`[Workspace] Created new workspace: ${name} -> ${dir}`);
    await this.switchWorkspace(name);
    return name;
  }

  getLogsDir(): string { return path.join(this.getWorkspacePath(), 'logs'); }
  getLogPath(): string { return path.join(this.getLogsDir(), 'app.log'); }
  getErrorLogPath(): string { return path.join(this.getLogsDir(), 'error.log'); }

  getWorkingDir(): string { return this.config?.workingDir || process.cwd(); }
  getCurrentWorkspace(): string { return this.currentWorkspace; }
  getWorkerManager(): WorkerManager { return this.workerManager; }
  getMemoryStore(): MemoryStore { return this.memoryStore; }

  getMemory(): string {
    const memoryPath = this.getMemoryPath();
    return fs.existsSync(memoryPath) ? fs.readFileSync(memoryPath, 'utf-8') : '';
  }

  listWorkspaces(): string[] {
    if (!fs.existsSync(this.workspacesDir)) return ['default'];
    return fs.readdirSync(this.workspacesDir).filter(d =>
      fs.statSync(path.join(this.workspacesDir, d)).isDirectory()
    );
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
}
