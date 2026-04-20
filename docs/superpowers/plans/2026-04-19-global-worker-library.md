# Global Worker Library Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace per-workspace worker definitions with a single global `workers/` library. Workspaces drop their `workers` field and gain an optional `teams` field. A startup guard refuses to boot when legacy layout is present.

**Architecture:** Folder-per-worker at repo root (`workers/<name>/{personality.md, config.json}`). `WorkerManager` becomes process-scoped (not workspace-scoped) and is injected into `WorkspaceManager`. `WorkspaceManager` gains team parsing + validation. Gateway command regexes and handlers update for the new `/team <name> <task>` contract.

**Tech Stack:** TypeScript, Node `fs`/`path`, existing repo scripts (`npm run build`, `npm run dev`). No test runner (per `CLAUDE.md`) — verification is a Node script that exercises the guard + loader + commands.

**Spec:** `docs/superpowers/specs/2026-04-19-global-worker-library-design.md`

---

## File Structure

**Create:**
- `src/startup-guard.ts` — legacy-layout detection, prints migration message, exits non-zero.
- `workers/architect/personality.md` — seed worker (fresh file, not migrated).
- `workers/architect/config.json` — seed worker config.
- `workers/executor/personality.md` — seed worker.
- `workers/executor/config.json` — seed worker config.
- `scripts/verify-workers.ts` — manual verification script covering the six spec test cases.

**Modify:**
- `src/workers.ts` — full rewrite: global library, folder-per-worker, no `setWorkspace`, no relationships.
- `src/workspace.ts` — drop `workers` from `WorkspaceJson`, add `teams`, stop owning a per-workspace `WorkerManager` instance (accept one from caller), add `getTeam`/`getTeamNames`, remove `workers/` folder creation in `findOrCreateByDir`.
- `src/gateway.ts` — update `/worker` and `/team` regexes + handlers, add `cmdTeams`, update help text, remove the relationship-based "run all workers" behavior.
- `src/index.ts` — call startup guard before instantiating `Codey`; construct a single `WorkerManager` and hand it to `Codey`.
- `package.json` — add `"verify-workers"` script.

**Delete (repo data cleanup, keeps git history intact):**
- `workspaces/default/workers/` (folder)
- `workspaces/dailie-poster/workers/` (if it contains any `.md`)
- `workspaces/context-archive/workers/` (if it contains any `.md`)
- The `"workers"` field in every `workspaces/*/workspace.json`.

---

## Task 1: Rewrite `src/workers.ts` as a global library

**Files:**
- Modify: `src/workers.ts` (full rewrite, replacing lines 1–212)

- [ ] **Step 1: Replace `src/workers.ts` with the new global implementation**

Overwrite the entire file with:

