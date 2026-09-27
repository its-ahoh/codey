import { afterEach, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { readLegacyMemory } from './legacy-memory';
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
async function fixture() { const root = await fs.mkdtemp(path.join(os.tmpdir(), 'legacy-reader-')); roots.push(root); return root; }
async function index(root: string, entries: unknown[]) {
  await fs.mkdir(path.join(root, 'memory'));
  const text = JSON.stringify({ version: 1, entries });
  await fs.writeFile(path.join(root, 'memory/index.json'), text);
  return text;
}
it('does not create files or directories when no legacy data exists', async () => {
  const root = await fixture();
  expect(await readLegacyMemory(path.join(root, 'missing'))).toEqual({ contents: [], warnings: [] });
  expect(await fs.readdir(root)).toEqual([]);
});
it('reads only shared entries and preserves the exact index bytes', async () => {
  const root = await fixture();
  const original = await index(root, [{ content: 'Shared' }, { content: 'Project', scope: 'workspace' }, { content: 'Private', scope: { bot: 'reviewer' } }, { content: 'Old worker', scope: { worker: 'reviewer' } }, null]);
  const result = await readLegacyMemory(root);
  expect(result.contents).toEqual(['Shared', 'Project']);
  expect(result.warnings).toHaveLength(1);
  expect(await fs.readFile(path.join(root, 'memory/index.json'), 'utf8')).toBe(original);
  expect(await fs.readdir(root)).toEqual(['memory']);
  expect(await fs.readdir(path.join(root, 'memory'))).toEqual(['index.json']);
});
it('treats an empty index as authoritative instead of resurrecting rendered notes', async () => {
  const root = await fixture(); await index(root, []);
  await fs.writeFile(path.join(root, 'memory.md'), '# Old summary\nPrivate or removed facts');
  expect((await readLegacyMemory(root)).contents).toEqual([]);
});
it('reads legacy Markdown only without an index, and retains the older shared file', async () => {
  const root = await fixture();
  await fs.mkdir(path.join(root, 'memory'));
  await fs.writeFile(path.join(root, 'memory.md'), '# Project\nA project fact');
  await fs.writeFile(path.join(root, 'memory/MEMORY.md'), 'Personal preference');
  expect((await readLegacyMemory(root, true)).contents).toEqual(['# Project\nA project fact', 'Personal preference']);
  await fs.writeFile(path.join(root, 'memory.md'), '# Header only\n');
  expect((await readLegacyMemory(root)).contents).toEqual([]);
});
it('reports a corrupt index without rewriting it or falling back to a stale summary', async () => {
  const root = await fixture(); await index(root, []);
  await fs.writeFile(path.join(root, 'memory/index.json'), 'broken');
  await fs.writeFile(path.join(root, 'memory.md'), 'Stale facts');
  const result = await readLegacyMemory(root);
  expect(result.contents).toEqual([]); expect(result.warnings).toHaveLength(1);
  expect(await fs.readFile(path.join(root, 'memory/index.json'), 'utf8')).toBe('broken');
});
