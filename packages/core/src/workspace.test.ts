import { describe, it, expect } from 'vitest';
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
      managerPollMs: 30_000,
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
        parallel: { maxDurationMs: 1000, idleTimeoutMs: 200, managerPollMs: 100 },
      },
    }));
    await ws.switchWorkspace('demo');

    expect(ws.getTeam('rt')!.parallel).toEqual({
      maxDurationMs: 1000,
      idleTimeoutMs: 200,
      managerPollMs: 100,
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
