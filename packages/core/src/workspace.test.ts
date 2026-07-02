import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { WorkspaceManager } from './workspace';
import { WorkerManager } from './workers';

function seedWorkers(workersDir: string, names: string[]) {
  for (const n of names) {
    fs.mkdirSync(path.join(workersDir, n), { recursive: true });
    fs.writeFileSync(
      path.join(workersDir, n, 'personality.md'),
      `# ${n}\n## Role\n${n}\n## Soul\n.\n## Instructions\n.\n`,
    );
    fs.writeFileSync(
      path.join(workersDir, n, 'config.json'),
      JSON.stringify({ codingAgent: 'claude-code', model: 'm', tools: [] }),
    );
  }
}

describe('WorkspaceManager parallel team config', () => {
  it('normalizes dispatch: "parallel" with default parallel settings', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-parallel-'));
    const wsDir = path.join(root, 'workspaces');
    const workersDir = path.join(root, 'workers');
    fs.mkdirSync(path.join(wsDir, 'demo'), { recursive: true });
    seedWorkers(workersDir, ['a', 'b']);
    fs.writeFileSync(
      path.join(wsDir, 'demo', 'workspace.json'),
      JSON.stringify({ workingDir: root, teams: ['rt'] }),
    );

    const workers = new WorkerManager(workersDir);
    await workers.loadWorkers();
    const ws = new WorkspaceManager(workers, wsDir, undefined, () => ({
      rt: { members: ['a', 'b'], dispatch: 'parallel' },
    }));
    await ws.switchWorkspace('demo');

    const team = ws.getTeam('rt');
    expect(team).toBeTruthy();
    expect(team!.dispatch).toBe('parallel');
    expect(team!.parallel).toEqual({
      maxDurationMs: 600_000,
      idleTimeoutMs: 60_000,
      advisorPollMs: 30_000,
    });
  });

  it('preserves explicit parallel settings', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-parallel-'));
    const wsDir = path.join(root, 'workspaces');
    const workersDir = path.join(root, 'workers');
    fs.mkdirSync(path.join(wsDir, 'demo'), { recursive: true });
    seedWorkers(workersDir, ['a']);
    fs.writeFileSync(
      path.join(wsDir, 'demo', 'workspace.json'),
      JSON.stringify({ workingDir: root, teams: ['rt'] }),
    );

    const workers = new WorkerManager(workersDir);
    await workers.loadWorkers();
    const ws = new WorkspaceManager(workers, wsDir, undefined, () => ({
      rt: {
        members: ['a'],
        dispatch: 'parallel',
        parallel: { maxDurationMs: 1000, idleTimeoutMs: 200, advisorPollMs: 100 },
      },
    }));
    await ws.switchWorkspace('demo');

    expect(ws.getTeam('rt')!.parallel).toEqual({
      maxDurationMs: 1000,
      idleTimeoutMs: 200,
      advisorPollMs: 100,
    });
  });

  it('falls back to "all" for unknown dispatch values', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-parallel-'));
    const wsDir = path.join(root, 'workspaces');
    const workersDir = path.join(root, 'workers');
    fs.mkdirSync(path.join(wsDir, 'demo'), { recursive: true });
    seedWorkers(workersDir, ['a']);
    fs.writeFileSync(
      path.join(wsDir, 'demo', 'workspace.json'),
      JSON.stringify({ workingDir: root, teams: ['rt'] }),
    );

    const workers = new WorkerManager(workersDir);
    await workers.loadWorkers();
    const ws = new WorkspaceManager(workers, wsDir, undefined, () => ({
      rt: { members: ['a'], dispatch: 'nope' as unknown as 'all' },
    }));
    await ws.switchWorkspace('demo');

    expect(ws.getTeam('rt')!.dispatch).toBe('all');
    expect(ws.getTeam('rt')!.parallel).toBeUndefined();
  });
});

// Access the private normalizeTeam via a tiny subclass for unit testing.
class TestWM extends WorkspaceManager {
  norm(name: string, raw: any) { return (this as any).normalizeTeam(name, raw); }
}

