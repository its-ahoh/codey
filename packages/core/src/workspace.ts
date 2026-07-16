import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CoreLogger } from './types';
import { WorkerManager } from './workers';
import { MemoryStore } from './memory';
import { SkillStore } from './skill-crystallizer';
import { TeamGraph, validateGraph } from './team-graph';

const defaultLogger: CoreLogger = {
  info: (msg: string) => console.log(msg),
  warn: (msg: string) => console.warn(msg),
  error: (msg: string) => console.error(msg),
};

export type TeamDispatchMode = 'all' | 'auto' | 'parallel';

export interface ParallelSettings {
  maxDurationMs: number;
  idleTimeoutMs: number;
  advisorPollMs: number;
}

export const DEFAULT_PARALLEL_SETTINGS: ParallelSettings = {
  maxDurationMs: 600_000,
  idleTimeoutMs: 60_000,
  advisorPollMs: 30_000,
};

/** Raw team value as it can appear in workspace.json. */
export type TeamConfigRaw =
  | string[]
  | {
      members: string[];
      dispatch?: TeamDispatchMode;
      parallel?: Partial<ParallelSettings>;
      graph?: TeamGraph;
    };

/** Normalized team value used at runtime. */
export interface TeamConfig {
  members: string[];
  dispatch: TeamDispatchMode;
  /** Only populated when dispatch === 'parallel'. */
  parallel?: ParallelSettings;
  /** Only honored when dispatch === 'all' (Sequential). */
  graph?: TeamGraph;
}

export interface WorkspaceJson {
  workingDir: string;
  /** ISO timestamp recorded when the workspace was first added to Codey. */
  createdAt?: string;
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

/** Resolve the on-disk root of the user-global memory store. Overridable via env for tests. */
export function globalMemoryDir(): string {
  return process.env.CODEY_GLOBAL_MEMORY_DIR
    ?? path.join(os.homedir(), '.codey');
}

export class WorkspaceManager {
  private workspacesDir: string;
  private currentWorkspace: string = '';
  private config: WorkspaceJson | null = null;
  private workerManager: WorkerManager;
  private memoryStore: MemoryStore;
  private skillStore: SkillStore;
  /** Which workspace `skillStore` belongs to ('' until the first load()). */
  private skillStoreWorkspace: string = '';
  /** Loaded SkillStores for NON-active workspaces (chats bound to a workspace
   *  other than the loaded one). One shared instance per name so two stores
   *  never race writes over the same skills/ files. */
  private extraSkillStores: Map<string, SkillStore> = new Map();
  /** User-global memory shared across workspaces. Lazily loaded. */
  private globalMemory: MemoryStore | null = null;
  private teams: Map<string, TeamConfig> = new Map();
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
    this.logger = logger || defaultLogger;
    this.memoryStore = new MemoryStore(this.getWorkspacePath());
    this.skillStore = new SkillStore(this.getWorkspacePath(), this.logger);
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
          JSON.stringify({ workingDir: process.cwd(), createdAt: new Date().toISOString() }, null, 2),
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

    // Teams are global: every workspace sees the full gateway-level library.
    // The workspace.json `teams` field (legacy per-workspace opt-in) is ignored.
    this.resolveTeamsFromGlobal();

    if (!fs.existsSync(this.getMemoryPath())) {
      fs.writeFileSync(this.getMemoryPath(), `# ${this.currentWorkspace} — Project Memory\n`);
    }

    const logsDir = this.getLogsDir();
    if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

    // Flush the outgoing stores so a pending debounced write can't fire later
    // and recreate a ghost directory under the previous workspace path.
    try { await this.memoryStore.flush(); } catch { /* best-effort */ }
    this.memoryStore = new MemoryStore(workspacePath);
    await this.memoryStore.load();
    await this.adoptSkillStore(this.currentWorkspace);
  }

