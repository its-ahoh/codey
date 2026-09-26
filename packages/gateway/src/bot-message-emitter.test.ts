import { describe, it, expect } from 'vitest';
import { BotMessageEmitter } from './bot-message-emitter';
import type { ChatStreamEvent } from './chat-runner';

function harness(mode: 'auto' | 'roundtable' = 'auto') {
  const events: ChatStreamEvent[] = [];
  const appended: any[] = [];
  const patched: Array<{ id: string; patch: any }> = [];
  const store = {
    appendMessage: (_c: string, m: any) => { appended.push(m); },
    updateMessage: (_c: string, id: string, patch: any) => { patched.push({ id, patch }); },
  };
  let n = 0;
  const newId = () => `id-${++n}`;
  const em = new BotMessageEmitter(
    (e) => events.push(e), store, 'chat1',
    { teamTurnId: 'tt1', teamName: 'team', mode }, newId,
  );
  return { em, events, appended, patched };
}

describe('BotMessageEmitter — serial', () => {
  it('pre-creates pending roster cards and promotes the selected bot in place', () => {
    const h = harness();
    h.em.teamStart([{ step: 1, bot: 'pm' }, { step: 2, bot: 'developer' }]);
    expect(h.appended.map(message => [message.bot, message.botStatus])).toEqual([
      ['pm', 'pending'], ['developer', 'pending'],
    ]);

    const id = h.em.beginBot({ step: 1, bot: 'pm', reason: 'kickoff' });
    expect(id).toBe(h.appended[0].id);
    expect(h.appended).toHaveLength(2);
    expect(h.patched.at(-1)).toMatchObject({ id, patch: { botStatus: 'running', advisorReason: 'kickoff' } });
  });

  it('begin appends a running stub and emits bot_start with the same id', () => {
    const h = harness();
    const id = h.em.beginBot({ step: 1, bot: 'pm', reason: 'kickoff', agent: 'codex', model: 'gpt-5' });
    expect(id).toBe('id-1');
    expect(h.appended[0]).toMatchObject({ id: 'id-1', role: 'assistant', botStatus: 'running', teamTurnId: 'tt1', step: 1, bot: 'pm', advisorReason: 'kickoff', agent: 'codex', model: 'gpt-5' });
    expect(h.events[0]).toMatchObject({ type: 'bot_start', messageId: 'id-1', step: 1, bot: 'pm', reason: 'kickoff' });
  });

  it('routes stream/thinking/tool to the active bot and tags messageId', () => {
    const h = harness();
    const id = h.em.beginBot({ step: 1, bot: 'pm' });
    h.em.onStream('hello ');
    h.em.onStream('world');
    h.em.onThinking('hmm', 1);
    h.em.onTool({ type: 'tool_start', tool: 'Read', message: 'Read(a)', input: { file_path: 'a' } });
    expect(h.events.filter(e => e.type === 'stream').every(e => (e as any).messageId === id)).toBe(true);
    expect(h.events.find(e => e.type === 'thinking')).toMatchObject({ messageId: id, step: 1 });
    expect(h.events.find(e => e.type === 'tool_start')).toMatchObject({ messageId: id, tool: 'Read' });
  });

  it('carries sampled shell writes onto the tool_end row and its event', () => {
    const h = harness();
    h.em.beginBot({ step: 1, bot: 'pm' });
    h.em.onTool({ type: 'tool_end', tool: 'Bash', message: 'ran', writes: ['/repo/a.ts'] });
    h.em.endBot('done');
    expect(h.events.find(e => e.type === 'tool_end')).toMatchObject({ writes: ['/repo/a.ts'] });
    expect(h.patched[0].patch.toolCalls[0]).toMatchObject({ type: 'tool_end', writes: ['/repo/a.ts'] });
  });

  it('leaves the writes field off a tool call that wrote nothing', () => {
    const h = harness();
    h.em.beginBot({ step: 1, bot: 'pm' });
    h.em.onTool({ type: 'tool_end', tool: 'Bash', message: 'ran' });
    h.em.endBot('done');
    expect('writes' in (h.patched[0].patch.toolCalls[0] as object)).toBe(false);
  });

  it('end patches the message with the accumulated buffers + status and emits bot_end', () => {
    const h = harness();
    const id = h.em.beginBot({ step: 1, bot: 'pm' });
    h.em.onStream('out');
    h.em.onTool({ type: 'tool_start', tool: 'Read', message: 'Read(a)' });
    h.em.endBot('done', { tokens: 42, durationSec: 3 });
    expect(h.patched[0].id).toBe(id);
    expect(h.patched[0].patch).toMatchObject({ content: 'out', botStatus: 'done', isComplete: true, tokens: 42, durationSec: 3 });
    expect(h.patched[0].patch.toolCalls).toHaveLength(1);
    expect(h.events.at(-1)).toMatchObject({ type: 'bot_end', messageId: id, status: 'done' });
  });

  it('persists and emits the latest team blackboard snapshot', () => {
    const h = harness();
    const id = h.em.beginBot({ step: 1, bot: 'pm' });
    const blackboard = {
      facts: [],
      decisions: [{ bot: 'pm', step: 1, text: 'Ship the live panel' }],
      handoffs: [],
      open: [],
    };
    h.em.updateBlackboard(blackboard);
    expect(h.patched.at(-1)).toEqual({ id, patch: { teamBlackboard: blackboard } });
    expect(h.events.at(-1)).toMatchObject({
      type: 'blackboard_update', teamTurnId: 'tt1', messageId: id, blackboard,
    });
  });

  it('persists thinking tokens without translating or normalizing them', () => {
    const h = harness();
    const source = `\n\u4FDD\u7559\u539F\u59CB\u8BED\u8A00\nEnglish follows  `;
    h.em.beginBot({ step: 1, bot: 'a' });
    h.em.onThinking(source.slice(0, 5), 1);
    h.em.onThinking(source.slice(5), 1);
    h.em.endBot('done');
    expect(h.patched[0].patch.thinking).toBe(source);
    expect(h.events.filter(e => e.type === 'thinking').map(e => (e as any).token).join('')).toBe(source);
  });

  it('persists structured failure and user-action metadata', () => {
    const failed = harness();
    failed.em.beginBot({ step: 1, bot: 'a' });
    failed.em.endBot('failed', { failureReason: 'Compiler exited with code 2' });
    expect(failed.patched[0].patch.botFailureReason).toBe('Compiler exited with code 2');

    const waiting = harness();
    waiting.em.beginBot({ step: 1, bot: 'a' });
    waiting.em.endBot('askedUser', { nextUserAction: { text: 'Choose a target', options: ['A', 'B'] } });
    expect(waiting.patched[0].patch.botNextUserAction).toEqual({ text: 'Choose a target', options: ['A', 'B'] });
  });

  it('beginBot auto-finalizes a still-active previous bot as done', () => {
    const h = harness();
    h.em.beginBot({ step: 1, bot: 'a' });
    h.em.beginBot({ step: 2, bot: 'b' });
    expect(h.patched[0].patch.botStatus).toBe('done');
    expect(h.appended).toHaveLength(2);
  });
});

