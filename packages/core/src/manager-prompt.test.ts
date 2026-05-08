import { describe, it, expect } from 'vitest';
import { buildManagerPrompt } from './manager';

describe('buildManagerPrompt userClarification', () => {
  it('omits the section when not provided', () => {
    const out = buildManagerPrompt({
      task: 'do thing',
      members: [{ name: 'a', hint: 'hint' }],
      history: [],
      lastWorker: null,
      lastOutput: null,
    });
    expect(out).not.toContain('## User Clarification');
  });

  it('renders the section when provided', () => {
    const out = buildManagerPrompt({
      task: 'do thing',
      members: [{ name: 'a', hint: 'hint' }],
      history: [],
      lastWorker: 'a',
      lastOutput: '[ASK_USER]: which db?',
      userClarification: { worker: 'a', question: 'which db?', answer: 'postgres' },
    });
    expect(out).toContain('## User Clarification');
    expect(out).toContain('Worker a asked: which db?');
    expect(out).toContain('User answered: postgres');
  });
});
