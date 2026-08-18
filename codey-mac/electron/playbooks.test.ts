import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SkillStore } from '@codey/core';
import {
  listPlaybooks, playbookHistory,
  archivePlaybook, deletePlaybook, restorePlaybook, rollbackPlaybook, promotePlaybook,
} from './playbooks';

describe('playbooks IPC module', () => {
  let tmp: string;
  let store: SkillStore;

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-playbooks-test-'));
    store = new SkillStore(tmp);
    await store.load();
    store.add({ name: 'rel', description: 'Release notes', whenToUse: 'w', steps: 's1' });
    store.bumpVersion('rel', 's2', { runId: 'r1', promptSummary: 'draft notes' });
  });

  afterEach(async () => {
    await store.flush();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  /** The single-workspace view most assertions here care about. */
  const listed = () => listPlaybooks([{ workspace: 'alpha', store }]);

  it('lists summaries with canRollback derived from the rollback stack', () => {
    const list = listed();
    expect(list.length).toBe(1);
    expect(list[0]).toMatchObject({
      workspace: 'alpha', name: 'rel', version: 2, archived: false, canRollback: true,
    });
    store.rollback('rel');
    expect(listed()[0]).toMatchObject({ version: 1, canRollback: false });
  });

  it('aggregates across workspaces, tagging each entry with its own', async () => {
    const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-playbooks-test-b-'));
    const other = new SkillStore(otherDir);
    await other.load();
    // Same NAME as the alpha playbook: names are unique only within a workspace,
    // so both must survive aggregation as distinct entries.
    other.add({ name: 'rel', description: 'Other release notes', whenToUse: 'w', steps: 's1' });
    other.add({ name: 'deploy', description: 'Deploy', whenToUse: 'w', steps: 's1' });

    const list = listPlaybooks([{ workspace: 'alpha', store }, { workspace: 'beta', store: other }]);
    expect(list.map(p => `${p.workspace}/${p.name}`)).toEqual(['alpha/rel', 'beta/rel', 'beta/deploy']);
    expect(list[0].description).toBe('Release notes');
    expect(list[1].description).toBe('Other release notes');

    await other.flush();
    fs.rmSync(otherDir, { recursive: true, force: true });
  });

  it('lists nothing when no workspace has playbooks', () => {
    expect(listPlaybooks([])).toEqual([]);
  });

  it('returns the evolution trail for a skill', () => {
    const ev = playbookHistory(store, 'rel');
    expect(ev.length).toBe(2);
    expect(ev[0].kind).toBe('created');
    expect(ev[1]).toMatchObject({ kind: 'evolved', toVersion: 2 });
  });

  it('history throws for unknown skill', () => {
    expect(() => playbookHistory(store, 'nope')).toThrow(/not found/i);
  });

  it('archive archives, restore unarchives', () => {
    archivePlaybook(store, 'rel');
    expect(listed()[0].archived).toBe(true);
    restorePlaybook(store, 'rel');
    expect(listed()[0].archived).toBe(false);
  });

  it('archive/restore throw for unknown skill', () => {
    expect(() => archivePlaybook(store, 'nope')).toThrow(/not found/i);
    expect(() => restorePlaybook(store, 'nope')).toThrow(/not found/i);
  });

  it('delete permanently removes a playbook', () => {
    deletePlaybook(store, 'rel');
    expect(listed()).toEqual([]);
    expect(() => deletePlaybook(store, 'rel')).toThrow(/not found/i);
  });

  it('rollback restores the prior version and returns it', () => {
    expect(rollbackPlaybook(store, 'rel')).toBe(1);
    expect(listed()[0].version).toBe(1);
  });

  it('rollback throws when there is no prior version', () => {
    store.rollback('rel');
    expect(() => rollbackPlaybook(store, 'rel')).toThrow(/no prior version/i);
  });

  it('promotes a playbook to a durable SKILL.md and pins it', async () => {
    const root = path.join(tmp, '.agents', 'skills');
    const result = await promotePlaybook(store, 'rel', root);
    const md = fs.readFileSync(path.join(result.dir, 'SKILL.md'), 'utf-8');
    expect(md).toContain('name: "rel"');
    expect(md).toContain('description: "Release notes"');
    expect(md).toContain('## When to use\n\nw');
    expect(md).toContain('## Procedure\n\ns2');
    expect(listed()[0].promotedToSkill).toBe(true);
    expect(store.archive('rel')).toBe(false);
  });

  it('does not overwrite an existing skill during promotion', async () => {
    const root = path.join(tmp, '.agents', 'skills');
    fs.mkdirSync(path.join(root, 'rel'), { recursive: true });
    fs.writeFileSync(path.join(root, 'rel', 'SKILL.md'), 'existing');
    await expect(promotePlaybook(store, 'rel', root)).rejects.toThrow(/already exists/i);
    expect(fs.readFileSync(path.join(root, 'rel', 'SKILL.md'), 'utf-8')).toBe('existing');
    expect(listed()[0].promotedToSkill).toBe(false);
  });
});
