import { describe, it, expect } from 'vitest';
import { WorkerMessageEmitter } from './worker-message-emitter';
import type { ChatStreamEvent } from './chat-runner';

function harness() {
  const events: ChatStreamEvent[] = [];
  const appended: any[] = [];
  const patched: Array<{ id: string; patch: any }> = [];
  const store = {
    appendMessage: (_c: string, m: any) => { appended.push(m); },
    updateMessage: (_c: string, id: string, patch: any) => { patched.push({ id, patch }); },
  };
  let n = 0;
  const newId = () => `id-${++n}`;
  const em = new WorkerMessageEmitter(
    (e) => events.push(e), store, 'chat1',
    { teamTurnId: 'tt1', teamName: 'team', mode: 'auto' }, newId,
  );
  return { em, events, appended, patched };
}

describe('WorkerMessageEmitter — serial', () => {
  it('begin appends a running stub and emits worker_start with the same id', () => {
    const h = harness();
    const id = h.em.beginWorker({ step: 1, worker: 'pm', reason: 'kickoff', agent: 'codex', model: 'gpt-5' });
    expect(id).toBe('id-1');
    expect(h.appended[0]).toMatchObject({ id: 'id-1', role: 'assistant', workerStatus: 'running', teamTurnId: 'tt1', step: 1, worker: 'pm', advisorReason: 'kickoff', agent: 'codex', model: 'gpt-5' });
    expect(h.events[0]).toMatchObject({ type: 'worker_start', messageId: 'id-1', step: 1, worker: 'pm', reason: 'kickoff' });
  });

  it('routes stream/thinking/tool to the active worker and tags messageId', () => {
    const h = harness();
    const id = h.em.beginWorker({ step: 1, worker: 'pm' });
    h.em.onStream('hello ');
    h.em.onStream('world');
    h.em.onThinking('hmm', 1);
    h.em.onTool({ type: 'tool_start', tool: 'Read', message: 'Read(a)', input: { file_path: 'a' } });
    expect(h.events.filter(e => e.type === 'stream').every(e => (e as any).messageId === id)).toBe(true);
    expect(h.events.find(e => e.type === 'thinking')).toMatchObject({ messageId: id, step: 1 });
    expect(h.events.find(e => e.type === 'tool_start')).toMatchObject({ messageId: id, tool: 'Read' });
  });

  it('end patches the message with the accumulated buffers + status and emits worker_end', () => {
    const h = harness();
    const id = h.em.beginWorker({ step: 1, worker: 'pm' });
    h.em.onStream('out');
    h.em.onTool({ type: 'tool_start', tool: 'Read', message: 'Read(a)' });
    h.em.endWorker('done', { tokens: 42, durationSec: 3 });
    expect(h.patched[0].id).toBe(id);
    expect(h.patched[0].patch).toMatchObject({ content: 'out', workerStatus: 'done', isComplete: true, tokens: 42, durationSec: 3 });
    expect(h.patched[0].patch.toolCalls).toHaveLength(1);
    expect(h.events.at(-1)).toMatchObject({ type: 'worker_end', messageId: id, status: 'done' });
  });

  it('beginWorker auto-finalizes a still-active previous worker as done', () => {
    const h = harness();
    h.em.beginWorker({ step: 1, worker: 'a' });
    h.em.beginWorker({ step: 2, worker: 'b' });
    expect(h.patched[0].patch.workerStatus).toBe('done');
    expect(h.appended).toHaveLength(2);
  });
});

describe('WorkerMessageEmitter — parallel', () => {
  it('teamStart pre-creates one stub per worker and emits team_start with their ids', () => {
    const h = harness();
    h.em.teamStart([{ step: 1, worker: 'a' }, { step: 2, worker: 'b' }]);
    expect(h.appended.map(m => m.worker)).toEqual(['a', 'b']);
    const ev = h.events.find(e => e.type === 'team_start') as any;
    expect(ev.workers.map((w: any) => w.worker)).toEqual(['a', 'b']);
    expect(ev.workers[0].messageId).toBe(h.appended[0].id);
  });

  it('routes events to a named worker message (concurrent-safe)', () => {
    const h = harness();
    h.em.teamStart([{ step: 1, worker: 'a' }, { step: 2, worker: 'b' }]);
    const idA = h.appended[0].id, idB = h.appended[1].id;
    h.em.onStream('from-a', 'a');
    h.em.onStream('from-b', 'b');
    h.em.endWorker('done', undefined, 'a');
    expect(h.events.filter(e => e.type === 'stream').map(e => (e as any).messageId)).toEqual([idA, idB]);
    expect(h.patched[0]).toMatchObject({ id: idA, patch: { content: 'from-a', workerStatus: 'done' } });
  });
});
