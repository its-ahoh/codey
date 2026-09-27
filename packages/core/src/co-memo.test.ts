import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CoMemoClient } from './co-memo';
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-co-memo-'));
  roots.push(root);
  const personalRoot = path.join(root, 'personal');
  const a = path.join(root, 'project-a'); const b = path.join(root, 'project-b');
  for (const dir of [personalRoot, a, b]) fs.mkdirSync(dir);
  return { client: new CoMemoClient({ home: path.join(root, 'store'), personalRoot }), a, b };
}
describe('Co-memo 0.7 public MCP integration', () => {
  it('shares user notes, isolates projects, and rejects stale writes without reviving archives', async () => {
    const { client, a, b } = fixture();
    const user = await client.remember('Prefer concise review answers', 'user');
    const project = await client.remember('Project A uses review checks', 'project', a);
    expect((await client.list('user', b)).map(n => n.id)).toEqual([user.id]);
    expect(await client.list('project', b)).toEqual([]);
    expect((await client.context('review', a)).context).toContain(project.content);
    expect((await client.context('review')).context).not.toContain(project.content);
    const updated = await client.change(project.id, project.version, 'project', a, 'Project A uses strict review checks');
    await expect(client.change(project.id, project.version, 'project', a, 'Stale replacement')).rejects.toThrow();
    await expect(client.change(project.id, updated.version, 'project', b, 'Other project')).rejects.toThrow();
    await expect(client.change(user.id, user.version, 'project', a, 'Wrong scope')).rejects.toThrow(/scope/i);
    await client.change(project.id, updated.version, 'project', a);
    expect(await client.list('project', a)).toEqual([]);
    await expect(client.remember(updated.content, 'project', a)).rejects.toThrow(/archived/);
    await expect(client.remember('Project without workspace', 'project')).rejects.toThrow(/workspace/);
  }, 30000);
  it('honors explicit-only and paused policies and pins CLI instructions to the same store', async () => {
    const { client, a } = fixture();
    await client.setSaveMode('explicit');
    await expect(client.call('memory_remember', { content: 'Automatic fact', scope: 'project', intent: 'automatic' }, a)).rejects.toThrow();
    await client.remember('Explicit project fact', 'project', a);
    expect((await client.context('fact', a)).settings.saveMode).toBe('explicit');
    await client.call('memory_settings_set', { scope: 'project', patch: { paused: true }, userRequested: true }, a);
    expect((await client.context('fact', a)).settings.paused).toBe(true);
    await expect(client.remember('Another fact', 'project', a)).rejects.toThrow(/paused/i);
    expect(client.instructions(a, false)).toContain('Automatic capture is disabled');
    expect(client.instructions(a, false)).toContain('--home');
    expect(client.instructions(undefined, true)).toContain('No project is bound');
  }, 30000);
});

it('restores archives with version checks and exposes revision history in the selected scope', async () => {
  const { client, a, b } = fixture();
  const note = await client.remember('Original project fact', 'project', a);
  const edited = await client.change(note.id, note.version, 'project', a, 'Corrected project fact');
  const archived = await client.change(note.id, edited.version, 'project', a);
  await expect(client.restore(note.id, edited.version, 'project', a)).rejects.toThrow(/changed/);
  await expect(client.details(note.id, 'project', b)).rejects.toThrow();
  await expect(client.restore(note.id, archived.version, 'user', a)).rejects.toThrow(/scope/);
  const restored = await client.restore(note.id, archived.version, 'project', a);
  expect(restored.deleted).toBe(false);
  const details = await client.details(note.id, 'project', a);
  expect(details.history.map(n => n.content)).toContain('Original project fact');
  expect(details.history.some(n => n.deleted)).toBe(true);
}, 30000);

it.each(['current', 'candidate', 'merge'])('resolves %s only after scoped, unchanged conflict review', async (selection) => {
  const { client, a, b } = fixture();
  const note = await client.remember('Current fact', 'project', a);
  const { randomUUID } = await import('node:crypto');
  const propose = () => client.call('memory_submit', {
    requestId: randomUUID(), intent: 'explicit', candidates: [{
      action: 'conflict', id: note.id, version: note.version, content: 'Alternative fact', kind: 'note',
      source: { agent: 'codey-test', sessionId: 'conflict-test', messageId: 'proposal', excerpt: 'Alternative fact' },
    }],
  }, a);
  await propose();
  const [conflict] = await client.conflicts('project', a);
  expect(conflict.currentContent).toBe('Current fact');
  expect(conflict.candidates[0].content).toBe('Alternative fact');
  expect(await client.list('project', a)).toEqual([]);
  expect(await client.conflicts('user', a)).toEqual([]);
  expect(await client.conflicts('project', b)).toEqual([]);
  await expect(client.resolve(conflict.id, 'stale', { take: 'current' }, 'project', a)).rejects.toThrow(/changed/);
  await expect(client.resolve(conflict.id, conflict.revision, { take: 'current' }, 'user', a)).rejects.toThrow(/changed/);
  const choice = selection === 'merge' ? { content: 'Merged fact' } : { take: selection === 'current' ? 'current' : conflict.candidates[0].id };
  const resolved = await client.resolve(conflict.id, conflict.revision, choice, 'project', a);
  expect(resolved.content).toBe(selection === 'merge' ? 'Merged fact' : selection === 'current' ? 'Current fact' : 'Alternative fact');
  expect(await client.conflicts('project', a)).toEqual([]);
  await expect(client.resolve(conflict.id, conflict.revision, { content: 'Obsolete merge' }, 'project', a)).rejects.toThrow(/changed/);
}, 30000);

it('permanently deletes only an explicitly selected archived version in the right scope', async () => {
  const { client, a, b } = fixture();
  const note = await client.remember('Temporary note', 'project', a);
  await expect(client.purge(note.id, note.version, 'project', a)).rejects.toThrow(/Archive/);
  const archived = await client.change(note.id, note.version, 'project', a);
  await expect(client.purge(note.id, archived.version, 'project', b)).rejects.toThrow();
  await expect(client.purge(note.id, note.version, 'project', a)).rejects.toThrow(/refresh/);
  await client.purge(note.id, archived.version, 'project', a);
  await expect(client.details(note.id, 'project', a)).rejects.toThrow();
}, 30000);

it('pauses and resumes memory through native settings without weakening user restrictions', async () => {
  const { client, a } = fixture();
  await client.setPaused('project', true, a);
  expect((await client.settings(a)).effective.paused).toBe(true);
  await client.setPaused('user', true);
  await client.setPaused('project', false, a);
  expect((await client.settings(a)).effective.paused).toBe(true);
  await client.setPaused('user', false);
  expect((await client.settings(a)).effective.paused).toBe(false);
}, 30000);