  /** Make `workspaceName`'s SkillStore the active one. The outgoing store is
   *  flushed and stashed in `extraSkillStores` (keyed by its workspace) so a
   *  chat still bound to that workspace keeps using the SAME instance —
   *  creating a second store over the same skills/ files would race writes. */
  private async adoptSkillStore(workspaceName: string): Promise<void> {
    if (this.skillStoreWorkspace === workspaceName) return; // already active & loaded
    const outgoing = this.skillStore;
    try { await outgoing.flush(); } catch { /* best-effort */ }
    if (this.skillStoreWorkspace) {
      this.extraSkillStores.set(this.skillStoreWorkspace, outgoing);
    }
    const cached = this.extraSkillStores.get(workspaceName);
    if (cached) {
      this.extraSkillStores.delete(workspaceName);
      this.skillStore = cached;
    } else {
      this.skillStore = new SkillStore(path.join(this.workspacesDir, workspaceName), this.logger);
      await this.skillStore.load();
    }
    this.skillStoreWorkspace = workspaceName;
  }

  /**
   * Repopulate the in-memory team map from the global library. Teams are global:
   * every workspace can access every team defined in the gateway-level library,
   * so there is no per-workspace opt-in gating.
   */
  private resolveTeamsFromGlobal(): void {
    this.teams.clear();
    const lib = this.globalTeamsProvider() || {};
    for (const [name, raw] of Object.entries(lib)) {
      if (raw === undefined) continue;
      const normalized = this.normalizeTeam(name, raw);
      if (normalized) this.teams.set(name, normalized);
    }
  }

  private normalizeTeam(name: string, raw: TeamConfigRaw): TeamConfig | null {
    let members: string[];
    let dispatch: TeamDispatchMode = 'all';
    let parallel: Partial<ParallelSettings> | undefined;
    let graph: TeamGraph | undefined;

    if (Array.isArray(raw)) {
      members = raw;
    } else if (raw && typeof raw === 'object' && Array.isArray(raw.members)) {
      members = raw.members;
      if (raw.dispatch === 'auto' || raw.dispatch === 'all' || raw.dispatch === 'parallel') {
        dispatch = raw.dispatch;
      } else if (raw.dispatch !== undefined) {
        this.logger.warn(`[Workspace] Team "${name}" has invalid dispatch="${raw.dispatch}" — defaulting to "all"`);
      }
      parallel = raw.parallel;
      graph = raw.graph;
    } else {
      this.logger.error(`[Workspace] Team "${name}" has invalid shape — skipping`);
      return null;
    }

    const unknown = members.filter(m => !this.workerManager.hasWorker(m));
    if (unknown.length > 0) {
      this.logger.error(`[Workspace] Team "${name}" references unknown workers: ${unknown.join(', ')} — skipping`);
      return null;
    }

    const result: TeamConfig = { members, dispatch };
    if (dispatch === 'parallel') {
      const raw = (parallel ?? {}) as Partial<ParallelSettings> & { managerPollMs?: number };
      // Back-compat: old `managerPollMs` key maps onto `advisorPollMs`.
      if (raw.managerPollMs !== undefined && raw.advisorPollMs === undefined) {
        raw.advisorPollMs = raw.managerPollMs;
      }
      delete raw.managerPollMs;
      result.parallel = { ...DEFAULT_PARALLEL_SETTINGS, ...raw };
    }
    if (dispatch === 'all' && graph) {
      const problems = validateGraph(graph, members);
      if (problems.length === 0) {
        result.graph = graph;
      } else {
        this.logger.warn(`[Workspace] Team "${name}" has an invalid flow graph — running linearly. Problems: ${problems.join('; ')}`);
      }
    }
    return result;
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

    const config: WorkspaceJson = { workingDir: dir, createdAt: new Date().toISOString() };
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
  getSkillStore(): SkillStore { return this.skillStore; }

  /** SkillStore for a NAMED workspace — skills are per-workspace state, so
   *  callers acting on behalf of a chat must use the chat's workspace, not
   *  whichever workspace happens to be loaded. Returns the live store when the
   *  name matches the active workspace; otherwise lazily loads and caches one
   *  shared instance per name. Throws if the workspace does not exist. */
  async getSkillStoreFor(workspaceName: string): Promise<SkillStore> {
    if (!workspaceName || workspaceName === this.skillStoreWorkspace) return this.skillStore;
    let store = this.extraSkillStores.get(workspaceName);
    if (!store) {
      const dir = path.join(this.workspacesDir, workspaceName);
      if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
        throw new Error(`Workspace "${workspaceName}" does not exist`);
      }
      store = new SkillStore(dir, this.logger);
      await store.load();
      this.extraSkillStores.set(workspaceName, store);
    }
    return store;
  }