function makeWM(): TestWM {
  const workers = new WorkerManager('/tmp/nonexistent-workers');
  // Pretend "coder" exists.
  (workers as any).workers = new Map([['coder', { name: 'coder', personality: {}, config: {} }]]);
  return new TestWM(workers, '/tmp/ws');
}

const validGraph = {
  entry: 'start',
  maxHops: 5,
  nodes: [
    { id: 'start', type: 'start', x: 0, y: 0 },
    { id: 'n_coder', type: 'worker', worker: 'coder', x: 1, y: 0 },
    { id: 'end', type: 'end', x: 2, y: 0 },
  ],
  edges: [
    { id: 'e1', from: 'start', to: 'n_coder' },
    { id: 'e2', from: 'n_coder', to: 'end', isDefault: true },
  ],
};

describe('WorkspaceManager SkillStore', () => {
  let root: string;
  let wsDir: string;
  let manager: WorkspaceManager;

  const seededSkill = {
    name: 'weekly-digest',
    description: 'Generate weekly summary',
    whenToUse: 'user asks for weekly report',
    steps: '1. gather\n2. format',
    version: 1,
    history: [],
    useCount: 0,
    lastUsedAt: Date.now(),
    successSignals: { cleanRuns: 0, corrections: 0 },
    sourceRunIds: [],
    createdAt: Date.now(),
    archived: false,
  };

  function seedWorkspace(name: string, withSkill: boolean) {
    const dir = path.join(wsDir, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'workspace.json'), JSON.stringify({ workingDir: root }));
    if (withSkill) {
      const skillsDir = path.join(dir, 'skills');
      fs.mkdirSync(skillsDir, { recursive: true });
      fs.writeFileSync(
        path.join(skillsDir, 'index.json'),
        JSON.stringify({ version: 1, entries: [seededSkill], rejected: [] }),
      );
    }
  }

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-skill-'));
    wsDir = path.join(root, 'workspaces');
    seedWorkspace('proj', true);
    seedWorkspace('other', false);
    const workers = new WorkerManager(path.join(root, 'workers'));
    manager = new WorkspaceManager(workers, wsDir);
    await manager.switchWorkspace('proj');
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('hydrates skills from disk on workspace load', () => {
    const active = manager.getSkillStore().getActive();
    expect(active.length).toBe(1);
    expect(active[0].name).toBe('weekly-digest');
  });

  it('keeps hydrated skills after renaming the active workspace', async () => {
    await manager.renameWorkspace('proj', 'proj-renamed');
    expect(manager.getCurrentWorkspace()).toBe('proj-renamed');
    const active = manager.getSkillStore().getActive();
    expect(active.length).toBe(1);
    expect(active[0].name).toBe('weekly-digest');
    // Regression: with an unloaded post-rename store, the first flush would
    // clobber the renamed workspace's skills/index.json with an empty index.
    await manager.getSkillStore().flush();
    const raw = JSON.parse(fs.readFileSync(
      path.join(wsDir, 'proj-renamed', 'skills', 'index.json'), 'utf-8'));
    expect(raw.entries.length).toBe(1);
  });

  it('returns a different SkillStore after switching workspaces', async () => {
    const before = manager.getSkillStore();
    await manager.switchWorkspace('other');
    const after = manager.getSkillStore();
    expect(after).not.toBe(before);
    expect(after.getActive()).toEqual([]);
  });
});

describe('normalizeTeam graph', () => {
  it('keeps a valid graph on a sequential team', () => {
    const t = makeWM().norm('t', { members: ['coder'], dispatch: 'all', graph: validGraph });
    expect(t.graph).toBeDefined();
    expect(t.graph.entry).toBe('start');
  });

  it('drops an invalid graph and stays linear sequential', () => {
    const bad = { ...validGraph, entry: 'ghost' };
    const t = makeWM().norm('t', { members: ['coder'], dispatch: 'all', graph: bad });
    expect(t.graph).toBeUndefined();
    expect(t.dispatch).toBe('all');
  });

  it('ignores a graph on non-sequential dispatch', () => {
    const t = makeWM().norm('t', { members: ['coder'], dispatch: 'auto', graph: validGraph });
    expect(t.graph).toBeUndefined();
  });
});
