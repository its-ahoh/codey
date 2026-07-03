import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SkillStore } from '@codey/core';
import {
  listLearnedSkills, learnedSkillHistory,
  forgetLearnedSkill, restoreLearnedSkill, rollbackLearnedSkill,
} from './learned-skills';

describe('learned-skills IPC module', () => {
  let tmp: string;
  let store: SkillStore;

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-learned-test-'));
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
    const list = listLearnedSkills(store);
    expect(list.length).toBe(1);
    expect(list[0]).toMatchObject({
      name: 'rel', version: 2, archived: false, canRollback: true,
    });
    store.rollback('rel');
    expect(listLearnedSkills(store)[0]).toMatchObject({ version: 1, canRollback: false });
  });

  it('returns the evolution trail for a skill', () => {
    const ev = learnedSkillHistory(store, 'rel');
    expect(ev.length).toBe(2);
    expect(ev[0].kind).toBe('created');
    expect(ev[1]).toMatchObject({ kind: 'evolved', toVersion: 2 });
  });

  it('history throws for unknown skill', () => {
    expect(() => learnedSkillHistory(store, 'nope')).toThrow(/not found/i);
  });

  it('forget archives, restore unarchives', () => {
    forgetLearnedSkill(store, 'rel');
    expect(listLearnedSkills(store)[0].archived).toBe(true);
    restoreLearnedSkill(store, 'rel');
    expect(listLearnedSkills(store)[0].archived).toBe(false);
  });

  it('forget/restore throw for unknown skill', () => {
    expect(() => forgetLearnedSkill(store, 'nope')).toThrow(/not found/i);
    expect(() => restoreLearnedSkill(store, 'nope')).toThrow(/not found/i);
  });

  it('rollback restores the prior version and returns it', () => {
    expect(rollbackLearnedSkill(store, 'rel')).toBe(1);
    expect(listLearnedSkills(store)[0].version).toBe(1);
  });

  it('rollback throws when there is no prior version', () => {
    store.rollback('rel');
    expect(() => rollbackLearnedSkill(store, 'rel')).toThrow(/no prior version/i);
  });
});
