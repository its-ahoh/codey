import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { MemoryStore } from './memory';

describe('user and project memory', () => {
  it('archives legacy Bot scopes without recalling, exporting, or deleting their data', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-memory-'));
    const store = new MemoryStore(root);
    try {
      await store.load();
      store.add({ type: 'preference', label: 'Review', content: 'Shared review preference' });
      store.add({ type: 'fact', label: 'Review', content: 'Private review detail', scope: { bot: 'alice' } });
      store.add({ type: 'fact', label: 'Review', content: 'Team review detail', scope: { bots: ['alice', 'bob'] } });
      for (const bot of [undefined, 'alice', 'bob']) {
        expect(store.search('review', 10, bot).map(m => m.content)).toEqual(['Shared review preference']);
        expect(store.buildContext('review', 2000, 200, bot)).not.toMatch(/Private|Team/);
      }
      await store.flush();
      expect(fs.readFileSync(path.join(root, 'memory.md'), 'utf8')).not.toMatch(/Private|Team/);
      const reopened = new MemoryStore(root);
      await reopened.load();
      expect(reopened.getAll()).toHaveLength(3);
      expect(reopened.getRecent().map(m => m.content)).toEqual(['Shared review preference']);
      await reopened.flush();
    } finally {
      await store.flush();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
