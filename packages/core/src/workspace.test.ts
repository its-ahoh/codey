// Run: npx ts-node packages/core/src/workspace.test.ts
import * as assert from 'assert';
import { WorkspaceManager } from './workspace';
import { WorkerManager } from './workers';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

function seedWorkers(workersDir: string, names: string[]) {
  for (const n of names) {
    fs.mkdirSync(path.join(workersDir, n), { recursive: true });
    fs.writeFileSync(path.join(workersDir, n, 'personality.md'), `# ${n}\n## Role\n${n}\n## Soul\n.\n## Instructions\n.\n`);
    fs.writeFileSync(path.join(workersDir, n, 'config.json'), JSON.stringify({ codingAgent: 'claude-code', model: 'm', tools: [] }));
  }
}

async function testNormalizesParallelWithDefaults() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-parallel-'));
  const wsDir = path.join(root, 'workspaces');
  const workersDir = path.join(root, 'workers');
  fs.mkdirSync(path.join(wsDir, 'demo'), { recursive: true });
  seedWorkers(workersDir, ['a', 'b']);
  fs.writeFileSync(path.join(wsDir, 'demo', 'workspace.json'), JSON.stringify({ workingDir: root, teams: ['rt'] }));

  const workers = new WorkerManager(workersDir);
  await workers.loadWorkers();
  const ws = new WorkspaceManager(workers, wsDir, undefined, () => ({
    rt: { members: ['a', 'b'], dispatch: 'parallel' },
  }));
  await ws.switchWorkspace('demo');

  const team = ws.getTeam('rt');
  assert.ok(team, 'team should exist');
  assert.strictEqual(team!.dispatch, 'parallel', 'dispatch should be parallel');
  assert.deepStrictEqual(team!.parallel, {
    maxDurationMs: 600_000,
    idleTimeoutMs: 60_000,
    managerPollMs: 30_000,
  }, 'parallel should have default settings');

  console.log('✓ normalizes dispatch: "parallel" with default parallel settings');
}

async function testPreservesExplicitParallelSettings() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-parallel-'));
  const wsDir = path.join(root, 'workspaces');
  const workersDir = path.join(root, 'workers');
  fs.mkdirSync(path.join(wsDir, 'demo'), { recursive: true });
  seedWorkers(workersDir, ['a']);
  fs.writeFileSync(path.join(wsDir, 'demo', 'workspace.json'), JSON.stringify({ workingDir: root, teams: ['rt'] }));

  const workers = new WorkerManager(workersDir);
  await workers.loadWorkers();
  const ws = new WorkspaceManager(workers, wsDir, undefined, () => ({
    rt: { members: ['a'], dispatch: 'parallel', parallel: { maxDurationMs: 1000, idleTimeoutMs: 200, managerPollMs: 100 } },
  }));
  await ws.switchWorkspace('demo');

  assert.deepStrictEqual(ws.getTeam('rt')!.parallel, { maxDurationMs: 1000, idleTimeoutMs: 200, managerPollMs: 100 }, 'parallel should preserve explicit settings');

  console.log('✓ preserves explicit parallel settings');
}

async function run() {
  await testNormalizesParallelWithDefaults();
  await testPreservesExplicitParallelSettings();
}

run().catch((err) => { console.error(err); process.exit(1); });
