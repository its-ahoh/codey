import { describe, expect, it } from 'vitest';
import { suggestSkill, applySkill } from './skill-crystallizer';
import type { SkillEntry } from './skill-crystallizer';

describe('optional skill candidate', () => {
  it('allows ignoring a candidate while preserving explicit invocation', () => {
    const skill = { name: 'notes', version: 1, description: 'Release notes', whenToUse: 'Prepare a release', steps: 'List the changes.' } as SkillEntry;
    const candidate = suggestSkill('Explain the format', skill);
    expect(candidate).toContain('otherwise ignore it');
    expect(candidate).toContain('Explain the format');
    expect(candidate).toContain('List the changes.');
    expect(candidate).not.toContain('Follow this procedure:');
    expect(applySkill('Prepare notes', skill)).toContain('Follow this procedure:');
  });
});
