import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SkillStore } from '@codey/core';
import {
  listPlaybooks, playbookDetail, playbookHistory,
  archivePlaybook, deletePlaybook, restorePlaybook, rollbackPlaybook,
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

  const listed = () => listPlaybooks(store);

  it('lists summaries with canRollback derived from the rollback stack', () => {
    const list = listed();
    expect(list.length).toBe(1);
    expect(list[0]).toMatchObject({
      name: 'rel', version: 2, archived: false, canRollback: true,
    });
    store.rollback('rel');
    expect(listed()[0]).toMatchObject({ version: 1, canRollback: false });
  });

  it('returns the evolution trail for a skill', () => {
    const ev = playbookHistory(store, 'rel');
    expect(ev.length).toBe(2);
    expect(ev[0].kind).toBe('created');
    expect(ev[1]).toMatchObject({ kind: 'evolved', toVersion: 2 });
  });

  it('returns the complete current playbook version', () => {
    expect(playbookDetail(store, 'rel')).toEqual({
      name: 'rel',
      description: 'Release notes',
      whenToUse: 'w',
      steps: 's2',
      version: 2,
    });
  });

  it('detail throws for an unknown skill', () => {
    expect(() => playbookDetail(store, 'nope')).toThrow(/not found/i);
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

});
