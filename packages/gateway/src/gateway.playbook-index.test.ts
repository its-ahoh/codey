import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { SkillStore } from '@codey/core';
import { Codey } from './gateway';

describe('playbook use bookkeeping', () => {
  function setup() {
    const store = new SkillStore(fs.mkdtempSync(path.join(os.tmpdir(), 'playbook-pass-')));
    const playbook = store.add({ name: 'notes', description: 'draft release notes', whenToUse: 'prepare release notes', steps: 'List the changes.' });
    const notices: string[] = [];
    const gateway = Object.assign(Object.create(Codey.prototype), {
      configManager: { getSkillsConfig: () => ({ enabled: true, suggestOnRepeat: 2, autoApply: true, staleDays: 30, weakSkillDays: 7, induction: true }) },
      logger: { info() {}, warn() {}, debug() {} },
    });
    // A failed run stops right after bookkeeping, before trace/distill/evolve.
    const pass = (read: boolean) => gateway.afterRunSkillPass({
      trace: { runId: 'r', promptSummary: 'draft notes', outputPreview: '', timestamp: Date.now(), mode: 'solo' },
      appliedSkill: null, readPlaybooks: read ? [playbook] : [],
      clean: false, store, notify: (text: string) => { notices.push(text); }, setPending: () => {},
    });
    return { store, notices, pass };
  }

  it('counts a playbook the agent opened as a real use', async () => {
    const { store, pass } = setup();
    await pass(true);
    expect(store.get('notes')).toMatchObject({ useCount: 1, successSignals: { cleanRuns: 0, corrections: 1 } });
  });

  it('records nothing for a playbook that was only listed', async () => {
    const { store, pass } = setup();
    await pass(false);
    expect(store.get('notes')?.useCount).toBe(0);
  });

  it('reminds once to promote a playbook after repeated use', async () => {
    const { notices, pass } = setup();
    for (let i = 0; i < 4; i++) await pass(true);
    expect(notices).toHaveLength(0);
    await pass(true);
    await pass(true);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('Promote it to a Skill');
  });
});
