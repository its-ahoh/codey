import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SkillStore } from '@codey/core';
import {
  listPlaybooks, playbookHistory,
  forgetPlaybook, restorePlaybook, rollbackPlaybook,
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
});