  /**
   * User-global memory store, rooted at `~/.codey/` (override via
   * `CODEY_GLOBAL_MEMORY_DIR`). Lazily instantiated and survives workspace
   * switches. Use for cross-workspace preferences ("use pnpm not npm"),
   * coding conventions, persistent user facts.
   */
  getGlobalMemoryStore(): MemoryStore {
    if (!this.globalMemory) {
      this.globalMemory = new MemoryStore(globalMemoryDir());
      // Best-effort eager load so the first buildContext doesn't read empty.
      void this.globalMemory.load().catch(() => { /* swallow — store is best-effort */ });
    }
    return this.globalMemory;
  }

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
    if (this.currentWorkspace === oldName) {
      // Drain pending debounced writes BEFORE the directory moves — the old
      // stores' paths point at src, so a late flush would recreate a ghost
      // directory there.
      try { await this.memoryStore.flush(); } catch { /* best-effort */ }
      try { await this.skillStore.flush(); } catch { /* best-effort */ }
    }
    // Same for a cached non-active store bound to the old name.
    const extraOld = this.extraSkillStores.get(oldName);
    if (extraOld) {
      try { await extraOld.flush(); } catch { /* best-effort */ }
      this.extraSkillStores.delete(oldName);
    }
    await fs.promises.rename(src, dst);
    this.logger.info(`[Workspace] Renamed workspace: ${oldName} -> ${trimmed}`);
    if (this.currentWorkspace === oldName) {
      this.currentWorkspace = trimmed;
      this.memoryStore = new MemoryStore(this.getWorkspacePath());
      await this.memoryStore.load();
      this.skillStore = new SkillStore(this.getWorkspacePath(), this.logger);
      await this.skillStore.load();
      this.skillStoreWorkspace = trimmed;
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

    // Drop any cached SkillStore for the deleted workspace so a late debounced
    // write can't recreate the directory; forget the active store's binding too.
    this.extraSkillStores.delete(name);
    if (this.skillStoreWorkspace === name) this.skillStoreWorkspace = '';

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
    }).map(name => {
      const dir = path.join(this.workspacesDir, name);
      const configPath = path.join(dir, 'workspace.json');
      let addedAt = 0;
      try {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as WorkspaceJson;
        const parsed = config.createdAt ? Date.parse(config.createdAt) : NaN;
        if (Number.isFinite(parsed)) addedAt = parsed;
      } catch { /* keep the filesystem fallback below */ }
      // Existing workspaces predate createdAt. Directory birth time is the
      // closest durable equivalent to the date they were added.
      if (!addedAt) {
        const stat = fs.statSync(dir);
        addedAt = stat.birthtimeMs || stat.ctimeMs;
      }
      return { name, addedAt };
    }).sort((a, b) => b.addedAt - a.addedAt || a.name.localeCompare(b.name))
      .map(({ name }) => name);
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
    if (this.teams.size === 0) return 'No teams defined yet.';
    return Array.from(this.teams.entries())
      .map(([name, t]) => {
        const mode = t.dispatch === 'auto' ? ' [auto]' : '';
        return `• **${name}**${mode} → ${t.members.join(' → ')}`;
      })
      .join('\n');
  }
}
