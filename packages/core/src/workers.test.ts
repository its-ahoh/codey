import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { WorkerManager } from './workers';

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
