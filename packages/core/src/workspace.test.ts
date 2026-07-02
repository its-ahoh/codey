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
  let manager: WorkspaceManager;

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-skill-'));
    const wsDir = path.join(root, 'workspaces');
    fs.mkdirSync(path.join(wsDir, 'default'), { recursive: true });
    fs.writeFileSync(
      path.join(wsDir, 'default', 'workspace.json'),
      JSON.stringify({ workingDir: root }),
    );
    const workers = new WorkerManager(path.join(root, 'workers'));
    manager = new WorkspaceManager(workers, wsDir);
    await manager.load();
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('exposes a per-workspace SkillStore that survives getMemoryStore calls', () => {
    const store = manager.getSkillStore();
    expect(store).toBeDefined();
    // Calling getMemoryStore must not replace the skillStore reference
    void manager.getMemoryStore();
    expect(manager.getSkillStore()).toBe(store); // stable reference until switch
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