```ts
import * as fs from 'fs';
import * as path from 'path';

export interface WorkerPersonality {
  role: string;
  soul: string;
  instructions: string;
}

export interface WorkerConfig {
  codingAgent: 'claude-code' | 'opencode' | 'codex';
  model: string;
  tools: string[];
}

export interface Worker {
  name: string;
  personality: WorkerPersonality;
  config: WorkerConfig;
}

export class WorkerManager {
  private workersDir: string;
  private workers: Map<string, Worker> = new Map();

  constructor(workersDir: string = './workers') {
    this.workersDir = workersDir;
  }

  async loadWorkers(): Promise<void> {
    this.workers.clear();

    if (!fs.existsSync(this.workersDir)) {
      console.log(`[Workers] Library not found at ${this.workersDir} — no workers loaded`);
      return;
    }

    const entries = fs.readdirSync(this.workersDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const name = entry.name;
      const worker = this.loadWorker(name);
      if (worker) this.workers.set(name.toLowerCase(), worker);
    }

    console.log(`[Workers] Loaded ${this.workers.size} workers from ${this.workersDir}`);
  }

  private loadWorker(name: string): Worker | null {
    const dir = path.join(this.workersDir, name);
    const mdPath = path.join(dir, 'personality.md');
    const cfgPath = path.join(dir, 'config.json');

    if (!fs.existsSync(mdPath)) {
      console.error(`[Workers] Skipping ${name}: personality.md missing`);
      return null;
    }
    if (!fs.existsSync(cfgPath)) {
      console.error(`[Workers] Skipping ${name}: config.json missing (required)`);
      return null;
    }

    let config: WorkerConfig;
    try {
      config = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
    } catch (err) {
      console.error(`[Workers] Skipping ${name}: config.json invalid JSON (${err})`);
      return null;
    }

    if (!config.codingAgent || !config.model) {
      console.error(`[Workers] Skipping ${name}: config.json missing codingAgent or model`);
      return null;
    }
    if (!Array.isArray(config.tools)) config.tools = [];

    const personality = this.parsePersonality(fs.readFileSync(mdPath, 'utf-8'));
    return { name, personality, config };
  }

  private parsePersonality(content: string): WorkerPersonality {
    const personality: WorkerPersonality = { role: '', soul: '', instructions: '' };
    const lines = content.split('\n');
    let currentSection = '';
    let buffer: string[] = [];

    const flush = () => {
      const trimmed = buffer.join('\n').trim();
      if (!trimmed) return;
      if (currentSection === 'role') personality.role = trimmed;
      else if (currentSection === 'soul') personality.soul = trimmed;
      else if (currentSection === 'instructions') personality.instructions = trimmed;
    };

    for (const line of lines) {
      if (line.startsWith('## ')) {
        flush();
        currentSection = line.replace(/^##\s+/, '').toLowerCase();
        buffer = [];
      } else if (line.startsWith('# ')) {
        // title line, ignored
      } else {
        buffer.push(line);
      }
    }
    flush();
    return personality;
  }

  getWorker(name: string): Worker | undefined {
    return this.workers.get(name.toLowerCase());
  }

  hasWorker(name: string): boolean {
    return this.workers.has(name.toLowerCase());
  }

  getAllWorkers(): Worker[] {
    return Array.from(this.workers.values());
  }

  getWorkerNames(): string[] {
    return Array.from(this.workers.keys());
  }

  getWorkerCodingAgent(name: string): string {
    return this.getWorker(name)?.config.codingAgent || 'claude-code';
  }

  getWorkerModel(name: string): string {
    return this.getWorker(name)?.config.model || '';
  }

  buildWorkerPrompt(name: string, task: string): string {
    const worker = this.getWorker(name);
    if (!worker) return task;
    return [
      `# Worker: ${worker.name}`,
      `## Role`,
      worker.personality.role,
      `## Personality`,
      worker.personality.soul,
      `## Instructions`,
      worker.personality.instructions,
      `## Task`,
      task,
    ].join('\n\n');
  }

  listWorkers(): string {
    const all = this.getAllWorkers();
    if (all.length === 0) return 'No workers configured. Create folders under ./workers/<name>/ with personality.md and config.json.';
    return all.map(w => `• **${w.name}** — ${w.personality.role || '(no role)'} (${w.config.codingAgent}/${w.config.model})`).join('\n');
  }
}
```

- [ ] **Step 2: Compile to verify types**

Run: `npm run build`
Expected: no TypeScript errors from `src/workers.ts`. Errors from `src/workspace.ts` and `src/gateway.ts` are expected (fixed in later tasks).

- [ ] **Step 3: Commit**

```bash
git add src/workers.ts
git commit -m "refactor(workers): rewrite as global library loader

Folder-per-worker layout with required config.json. Drops
setWorkspace, relationship parsing, and legacy workerConfigs map.
Callers in workspace.ts and gateway.ts are intentionally broken
at this point; next tasks fix them.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 2: Add startup guard

**Files:**
- Create: `src/startup-guard.ts`
- Modify: `src/index.ts` (call the guard before constructing `Codey`)

- [ ] **Step 1: Create `src/startup-guard.ts`**

