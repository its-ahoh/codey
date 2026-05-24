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
  it('builds a parallel-mode prompt with role, topic, file paths, ASK_MANAGER, and control protocol', async () => {
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
    expect(prompt).toContain('[ASK_MANAGER]');
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
