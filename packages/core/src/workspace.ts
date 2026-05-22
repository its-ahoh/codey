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

export type TeamDispatchMode = 'all' | 'auto';

/** Raw team value as it can appear in workspace.json. */
export type TeamConfigRaw = string[] | { members: string[]; dispatch?: TeamDispatchMode };

/** Normalized team value used at runtime. */
export interface TeamConfig {
  members: string[];
  dispatch: TeamDispatchMode;
}

export interface WorkspaceJson {
  workingDir: string;
  /**
   * Names of global teams enabled for this workspace. Definitions live in the
   * gateway-level team library; this is just the opt-in list.
   *
   * Legacy: an older `Record<string, TeamConfigRaw>` value is still accepted
   * on read — its keys are treated as the enabled-name list, and the values
   * are ignored (the global library is the source of truth).
   */
  teams?: string[] | Record<string, TeamConfigRaw>;
}

/** Returns the global team library. Injected so core stays independent of gateway config storage. */
export type GlobalTeamsProvider = () => Record<string, TeamConfigRaw>;

export class WorkspaceManager {
  private workspacesDir: string;
  private currentWorkspace: string = '';
  private config: WorkspaceJson | null = null;
  private workerManager: WorkerManager;
  private memoryStore: MemoryStore;
  private teams: Map<string, TeamConfig> = new Map();
  private enabledTeamNames: string[] = [];
  private globalTeamsProvider: GlobalTeamsProvider;
  private logger: CoreLogger;

  constructor(
    workerManager: WorkerManager,
    workspacesDir: string = './workspaces',
    logger?: CoreLogger,
    globalTeamsProvider?: GlobalTeamsProvider,
  ) {
    this.workspacesDir = workspacesDir;
    this.workerManager = workerManager;
    this.memoryStore = new MemoryStore(this.getWorkspacePath());
    this.logger = logger || defaultLogger;
    this.globalTeamsProvider = globalTeamsProvider || (() => ({}));
  }

  /** Swap the global teams provider after construction (e.g. once the gateway ConfigManager is wired up). */
  setGlobalTeamsProvider(provider: GlobalTeamsProvider): void {
    this.globalTeamsProvider = provider;
    // Re-resolve so the current workspace immediately sees the live library.
    this.resolveTeamsFromGlobal();
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

    // Workspace.teams is now a `string[]` of enabled team names; definitions
    // come from the global library. Accept legacy `Record<...>` shape by
    // using its keys as the enabled names — old workspaces keep working.
    const rawTeamsField = this.config?.teams;
    if (Array.isArray(rawTeamsField)) {
      this.enabledTeamNames = rawTeamsField.filter(n => typeof n === 'string' && n.trim().length > 0);
    } else if (rawTeamsField && typeof rawTeamsField === 'object') {
      this.enabledTeamNames = Object.keys(rawTeamsField);
    } else {
      this.enabledTeamNames = [];
    }
    this.resolveTeamsFromGlobal();

    if (!fs.existsSync(this.getMemoryPath())) {
      fs.writeFileSync(this.getMemoryPath(), `# ${this.currentWorkspace} — Project Memory\n`);
    }

    const logsDir = this.getLogsDir();
    if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

    this.memoryStore = new MemoryStore(workspacePath);
    await this.memoryStore.load();
  }

  /** Repopulate the in-memory team map from `enabledTeamNames` ∩ global library. */
  private resolveTeamsFromGlobal(): void {
    this.teams.clear();
    const lib = this.globalTeamsProvider() || {};
    for (const name of this.enabledTeamNames) {
      const raw = lib[name];
      if (raw === undefined) {
        this.logger.warn(`[Workspace] Team "${name}" enabled on workspace but not defined in global library — skipping`);
        continue;
      }
      const normalized = this.normalizeTeam(name, raw);
      if (normalized) this.teams.set(name, normalized);
    }
  }

