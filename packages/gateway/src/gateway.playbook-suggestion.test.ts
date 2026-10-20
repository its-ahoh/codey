import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { SkillStore } from '@codey/core';
import { Codey } from './gateway';

describe('suggested playbook bookkeeping', () => {
  function setup() {
    const store = new SkillStore(fs.mkdtempSync(path.join(os.tmpdir(), 'playbook-pass-')));
    const playbook = store.add({ name: 'notes', description: 'draft release notes', whenToUse: 'prepare release notes', steps: 'List the changes.' });
    const notices: string[] = [];
    const gateway = Object.assign(Object.create(Codey.prototype), {
      configManager: { getSkillsConfig: () => ({ enabled: true, suggestOnRepeat: 2, autoApply: true, staleDays: 30, weakSkillDays: 7, induction: true }) },
      logger: { info() {}, warn() {}, debug() {} },
    });
    const pass = () => gateway.afterRunSkillPass({
      trace: { runId: 'r', promptSummary: 'draft notes', outputPreview: '', timestamp: Date.now(), mode: 'solo' },
      appliedSkill: null, suggestedPlaybook: playbook,
      // A failed run stops right after bookkeeping, before trace/distill.
      clean: false, store, notify: (text: string) => { notices.push(text); }, setPending: () => {},
    });
    return { store, notices, pass };
  }

  it('counts a suggestion as a use without a success signal', async () => {
    const { store, pass } = setup();
    await pass();
    const entry = store.get('notes')!;
    expect(entry.useCount).toBe(1);
    expect(entry.successSignals).toEqual({ cleanRuns: 0, corrections: 0 });
  });

  it('reminds once to promote a playbook after repeated use', async () => {
    const { notices, pass } = setup();
    for (let i = 0; i < 4; i++) await pass();
    expect(notices).toHaveLength(0);
    await pass();
    await pass();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('Promote it to a Skill');
  });
});
