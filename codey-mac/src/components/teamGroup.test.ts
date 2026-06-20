import { describe, it, expect } from 'vitest';
import { groupMessages } from './teamGroup';
import type { ChatMessage } from '../types';

const m = (id: string, extra: Partial<ChatMessage> = {}): ChatMessage =>
  ({ id, role: 'assistant', content: id, timestamp: 0, ...extra });

describe('groupMessages', () => {
  it('wraps a run of same-teamTurnId messages into one team block', () => {
    const msgs = [
      m('u', { role: 'user' }),
      m('w1', { teamTurnId: 'tt', teamName: 'T', teamMode: 'auto', worker: 'a', step: 1 }),
      m('w2', { teamTurnId: 'tt', teamName: 'T', teamMode: 'auto', worker: 'b', step: 2 }),
      m('after'),
    ];
    const out = groupMessages(msgs);
    expect(out.map(x => x.kind)).toEqual(['single', 'team', 'single']);
    const team = out[1];
    expect(team.kind === 'team' && team.teamTurnId).toBe('tt');
    expect(team.kind === 'team' && team.messages.map(mm => mm.id)).toEqual(['w1', 'w2']);
  });

  it('legacy combined team message (no teamTurnId) stays single', () => {
    const out = groupMessages([m('legacy', { content: '### Step 1: a\n\nx' })]);
    expect(out[0].kind).toBe('single');
  });
});
