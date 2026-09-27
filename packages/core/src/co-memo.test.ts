import { afterEach, describe, expect, it, vi } from 'vitest';
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

describe('Co-memo management', () => {
  it('skips archived and existing imports, continuing after a failed note', async () => {
    const { client, a } = fixture();
    const archived = await client.remember('Archived project fact', 'project', a);
    await client.change(archived.id, archived.version, 'project', a);
    await client.remember('Existing fact', 'project', a);
    const remember = client.remember.bind(client);
    vi.spyOn(client, 'remember').mockImplementation((text, scope, project) => {
      if (text === 'Rejected fact') return Promise.reject(new Error('write rejected'));
      return remember(text, scope, project);
    });
    const result = await client.importLegacy(['Archived project fact', 'Existing fact', 'Rejected fact', 'New fact'], 'project', a);
    expect(result).toEqual({ imported: 1, skipped: 2, errors: ['Entry 3: write rejected'] });
    expect((await client.list('project', a)).map(n => n.content)).toContain('New fact');
    expect((await client.list('project', a, undefined, true)).find(n => n.id === archived.id)?.deleted).toBe(true);
  }, 30000);

  it('opens and reuses a scoped console against the same store', async () => {
    const { client, a } = fixture();
    try {
      const url = await client.openConsole(a);
      expect(await client.openConsole(a)).toBe(url);
      expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect((await fetch(url)).ok).toBe(true);
    } finally { client.closeConsoles(); }
  }, 30000);
});
