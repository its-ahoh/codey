import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SkillStore } from '@codey/core';
import {
  listPlaybooks, playbookHistory,
  forgetPlaybook, restorePlaybook, rollbackPlaybook, promotePlaybook,
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

  it('lists summaries with canRollback derived from the rollback stack', () => {
    const list = listPlaybooks(store);
    expect(list.length).toBe(1);
    expect(list[0]).toMatchObject({
      name: 'rel', version: 2, archived: false, canRollback: true,
    });
    store.rollback('rel');
    expect(listPlaybooks(store)[0]).toMatchObject({ version: 1, canRollback: false });
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

  it('forget archives, restore unarchives', () => {
    forgetPlaybook(store, 'rel');
    expect(listPlaybooks(store)[0].archived).toBe(true);
    restorePlaybook(store, 'rel');
    expect(listPlaybooks(store)[0].archived).toBe(false);
  });

  it('forget/restore throw for unknown skill', () => {
    expect(() => forgetPlaybook(store, 'nope')).toThrow(/not found/i);
    expect(() => restorePlaybook(store, 'nope')).toThrow(/not found/i);
  });

  it('rollback restores the prior version and returns it', () => {
    expect(rollbackPlaybook(store, 'rel')).toBe(1);
    expect(listPlaybooks(store)[0].version).toBe(1);
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
    expect(listPlaybooks(store)[0].promotedToSkill).toBe(true);
    expect(store.archive('rel')).toBe(false);
  });

  it('does not overwrite an existing skill during promotion', async () => {
    const root = path.join(tmp, '.agents', 'skills');
    fs.mkdirSync(path.join(root, 'rel'), { recursive: true });
    fs.writeFileSync(path.join(root, 'rel', 'SKILL.md'), 'existing');
    await expect(promotePlaybook(store, 'rel', root)).rejects.toThrow(/already exists/i);
    expect(fs.readFileSync(path.join(root, 'rel', 'SKILL.md'), 'utf-8')).toBe('existing');
    expect(listPlaybooks(store)[0].promotedToSkill).toBe(false);
  });
});
