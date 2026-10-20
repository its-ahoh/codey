import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { suggestPlaybook, applySkill, matchSkill, matchPlaybookSuggestion, SkillStore } from './skill-crystallizer';
import type { SkillEntry } from './skill-crystallizer';

describe('optional playbook suggestion', () => {
  it('allows ignoring a candidate while preserving explicit invocation', () => {
    const skill = { name: 'notes', version: 1, description: 'Release notes', whenToUse: 'Prepare a release', steps: 'List the changes.' } as SkillEntry;
    const candidate = suggestPlaybook('Explain the format', skill);
    expect(candidate).toContain('otherwise ignore it');
    expect(candidate).toContain('Explain the format');
    expect(candidate).toContain('List the changes.');
    expect(candidate).not.toContain('Follow this procedure:');
    expect(applySkill('Prepare notes', skill)).toContain('Follow this procedure:');
  });

  it('skips promoted playbooks the agent already discovers as SKILL.md', () => {
    const skill = { name: 'notes', version: 1, description: 'draft release notes', whenToUse: 'prepare release notes', steps: 'List the changes.', archived: false } as SkillEntry;
    const task = 'draft the release notes';
    expect(matchSkill(task, [skill])?.skill.name).toBe('notes');
    expect(matchSkill(task, [{ ...skill, promotedToSkill: true }])).toBeNull();
  });
});

describe('automatic playbook suggestion', () => {
  const skill = { name: 'notes', version: 1, description: 'draft release notes', whenToUse: 'prepare release notes', steps: 'List the changes.', archived: false } as SkillEntry;

  it('suggests only strong matches', () => {
    expect(matchPlaybookSuggestion('draft the release notes', [skill])?.name).toBe('notes');
    // One shared word is a borderline match: never suggested.
    expect(matchSkill('update the notes', [skill])?.confidence).toBe('borderline');
    expect(matchPlaybookSuggestion('update the notes', [skill])).toBeNull();
  });
});

describe('promotion reminder flag', () => {
  it('is set once and never for a promoted playbook', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'playbook-hint-'));
    const store = new SkillStore(dir);
    store.add({ name: 'notes', description: 'd', whenToUse: 'w', steps: 's' });
    store.add({ name: 'deploy', description: 'd', whenToUse: 'w', steps: 's' });
    store.promoteToSkill('deploy');
    expect(store.markPromotionHinted('notes')).toBe(true);
    expect(store.markPromotionHinted('notes')).toBe(false);
    expect(store.markPromotionHinted('deploy')).toBe(false);
    await store.flush();
    const reopened = new SkillStore(dir);
    await reopened.load();
    expect(reopened.get('notes')?.promotionHinted).toBe(true);
  });
});
