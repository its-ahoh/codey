import { describe, it, expect } from 'vitest';
import type { Chat } from '@codey/core';
import { summarizePriorHistory } from './summary';

const chat = (over: Partial<Chat>): Chat => ({
  id: 'c1', title: 'Fix login', workspaceName: 'codey', messages: [], ...over,
} as unknown as Chat);

describe('summarizePriorHistory', () => {
  it('is one header line when the chat is empty', () => {
    expect(summarizePriorHistory(chat({}), { defaultAgent: 'claude-code', defaultModel: 'opus' }))
      .toBe('🔗 "Fix login" · claude-code · opus · codey');
  });

  it('adds only the last exchange, truncated, plus a non-solo mode', () => {
    const long = 'x'.repeat(200);
    const out = summarizePriorHistory(chat({
      selection: { type: 'team', name: 'review' },
      messages: [
        { role: 'user', content: 'old' },
        { role: 'user', content: 'fix  the\nbug' },
        { role: 'assistant', content: long },
      ],
    } as Partial<Chat>), { defaultAgent: 'codex', defaultModel: 'gpt' });
    expect(out.split('\n')).toEqual([
      '🔗 "Fix login" · codex · gpt · codey · team:review',
      'You: fix the bug',
      `Agent: ${'x'.repeat(120)}…`,
    ]);
  });
});