  private normalizeTeam(name: string, raw: TeamConfigRaw): TeamConfig | null {
    let members: string[];
    let dispatch: TeamDispatchMode = 'all';

    if (Array.isArray(raw)) {
      members = raw;
    } else if (raw && typeof raw === 'object' && Array.isArray(raw.members)) {
      members = raw.members;
      if (raw.dispatch === 'auto' || raw.dispatch === 'all') dispatch = raw.dispatch;
      else if (raw.dispatch !== undefined) {
        this.logger.warn(`[Workspace] Team "${name}" has invalid dispatch="${raw.dispatch}" — defaulting to "all"`);
      }
    } else {
      this.logger.error(`[Workspace] Team "${name}" has invalid shape — skipping`);
      return null;
    }

    const unknown = members.filter(m => !this.workerManager.hasWorker(m));
    if (unknown.length > 0) {
      this.logger.error(`[Workspace] Team "${name}" references unknown workers: ${unknown.join(', ')} — skipping`);
      return null;
    }
    return { members, dispatch };
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

  async renameWorkspace(oldName: string, newName: string): Promise<void> {
    if (oldName === 'default') {
      throw new Error('The "default" workspace is protected and cannot be renamed.');
    }
    const trimmed = newName.trim();
    if (!trimmed) throw new Error('New workspace name is required');
    if (!/^[A-Za-z0-9._-]+$/.test(trimmed)) {
      throw new Error('Workspace name may only contain letters, numbers, dot, underscore and hyphen');
    }
    if (trimmed === oldName) return;
    const src = path.join(this.workspacesDir, oldName);
    const dst = path.join(this.workspacesDir, trimmed);
    if (!fs.existsSync(src)) throw new Error(`Workspace "${oldName}" does not exist`);
    if (fs.existsSync(dst)) throw new Error(`Workspace "${trimmed}" already exists`);
    const root = path.resolve(this.workspacesDir);
    if (!path.resolve(src).startsWith(root + path.sep) ||
        !path.resolve(dst).startsWith(root + path.sep)) {
      throw new Error('Refusing to rename outside of workspaces root');
    }
    await fs.promises.rename(src, dst);
    this.logger.info(`[Workspace] Renamed workspace: ${oldName} -> ${trimmed}`);
    if (this.currentWorkspace === oldName) {
      this.currentWorkspace = trimmed;
      this.memoryStore = new MemoryStore(this.getWorkspacePath());
    }
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

  getTeam(name: string): TeamConfig | undefined {
    for (const [key, value] of this.teams) {
      if (key.toLowerCase() === name.toLowerCase()) return value;
    }
    return undefined;
  }

  getTeamNames(): string[] {
    return Array.from(this.teams.keys());
  }

  listTeams(): string {
    if (this.teams.size === 0) return 'No teams declared for this workspace.';
    return Array.from(this.teams.entries())
      .map(([name, t]) => {
        const mode = t.dispatch === 'auto' ? ' [auto]' : '';
        return `• **${name}**${mode} → ${t.members.join(' → ')}`;
      })
      .join('\n');
  }

  /**
   * Replace the workspace's enabled-team list. Definitions are not stored here
   * — they live in the global team library and are resolved on read.
   * Names that don't exist in the global library are persisted anyway (so a
   * later library edit lights them up) but logged.
   */
  async setEnabledTeams(names: string[]): Promise<void> {
    const seen = new Set<string>();
    this.enabledTeamNames = (names || []).filter(n => {
      if (typeof n !== 'string' || !n.trim() || seen.has(n)) return false;
      seen.add(n);
      return true;
    });
    this.resolveTeamsFromGlobal();
    const configPath = this.getConfigPath();
    const existing = JSON.parse(await fs.promises.readFile(configPath, 'utf-8'));
    existing.teams = [...this.enabledTeamNames];
    await fs.promises.writeFile(configPath, JSON.stringify(existing, null, 2), 'utf-8');
  }

  /** Names of global teams enabled for this workspace. */
  getEnabledTeamNames(): string[] {
    return [...this.enabledTeamNames];
  }
}
