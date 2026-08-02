import { describe, expect, it } from 'vitest';
import { buildTeamFastPathPrompt, parseTeamFastPathDecision } from './team-fast-path';

const members = [
  { name: 'product-manager', hint: 'product questions' },
  { name: 'developer', hint: 'implementation questions' },
];

describe('team fast path', () => {
  it('builds a conservative routing prompt with the exact roster', () => {
    const prompt = buildTeamFastPathPrompt('What does this setting mean?', members);
    expect(prompt).toContain('simple, self-contained question');
    expect(prompt).toContain('- developer: implementation questions');
  });

  it('accepts a known single worker', () => {
    expect(parseTeamFastPathDecision('{"route":"single_worker","worker":"developer","reason":"Simple explanation"}', members))
      .toEqual({ route: 'single_worker', worker: 'developer', reason: 'Simple explanation' });
  });

  it('fails closed to the full flow for invalid JSON or an unknown worker', () => {
    expect(parseTeamFastPathDecision('not json', members).route).toBe('full_flow');
    expect(parseTeamFastPathDecision('{"route":"single_worker","worker":"ghost"}', members).route).toBe('full_flow');
  });

  it('preserves an explicit full-flow decision', () => {
    expect(parseTeamFastPathDecision('{"route":"full_flow","reason":"Needs implementation and review"}', members))
      .toEqual({ route: 'full_flow', reason: 'Needs implementation and review' });
  });
});