describe('BotMessageEmitter — parallel', () => {
  it('teamStart pre-creates one stub per bot and emits team_start with their ids', () => {
    const h = harness('roundtable');
    h.em.teamStart([{ step: 1, bot: 'a' }, { step: 2, bot: 'b' }]);
    expect(h.appended.map(m => m.bot)).toEqual(['a', 'b']);
    expect(h.appended.every(m => m.botStatus === 'running')).toBe(true);
    const ev = h.events.find(e => e.type === 'team_start') as any;
    expect(ev.bots.map((w: any) => w.bot)).toEqual(['a', 'b']);
    expect(ev.bots[0].messageId).toBe(h.appended[0].id);
  });

  it('routes events to a named bot message (concurrent-safe)', () => {
    const h = harness('roundtable');
    h.em.teamStart([{ step: 1, bot: 'a' }, { step: 2, bot: 'b' }]);
    const idA = h.appended[0].id, idB = h.appended[1].id;
    h.em.onStream('from-a', 'a');
    h.em.onStream('from-b', 'b');
    h.em.endBot('done', undefined, 'a');
    expect(h.events.filter(e => e.type === 'stream').map(e => (e as any).messageId)).toEqual([idA, idB]);
    expect(h.patched[0]).toMatchObject({ id: idA, patch: { content: 'from-a', botStatus: 'done' } });
  });
});
