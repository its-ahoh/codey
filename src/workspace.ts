import * as fs from 'fs';
import * as path from 'path';
import { WorkerManager, WorkerJsonConfig } from './workers';

export interface WorkspaceJson {
  workingDir: string;
  workers: Record<string, WorkerJsonConfig>;
}

export class WorkspaceManager {
  private workspacesDir: string;
  private currentWorkspace: string = 'default';
  private config: WorkspaceJson | null = null;
  private workerManager: WorkerManager;

  constructor(workspacesDir: string = './workspaces') {
    this.workspacesDir = workspacesDir;
    this.workerManager = new WorkerManager(this.getWorkspacePath());
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

    // Migrate workers.json -> workspace.json if needed
    const legacyPath = path.join(workspacePath, 'workers.json');
    if (!fs.existsSync(configPath) && fs.existsSync(legacyPath)) {
      this.migrateFromWorkersJson(legacyPath, configPath);
    }

    if (fs.existsSync(configPath)) {
      const data = fs.readFileSync(configPath, 'utf-8');
      this.config = JSON.parse(data);
      console.log(`[Workspace] Loaded workspace: ${this.currentWorkspace}`);
    } else {
      this.config = { workingDir: process.cwd(), workers: {} };
      console.log(`[Workspace] No config found for ${this.currentWorkspace}, using defaults`);
    }

    // Ensure memory.md exists
    const memoryPath = this.getMemoryPath();
    if (!fs.existsSync(memoryPath)) {
      fs.writeFileSync(memoryPath, `# ${this.currentWorkspace} — Project Memory\n`);
    }

    // Ensure logs/ directory exists
    const logsDir = this.getLogsDir();
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }

    // Load workers
    this.workerManager = new WorkerManager(this.getWorkspacePath());
    await this.workerManager.loadWorkers();
  }

  private migrateFromWorkersJson(legacyPath: string, newPath: string): void {
    const data = fs.readFileSync(legacyPath, 'utf-8');
    const legacy = JSON.parse(data);
    const migrated: WorkspaceJson = {
      workingDir: process.cwd(),
      workers: legacy.workers || {},
    };
    fs.writeFileSync(newPath, JSON.stringify(migrated, null, 2));
    console.log(`[Workspace] Migrated workers.json -> workspace.json`);
  }

  async switchWorkspace(workspaceId: string): Promise<boolean> {
    const workspacePath = path.join(this.workspacesDir, workspaceId);
    if (!fs.existsSync(workspacePath)) {
      return false;
    }
    this.currentWorkspace = workspaceId;
    await this.load();
    return true;
  }

  async findOrCreateByDir(dir: string): Promise<string> {
    // Check if any existing workspace already points to this directory
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

    // No match — create a new workspace from the directory basename
    let name = path.basename(dir).toLowerCase().replace(/[^a-z0-9-_]/g, '-');
    if (workspaces.includes(name)) {
      // Avoid collision by appending a suffix
      let i = 2;
      while (workspaces.includes(`${name}-${i}`)) i++;
      name = `${name}-${i}`;
    }

    const workspacePath = path.join(this.workspacesDir, name);
    fs.mkdirSync(workspacePath, { recursive: true });
    fs.mkdirSync(path.join(workspacePath, 'workers'), { recursive: true });

    const config: WorkspaceJson = { workingDir: dir, workers: {} };
    fs.writeFileSync(path.join(workspacePath, 'workspace.json'), JSON.stringify(config, null, 2));
    fs.writeFileSync(path.join(workspacePath, 'memory.md'), `# ${name} — Project Memory\n`);

    console.log(`[Workspace] Created new workspace: ${name} -> ${dir}`);
    await this.switchWorkspace(name);
    return name;
  }

  getLogsDir(): string {
    return path.join(this.getWorkspacePath(), 'logs');
  }

  getLogPath(): string {
    return path.join(this.getLogsDir(), 'app.log');
  }

  getErrorLogPath(): string {
    return path.join(this.getLogsDir(), 'error.log');
  }

  getWorkingDir(): string {
    return this.config?.workingDir || process.cwd();
  }

  getCurrentWorkspace(): string {
    return this.currentWorkspace;
  }

  getWorkerManager(): WorkerManager {
    return this.workerManager;
  }

  getMemory(): string {
    const memoryPath = this.getMemoryPath();
    if (fs.existsSync(memoryPath)) {
      return fs.readFileSync(memoryPath, 'utf-8');
    }
    return '';
  }

  listWorkspaces(): string[] {
    if (!fs.existsSync(this.workspacesDir)) return ['default'];
    return fs.readdirSync(this.workspacesDir).filter(d =>
      fs.statSync(path.join(this.workspacesDir, d)).isDirectory()
    );
  }
}
