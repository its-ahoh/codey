import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { WorkerManager, renameWorkerInTeams } from './workers';

function seedWorkers(workersDir: string, names: string[]) {
  for (const n of names) {
    fs.mkdirSync(path.join(workersDir, n), { recursive: true });
    fs.writeFileSync(
      path.join(workersDir, n, 'personality.md'),
      `# ${n}\n## Role\nROLE_OF_${n}\n## Soul\n.\n## Instructions\n.\n`,
    );
    fs.writeFileSync(
      path.join(workersDir, n, 'config.json'),
      JSON.stringify({ codingAgent: 'claude-code', model: 'm', tools: [] }),
    );
  }
}

describe('WorkerManager.buildParallelWorkerPrompt', () => {
  it('builds a parallel-mode prompt with role, topic, file paths, ASK_ADVISOR, and control protocol', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workers-parallel-'));
    seedWorkers(root, ['alice', 'bob']);
    const wm = new WorkerManager(root);
    await wm.loadWorkers();

    const prompt = wm.buildParallelWorkerPrompt('alice', {
      topic: 'Pick a database',
      controlPath: '/tmp/c.md',
      summaryPath: '/tmp/s.md',
      ownOpinionPath: '/tmp/alice.md',
      peerOpinions: [{ name: 'bob', path: '/tmp/bob.md' }],
    });

    expect(prompt).toContain('ROLE_OF_alice');
    expect(prompt).toContain('Pick a database');
    expect(prompt).toContain('/tmp/alice.md');
    expect(prompt).toContain('/tmp/s.md');
    expect(prompt).toContain('/tmp/c.md');
    expect(prompt).toContain('/tmp/bob.md');
    expect(prompt).toContain('[ASK_ADVISOR]');
    expect(prompt.toLowerCase()).toContain('read control.md');
  });

  it('returns the topic unchanged for an unknown worker', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workers-parallel-'));
    seedWorkers(root, ['alice']);
    const wm = new WorkerManager(root);
    await wm.loadWorkers();

    const prompt = wm.buildParallelWorkerPrompt('nobody', {
      topic: 'just-the-topic',
      controlPath: 'c',
      summaryPath: 's',
      ownOpinionPath: 'o',
      peerOpinions: [],
    });
    expect(prompt).toBe('just-the-topic');
  });
});

describe('worker avatar persistence', () => {
  it('loads old members and round-trips independent shape and color choices', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-avatar-'));
    try {
      seedWorkers(root, ['alice']);
      const manager = new WorkerManager(root);
      await manager.loadWorkers();
      const worker = manager.getWorker('alice')!;
      expect(worker.config.avatar).toBeUndefined();
      await manager.saveWorker('alice', worker.personality, {
        ...worker.config, avatar: { shape: 'triangle', color: '#8CCDB5' },
      });
      const reloaded = new WorkerManager(root);
      await reloaded.loadWorkers();
      expect(reloaded.getWorker('alice')!.config.avatar).toEqual({ shape: 'triangle', color: '#8CCDB5' });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('WorkerManager.renameWorker', () => {
  it('moves the folder, rewrites the personality heading, and reloads under the new name', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-rename-'));
    try {
      seedWorkers(root, ['alice', 'bob']);
      const manager = new WorkerManager(root);
      await manager.loadWorkers();
      await manager.renameWorker('alice', 'alicia');

      expect(fs.existsSync(path.join(root, 'alice'))).toBe(false);
      expect(fs.readFileSync(path.join(root, 'alicia', 'personality.md'), 'utf-8')).toMatch(/^# Worker: alicia\n/);
      expect(manager.getWorker('alice')).toBeUndefined();
      expect(manager.getWorker('alicia')!.personality.role).toBe('ROLE_OF_alice');
      expect(manager.getWorker('bob')).toBeDefined();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects invalid, missing, and already-taken names without touching disk', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-rename-'));
    try {
      seedWorkers(root, ['alice', 'bob']);
      const manager = new WorkerManager(root);
      await manager.loadWorkers();
      await expect(manager.renameWorker('alice', 'Bad Name')).rejects.toThrow(/lowercase/);
      await expect(manager.renameWorker('ghost', 'x')).rejects.toThrow(/not found/i);
      await expect(manager.renameWorker('alice', 'bob')).rejects.toThrow(/already exists/i);
      expect(fs.existsSync(path.join(root, 'alice'))).toBe(true);
      expect(manager.getWorker('alice')).toBeDefined();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('is a no-op when the name does not change', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-rename-'));
    try {
      seedWorkers(root, ['alice']);
      const manager = new WorkerManager(root);
      await manager.loadWorkers();
      await manager.renameWorker('alice', 'alice');
      expect(manager.getWorker('alice')).toBeDefined();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('renameWorkerInTeams', () => {
  it('rewrites members and graph worker nodes in every team that references the worker', () => {
    const teams = {
      legacy: ['alice', 'bob'],
      flow: {
        members: ['alice'],
        dispatch: 'sequential' as const,
        graph: {
          entry: 'start', maxHops: 5,
          nodes: [
            { id: 'start', type: 'start' as const, x: 0, y: 0 },
            { id: 'n1', type: 'worker' as const, worker: 'alice', x: 0, y: 0 },
            { id: 'end', type: 'end' as const, x: 0, y: 0 },
          ],
          edges: [{ id: 'e1', from: 'start', to: 'n1' }, { id: 'e2', from: 'n1', to: 'end' }],
        },
      },
      untouched: ['bob'],
    };
    const { teams: next, changed } = renameWorkerInTeams(teams, 'alice', 'alicia');
    expect(changed).toBe(true);
    expect(next.legacy).toEqual(['alicia', 'bob']);
    expect((next.flow as any).members).toEqual(['alicia']);
    expect((next.flow as any).graph.nodes[1].worker).toBe('alicia');
    expect((next.flow as any).graph.edges).toEqual(teams.flow.graph.edges);
    expect(next.untouched).toBe(teams.untouched);
    expect(teams.legacy).toEqual(['alice', 'bob']);
  });

  it('reports no change when nothing references the worker', () => {
    const teams = { a: ['bob'] };
    const result = renameWorkerInTeams(teams, 'alice', 'alicia');
    expect(result.changed).toBe(false);
    expect(result.teams).toEqual(teams);
  });
});