```ts
import * as fs from 'fs';
import * as path from 'path';

const MIGRATION_MSG = [
  '❌ Legacy worker layout detected.',
  '',
  'Codey now uses a global workers/ library at the repo root.',
  'Offending paths:',
  '{PATHS}',
  '',
  'To fix:',
  '  1. Move each worker to ./workers/<name>/personality.md + config.json',
  '  2. Remove the "workers" field from every workspace.json',
  '  3. (Optional) Declare teams in workspace.json under "teams": { "<name>": [...] }',
  '',
  'See docs/superpowers/specs/2026-04-19-global-worker-library-design.md',
].join('\n');

export function assertNoLegacyLayout(workspacesDir: string = './workspaces'): void {
  const problems: string[] = [];

  if (fs.existsSync(workspacesDir)) {
    for (const entry of fs.readdirSync(workspacesDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const wsPath = path.join(workspacesDir, entry.name);

      const legacyWorkersDir = path.join(wsPath, 'workers');
      if (fs.existsSync(legacyWorkersDir)) {
        problems.push(`  - ${legacyWorkersDir} (remove this folder)`);
      }

      const cfgPath = path.join(wsPath, 'workspace.json');
      if (fs.existsSync(cfgPath)) {
        try {
          const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
          if (cfg.workers !== undefined) {
            problems.push(`  - ${cfgPath} (remove the "workers" field)`);
          }
        } catch {
          // Malformed JSON is a different problem; let the normal loader surface it.
        }
      }
    }
  }

  if (problems.length > 0) {
    console.error(MIGRATION_MSG.replace('{PATHS}', problems.join('\n')));
    process.exit(1);
  }
}
```

- [ ] **Step 2: Wire the guard into `src/index.ts`**

Edit `src/index.ts`:

Add the import at the top (after the existing imports):

```ts
import { assertNoLegacyLayout } from './startup-guard';
```

Inside `main()` in `startGateway`, add the guard call as the very first line of the function body (before `logger.banner`):

```ts
  async function main() {
    assertNoLegacyLayout('./workspaces');
    logger.banner('🚀 Codey');
    // ... rest unchanged
```

