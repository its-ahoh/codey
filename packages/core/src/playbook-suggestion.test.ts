import { describe, expect, it } from 'vitest';
import { suggestPlaybook, applySkill, matchSkill } from './skill-crystallizer';
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
