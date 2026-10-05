import { describe, expect, it } from 'vitest';
import { botOutputStream } from './bot-output';
import { BotMessageEmitter } from './bot-message-emitter';
import { composeTeamFinal } from './team-finalizer';
import type { ChatMessage } from '@codey/core';

describe('bot output delivery', () => {
  it.each(['auto', 'roundtable'] as const)('persists a non-streaming result and supplies it to the summary in %s mode', async mode => {
    const messages: ChatMessage[] = [];
    const events: any[] = [];
    const emitter = new BotMessageEmitter(e => events.push(e), {
      appendMessage: (_chat, m) => messages.push(m),
      updateMessage: (_chat, id, patch) => Object.assign(messages.find(m => m.id === id)!, patch),
    }, 'chat', { teamTurnId: 'turn', teamName: 'team', mode });
    emitter.teamStart([{ step: 1, bot: 'developer' }]);
    if (mode === 'auto') emitter.beginBot({ step: 1, bot: 'developer' });
    const target = mode === 'roundtable' ? 'developer' : undefined;
    const stream = botOutputStream(text => emitter.onStream(text, target));
    stream.complete('Updated the version to 0.13.4.');
    emitter.endBot('done', undefined, target);
    expect(messages[0].content).toBe('Updated the version to 0.13.4.');
    expect(events.find(e => e.type === 'stream')).toMatchObject({ messageId: messages[0].id, token: messages[0].content });
    const final = await composeTeamFinal({ teamTurnId: 'turn', task: 'Update version', messages });
    expect(final!.content).toContain('Updated the version to 0.13.4.');
  });

  it('fills an incomplete stream without duplicating existing text', () => {
    const chunks: string[] = [];
    const stream = botOutputStream(text => chunks.push(text));
    stream.onStream('Updated ');
    stream.complete('Updated the version.');
    stream.complete('Updated the version.');
    expect(chunks.filter(Boolean)).toEqual(['Updated ', 'the version.']);
  });

  it('keeps streamed commentary when the final answer is a different representation', () => {
    const chunks: string[] = [];
    const stream = botOutputStream(text => chunks.push(text));
    stream.onStream('Working...\nDone.');
    stream.complete('Done.');
    expect(chunks).toEqual(['Working...\nDone.']);
  });
});
