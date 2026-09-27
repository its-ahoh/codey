import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CoMemoClient } from '@codey/core';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { inheritWorktreeMemory, MemoryInheritance } from './worktree-memory';
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codey-inheritance-')); roots.push(root);
  const dirs = ['main', 'a', 'b', 'personal'].map(name => path.join(root, name));
  await Promise.all(dirs.map(dir => fs.mkdir(dir)));
  return { root, main: dirs[0], a: dirs[1], b: dirs[2], client: new CoMemoClient({ home: path.join(root, 'store'), personalRoot: dirs[3] }) };
}
describe('independent worktree memory snapshots', () => {
  it('inherits active project notes once and keeps parent, A and B independent', async () => {
    const { root, client, main, a, b } = await fixture();
    execFileSync('git', ['init', '-q', main]);
    execFileSync('git', ['-C', main, '-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '--allow-empty', '-qm', 'initial']);
    execFileSync('git', ['-C', main, 'worktree', 'add', '-qb', 'a', a]);
    execFileSync('git', ['-C', main, 'worktree', 'add', '-qb', 'b', b]);
    const note = await client.remember('Use the project check command', 'project', main);
    const archived = await client.remember('Obsolete command', 'project', main);
    await client.change(archived.id, archived.version, 'project', main);
    await client.remember('User preference', 'user');
    const manifestA = path.join(root, 'snapshots', 'a.json');
    await inheritWorktreeMemory(client, main, a, manifestA);
    await inheritWorktreeMemory(client, main, b, path.join(root, 'snapshots', 'b.json'));
    const [copyA] = await client.list('project', a); const [copyB] = await client.list('project', b);
    expect(copyA.content).toBe(note.content); expect(copyB.content).toBe(note.content);
    expect(new Set([note.projectId, copyA.projectId, copyB.projectId]).size).toBe(3);
    expect(copyA.id).not.toBe(note.id);
    await client.change(copyA.id, copyA.version, 'project', a, 'A-specific command');
    await client.change(note.id, note.version, 'project', main, 'Updated main command');
    await inheritWorktreeMemory(client, main, a, manifestA);
    expect((await client.list('project', a)).map(n => n.content)).toEqual(['A-specific command']);
    expect((await client.list('project', b)).map(n => n.content)).toEqual([note.content]);
    const saved: MemoryInheritance = JSON.parse(await fs.readFile(manifestA, 'utf8'));
    expect(saved.complete).toBe(true);
    expect(saved.entries[0].source.id).toBe(note.id);
    expect(saved.entries[0].source.version).toBe(note.version);
    expect(saved.entries[0].localId).toBe(copyA.id);
  }, 30000);

  it('resumes a frozen snapshot after partial failure without overwriting copied notes', async () => {
    const { root, client, main, a } = await fixture();
    await client.remember('First fact', 'project', main);
    await client.remember('Second fact', 'project', main);
    const remember = client.remember.bind(client);
    let calls = 0;
    vi.spyOn(client, 'remember').mockImplementation(async (...args) => {
      if (++calls === 2) throw new Error('temporary failure');
      return remember(...args);
    });
    const file = path.join(root, 'snapshot.json');
    await expect(inheritWorktreeMemory(client, main, a, file)).rejects.toThrow('temporary failure');
    const [copied] = await client.list('project', a);
    await client.change(copied.id, copied.version, 'project', a, 'Locally corrected');
    await remember('Added after snapshot', 'project', main);
    await inheritWorktreeMemory(client, main, a, file);
    const contents = (await client.list('project', a)).map(n => n.content);
    expect(contents).toHaveLength(2);
    expect(contents).toContain('Locally corrected');
    expect(contents).not.toContain('Added after snapshot');
  }, 30000);

  it('does not bypass explicit-only policy when inheriting', async () => {
    const { root, client, main, a } = await fixture();
    await client.remember('A fact', 'project', main);
    await client.setSaveMode('explicit');
    await expect(inheritWorktreeMemory(client, main, a, path.join(root, 'snapshot.json'))).rejects.toThrow();
    expect(await client.list('project', a)).toEqual([]);
  }, 30000);
});