Also add the same call at the top of `startTui()` (after the function's `args` parsing but before `gateway.start` / `gateway.startTui`). Insert just after the opening brace:

```ts
async function startTui(): Promise<void> {
  assertNoLegacyLayout('./workspaces');
  // ... rest unchanged
```

- [ ] **Step 3: Compile**

Run: `npm run build`
Expected: compiles the guard module cleanly. Callers of the old `WorkerManager` API in `workspace.ts` and `gateway.ts` still error — fine, fixed later.

- [ ] **Step 4: Verify the guard fires against the current repo state**

Run: `node dist/startup-guard.js 2>&1 || true`
Expected: nothing (module exports a function, it isn't invoked on import).

Better: run the guard via a one-off command.

Run: `node -e "require('./dist/startup-guard').assertNoLegacyLayout('./workspaces')"`
Expected: prints the migration message listing every `workspaces/*/workers/` folder and every `workspace.json` containing a `workers` field. Exits with code 1. This is the expected behavior right now — the cleanup step happens in Task 5.

- [ ] **Step 5: Commit**

```bash
git add src/startup-guard.ts src/index.ts
git commit -m "feat(startup): refuse to boot on legacy worker layout

Detects per-workspace workers/ folders and legacy workers fields
in workspace.json, prints a migration message, exits 1.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 3: Update `src/workspace.ts` for teams + shared WorkerManager

**Files:**
- Modify: `src/workspace.ts` (full rewrite of the worker-related surface)

- [ ] **Step 1: Rewrite `src/workspace.ts`**

Overwrite the file with:

```ts
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
```

- [ ] **Step 2: Update `src/index.ts` to construct a shared `WorkerManager`**

In `src/index.ts`, in `startGateway().main()`, immediately after `assertNoLegacyLayout('./workspaces');` and before `new Codey(...)`:

```ts
    const { WorkerManager } = await import('./workers');
    const workerManager = new WorkerManager('./workers');
    await workerManager.loadWorkers();
    const gateway = new Codey(gatewayConfig, logger, './workspaces', configManager, workerManager);
```

Replace the existing `new Codey(...)` line accordingly (it becomes the line above). Do the same in `startTui()`: after the guard call, construct the manager and pass it to `Codey`.

- [ ] **Step 3: Compile**

Run: `npm run build`
Expected: `workspace.ts` compiles. `gateway.ts` still has errors — it needs to accept `workerManager` in its constructor and update handlers. Fixed in Task 4.

- [ ] **Step 4: Commit**

```bash
git add src/workspace.ts src/index.ts
git commit -m "refactor(workspace): share WorkerManager, parse teams

WorkspaceJson drops the workers field and gains teams. Teams are
validated against the global worker library on workspace load;
unknown members cause the team to be skipped with a logged error.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 4: Update `src/gateway.ts` commands and constructor

**Files:**
- Modify: `src/gateway.ts`

- [ ] **Step 1: Accept a `WorkerManager` in the constructor**

In `src/gateway.ts`, ensure `WorkerManager` is imported from `./workers` (add it to the existing import if not already there):

```ts
import { WorkerManager } from './workers';
```

Find the `Codey` constructor at lines 98–123. It currently reads:

```ts
  constructor(config: GatewayConfig, logger?: Logger, workspaceDir?: string, configManager?: ConfigManager) {
```

Make two precise edits — do NOT rewrite the whole constructor body; all existing initializer lines (contextManager restore, planner setup, COOLDOWN_MS, etc.) stay as-is.

**Edit 1:** add a 5th parameter `workerManager?: WorkerManager` to the signature:

```ts
  constructor(config: GatewayConfig, logger?: Logger, workspaceDir?: string, configManager?: ConfigManager, workerManager?: WorkerManager) {
```

**Edit 2:** replace the single line at line 121:

```ts
    this.workspaceManager = new WorkspaceManager(workspaceDir || './workspaces');
```

with:

```ts
    const wm = workerManager ?? new WorkerManager('./workers');
    this.workspaceManager = new WorkspaceManager(wm, workspaceDir || './workspaces');
```

Leave every other line in the constructor (including `this.COOLDOWN_MS = config.rateLimitMs || 3000;`) untouched.

- [ ] **Step 2: Update the `/team` regex to require a team name**

Find (around line 56):

```ts
  private static readonly REGEX_TEAM = /\/team\s+(.+)/i;
```

Replace with:

```ts
  private static readonly REGEX_TEAM = /\/team\s+(\w+)\s+(.+)/i;
```

Also find the duplicate regex inside `onUserMessage` (grep for `/\/worker\\s+` at approximately line 1342) and update the `/team` regex there too if present.

- [ ] **Step 3: Rewrite `runTeamTask` to take a team name**

Find the method signature (around line 1251):

```ts
  private async runTeamTask(message: UserMessage, task: string): Promise<void> {
```

Replace the entire method body (lines 1251–1323) with:

```ts
  private async runTeamTask(message: UserMessage, teamName: string, task: string): Promise<void> {
    const { chatId, channel } = message;

    if (!teamName || !task.trim()) {
      const teamList = this.workspaceManager.listTeams();
      await this.sendResponse({
        chatId,
        channel,
        text: `Usage: /team <name> <task>\n\nTeams on this workspace:\n${teamList}`,
      });
      return;
    }

    const members = this.workspaceManager.getTeam(teamName);
    if (!members) {
      const teamList = this.workspaceManager.listTeams();
      await this.sendResponse({
        chatId,
        channel,
        text: `Team "${teamName}" not found on workspace "${this.workspaceManager.getCurrentWorkspace()}".\n\nAvailable teams:\n${teamList}`,
      });
      return;
    }

    const workerManager = this.workspaceManager.getWorkerManager();

    await this.sendResponse({
      chatId,
      channel,
      text: `👥 Running team **${teamName}** (${members.join(' → ')})\nTask: ${task.substring(0, 100)}${task.length > 100 ? '...' : ''}`,
    });

    let currentTask = task;
    const results: string[] = [];

    for (const memberName of members) {
      const worker = workerManager.getWorker(memberName);
      if (!worker) {
        results.push(`**${memberName}**: ❌ not found in global library`);
        break;
      }

      const codingAgent = workerManager.getWorkerCodingAgent(memberName) as CodingAgent;
      const model = workerManager.getWorkerModel(memberName);

      await this.sendResponse({
        chatId,
        channel,
        text: `🔄 Worker **${worker.name}** is working...`,
      });

      const prompt = workerManager.buildWorkerPrompt(memberName, currentTask);
      const modelConfig = this.getModelConfig(codingAgent, model);
      const handler = this.handlers.get(channel);
      const onStream = handler?.streamText ? (text: string) => handler.streamText!(text) : undefined;

      const response = await this.runWithFallback(codingAgent, {
        prompt,
        agent: codingAgent,
        model: modelConfig,
        interactive: this.tuiMode,
        onStream,
        context: { workingDir: this.workingDir },
      });

      if (response.success) {
        results.push(`**${worker.name}**: ${response.output.substring(0, 500)}`);
        currentTask = `Previous worker output:\n${response.output}\n\nYour task: ${task}`;
      } else {
        results.push(`**${worker.name}**: ❌ Failed - ${response.error}`);
        break;
      }
    }

    await this.sendResponse({
      chatId,
      channel,
      text: `📊 Team **${teamName}** results\n\n${results.join('\n\n')}`,
    });
  }
```

- [ ] **Step 4: Update the `/team` call sites**

Find `case 'team':` (around line 619). Replace:

```ts
      case 'team':
        await this.runTeamTask(message, parsed.prompt);
        break;
```

With:

```ts
      case 'team':
        await this.runTeamTask(message, args[0] || '', args.slice(1).join(' ') || parsed.prompt);
        break;
```

Find the direct regex match path (around line 1342, in `onUserMessage`):

```ts
      const workerMatch = text.match(/\/worker\s+(\w+)\s+(.+)/i);
      if (workerMatch) { ... }
```

There is very likely a sibling `/team` match just after it. If the existing code has `/team\s+(.+)/i` calling `runTeamTask(message, teamMatch[1])`, replace with:

```ts
      const teamMatch = text.match(/\/team\s+(\w+)\s+(.+)/i);
      if (teamMatch) {
        await this.runTeamTask(message, teamMatch[1], teamMatch[2]);
        return;
      }
```

If this path doesn't exist, skip this sub-step.

- [ ] **Step 5: Add `/teams` command**

Find the `switch (command)` inside `handleCommand` (around lines 610–625, where `'workers'`, `'worker'`, `'team'` cases live). Add a new case after `'team'`:

```ts
      case 'teams':
        await this.cmdTeams(chatId, channel);
        break;
```

Add the method alongside `cmdWorkers` (around line 877):

```ts
  private async cmdTeams(chatId: string, channel: ChannelType): Promise<void> {
    await this.sendResponse({
      chatId,
      channel,
      text: `👥 Teams on workspace **${this.workspaceManager.getCurrentWorkspace()}**\n\n${this.workspaceManager.listTeams()}`,
    });
  }
```

- [ ] **Step 6: Update help text**

Find the help block (around lines 1083–1086) that lists worker commands. Replace:

```
/workers - List all workers
/worker <name> <task> - Run a specific worker
/team <task> - Run workers in sequence
```

With:

```
/workers - List all workers in the global library
/worker <name> <task> - Run a specific worker
/teams - List teams declared on this workspace
/team <name> <task> - Run a named team in sequence
```

Also update the short usage line near line 669 (inside `cmdHelp`):

```ts
        `- /worker <name> <task> — run a specific worker`,
        `- /team <task> — run workers in sequence`,
```

Replace with:

```ts
        `- /worker <name> <task> — run a specific worker`,
        `- /teams — list teams for this workspace`,
        `- /team <name> <task> — run a named team in sequence`,
```

And update the example at line 1113:

```
Example: /team build a todo app
```

to:

```
Example: /team review audit this PR
```

- [ ] **Step 7: Compile**

Run: `npm run build`
Expected: clean build across the whole repo.

- [ ] **Step 8: Commit**

```bash
git add src/gateway.ts
git commit -m "feat(gateway): named teams and /teams command

/team now takes a team name plus a task; team definitions come from
workspace.json. /teams lists declared teams for the current workspace.
/worker unknown-name errors surface the global library list. Removes
the previous 'run every worker in sequence' fallback.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 5: Repo data cleanup + seed workers

**Files:**
- Create: `workers/architect/personality.md`
- Create: `workers/architect/config.json`
- Create: `workers/executor/personality.md`
- Create: `workers/executor/config.json`
- Modify: `workspaces/default/workspace.json` (remove `workers`, add `teams`)
- Modify: `workspaces/dailie-poster/workspace.json` (remove `workers` if present)
- Modify: `workspaces/context-archive/workspace.json` (remove `workers` if present)
- Delete: `workspaces/default/workers/` (entire folder)
- Delete: `workspaces/*/workers/` for any other workspace that has one

- [ ] **Step 1: Create seed architect**

Create `workers/architect/personality.md` with:

```markdown
# Worker: Architect

## Role
System architect that designs high-level structure and trade-offs before code is written.

## Soul
Methodical, opinionated, allergic to premature abstraction. Always asks "what's the simplest thing that could possibly work?" before proposing a design.

## Instructions
When given a task:
1. Clarify the goal and surface any ambiguous requirements.
2. Propose at most two approaches with trade-offs.
3. Recommend one and explain why.
4. Stop before writing implementation code — hand off to the executor.
```

Create `workers/architect/config.json` with:

```json
{
  "codingAgent": "claude-code",
  "model": "claude-opus-4-6",
  "tools": ["file-system", "git", "web-search"]
}
```

- [ ] **Step 2: Create seed executor**

Create `workers/executor/personality.md` with:

```markdown
# Worker: Executor

## Role
Implementer that turns an approved design into working code with tests and a commit.

## Soul
Pragmatic, disciplined, TDD-minded. Reads existing conventions before writing anything new.

## Instructions
When given a task:
1. Read the surrounding code to match conventions.
2. Write the failing test first, then the minimum code to pass it.
3. Commit in small, reviewable steps.
4. Report what changed and what's left.
```

Create `workers/executor/config.json` with:

```json
{
  "codingAgent": "claude-code",
  "model": "claude-sonnet-4-6",
  "tools": ["file-system", "git", "npm", "docker"]
}
```

- [ ] **Step 3: Rewrite `workspaces/default/workspace.json`**

Replace the file contents with:

```json
{
  "workingDir": "./",
  "teams": {
    "review": ["architect", "executor"]
  }
}
```

- [ ] **Step 4: Strip `workers` field from every other workspace.json**

Run: `ls workspaces/`
Expected: lists `default`, plus any other workspaces (e.g. `dailie-poster`, `context-archive`).

For each non-default workspace `<name>`, open `workspaces/<name>/workspace.json` and:
- Remove any `"workers"` field.
- Leave `"workingDir"` untouched.
- Do not add a `"teams"` field unless the user wants one.

Example: if `workspaces/context-archive/workspace.json` currently is:

```json
{ "workingDir": "/Users/jackou/archive", "workers": { ... } }
```

Change it to:

```json
{ "workingDir": "/Users/jackou/archive" }
```

- [ ] **Step 5: Delete legacy per-workspace workers/ folders**

Run:

```bash
rm -rf workspaces/default/workers
```

For every other workspace, check:

```bash
ls workspaces/*/workers 2>/dev/null
```

If the command lists anything, delete each one individually:

```bash
rm -rf workspaces/<name>/workers
```

- [ ] **Step 6: Verify the guard now passes**

Run: `npm run build && node -e "require('./dist/startup-guard').assertNoLegacyLayout('./workspaces')"`
Expected: no output, exit code 0.

- [ ] **Step 7: Boot the gateway and confirm workers load**

Run: `npm start` (or `npm run dev`) in one terminal.
Expected log lines:
- `[Workers] Loaded 2 workers from ./workers`
- `[Workspace] Loaded workspace: default`
- No errors about unknown workers in the `review` team.

Stop the gateway with Ctrl-C.

- [ ] **Step 8: Commit**

```bash
git add workers/ workspaces/
git commit -m "chore(workers): migrate repo to global workers/ library

Seeds the new workers/ library with architect and executor, removes
per-workspace workers/ folders, strips the legacy workers field from
every workspace.json, and declares a review team on the default
workspace.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 6: Verification script

**Files:**
- Create: `scripts/verify-workers.ts`
- Modify: `package.json` (add `verify-workers` script)

- [ ] **Step 1: Create `scripts/verify-workers.ts`**

```ts
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';

const repoRoot = path.resolve(__dirname, '..');
process.chdir(repoRoot);

function section(name: string) {
  console.log(`\n=== ${name} ===`);
}

function expect(condition: boolean, label: string) {
  console.log(`${condition ? '✓' : '✗'} ${label}`);
  if (!condition) process.exitCode = 1;
}

async function run() {
  section('1. Global library loads');
  const { WorkerManager } = await import(path.join(repoRoot, 'dist/workers.js'));
  const wm = new WorkerManager('./workers');
  await wm.loadWorkers();
  expect(wm.hasWorker('architect'), 'architect exists');
  expect(wm.hasWorker('executor'), 'executor exists');
  expect(wm.getWorker('ARCHITECT')?.config.codingAgent === 'claude-code', 'architect agent is claude-code');

  section('2. Unknown worker lookup returns undefined');
  expect(wm.getWorker('nosuch') === undefined, 'nosuch returns undefined');

  section('3. Missing config.json is skipped');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-workers-'));
  fs.mkdirSync(path.join(tmpDir, 'broken'));
  fs.writeFileSync(path.join(tmpDir, 'broken/personality.md'), '# Worker: broken\n');
  fs.mkdirSync(path.join(tmpDir, 'ok'));
  fs.writeFileSync(path.join(tmpDir, 'ok/personality.md'), '# Worker: ok\n');
  fs.writeFileSync(path.join(tmpDir, 'ok/config.json'), JSON.stringify({ codingAgent: 'claude-code', model: 'm', tools: [] }));
  const wm2 = new WorkerManager(tmpDir);
  await wm2.loadWorkers();
  expect(!wm2.hasWorker('broken'), 'broken worker skipped (no config.json)');
  expect(wm2.hasWorker('ok'), 'ok worker loaded');
  fs.rmSync(tmpDir, { recursive: true, force: true });

  section('4. Startup guard fires on legacy workers/ folder');
  const { assertNoLegacyLayout } = await import(path.join(repoRoot, 'dist/startup-guard.js'));
  const fakeWs = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-legacy-'));
  fs.mkdirSync(path.join(fakeWs, 'bad/workers'), { recursive: true });
  fs.writeFileSync(path.join(fakeWs, 'bad/workspace.json'), JSON.stringify({ workingDir: './' }));
  try {
    execSync(
      `node -e "require('${path.join(repoRoot, 'dist/startup-guard.js')}').assertNoLegacyLayout('${fakeWs}')"`,
      { stdio: 'pipe' }
    );
    expect(false, 'guard should exit non-zero for legacy workers/ folder');
  } catch (err: any) {
    const out = (err.stderr || err.stdout || '').toString();
    expect(out.includes('Legacy worker layout detected'), 'guard message printed');
  }
  fs.rmSync(fakeWs, { recursive: true, force: true });

  section('5. Startup guard fires on legacy workers field');
  const fakeWs2 = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-legacy2-'));
  fs.mkdirSync(path.join(fakeWs2, 'bad'), { recursive: true });
  fs.writeFileSync(path.join(fakeWs2, 'bad/workspace.json'), JSON.stringify({ workingDir: './', workers: {} }));
  try {
    execSync(
      `node -e "require('${path.join(repoRoot, 'dist/startup-guard.js')}').assertNoLegacyLayout('${fakeWs2}')"`,
      { stdio: 'pipe' }
    );
    expect(false, 'guard should exit non-zero for legacy workers field');
  } catch (err: any) {
    const out = (err.stderr || err.stdout || '').toString();
    expect(out.includes('Legacy worker layout detected'), 'guard message printed');
  }
  fs.rmSync(fakeWs2, { recursive: true, force: true });

  section('6. Current repo passes the guard');
  try {
    execSync(
      `node -e "require('${path.join(repoRoot, 'dist/startup-guard.js')}').assertNoLegacyLayout('./workspaces')"`,
      { stdio: 'pipe' }
    );
    expect(true, 'real ./workspaces passes the guard');
  } catch (err: any) {
    const out = (err.stderr || err.stdout || '').toString();
    expect(false, `real ./workspaces failed the guard:\n${out}`);
  }

  section('7. Default workspace teams validate');
  const { WorkspaceManager } = await import(path.join(repoRoot, 'dist/workspace.js'));
  const wsm = new WorkspaceManager(wm, './workspaces');
  await wsm.switchWorkspace('default');
  const review = wsm.getTeam('review');
  expect(Array.isArray(review) && review!.length === 2, 'default workspace has review team with 2 members');
  expect(wsm.getTeam('nosuch') === undefined, 'nonexistent team returns undefined');
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Add the npm script**

Edit `package.json`. Find the `"scripts"` block and add a new entry:

```json
    "verify-workers": "npm run build && ts-node scripts/verify-workers.ts",
```

- [ ] **Step 3: Run the verification**

Run: `npm run verify-workers`
Expected: every line in every section begins with `✓`. Exit code 0. Sample output (abbreviated):

```
=== 1. Global library loads ===
✓ architect exists
✓ executor exists
✓ architect agent is claude-code
...
=== 7. Default workspace teams validate ===
✓ default workspace has review team with 2 members
✓ nonexistent team returns undefined
```

If any line begins with `✗`, fix the underlying issue before moving on.

- [ ] **Step 4: Exercise the commands manually via the gateway**

Start the gateway: `npm start`

In a second terminal, hit the HTTP API (substitute the configured port if not 3000):

```bash
curl -s -X POST http://localhost:3000/message -H 'content-type: application/json' -d '{"prompt":"/workers"}' | jq .
```

Expected: the reply body contains `architect` and `executor` as bullet lines.

```bash
curl -s -X POST http://localhost:3000/message -H 'content-type: application/json' -d '{"prompt":"/teams"}' | jq .
```

Expected: the reply lists the `review` team with `architect → executor`.

```bash
curl -s -X POST http://localhost:3000/message -H 'content-type: application/json' -d '{"prompt":"/team nosuch do something"}' | jq .
```

Expected: reply says `Team "nosuch" not found on workspace "default"`.

```bash
curl -s -X POST http://localhost:3000/message -H 'content-type: application/json' -d '{"prompt":"/worker nosuch hi"}' | jq .
```

Expected: reply says `Worker "nosuch" not found` and lists available workers.

Stop the gateway.

- [ ] **Step 5: Commit**

```bash
git add scripts/verify-workers.ts package.json
git commit -m "test(workers): add verify-workers script

Covers the six manual test cases from the spec: loader, unknown
worker lookup, missing config.json, legacy layout guard (two
shapes), current repo passing the guard, and team validation.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Self-review checklist (tick before handoff)

- [ ] Every spec requirement has a task:
  - Global `workers/` library → Task 1
  - `workspace.json` schema change → Tasks 3 + 5
  - No overrides → enforced by absence of override fields in Task 1 types
  - Breaking-change guard → Task 2
  - `/workers` / `/worker` / `/team` / `/teams` behavior → Task 4
  - Six test cases → Task 6
- [ ] No `TBD`, `TODO`, or "similar to Task N" references.
- [ ] Types are consistent: `Worker`, `WorkerPersonality`, `WorkerConfig` defined in Task 1 and used in the same shape by Tasks 3, 4, 6.
- [ ] `WorkerManager.hasWorker(name)` used in Task 3 is defined in Task 1.
- [ ] `WorkspaceManager.getTeam`, `getTeamNames`, `listTeams` used in Task 4 are defined in Task 3.
- [ ] All commit messages follow the repo's recent style (lowercase type prefix, short body).
