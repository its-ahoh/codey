import { describe, it, expect } from 'vitest'
import { reducer, shouldAdoptExternalTurn, type State } from './useChats'
import type { Chat } from '../types'

const emptyState = (): State => ({
  chats: {}, order: [], selectedChatId: null, inFlight: {},
  collapsedWorkspaces: {}, workspaces: [], pendingRestores: {},
  unreadChats: {}, pendingPermissions: {},
})

// A chat as it exists server-side at turn start: the user message is already
// persisted (appendMessage in gateway.sendToChat), no assistant message yet.
const makeChat = (overrides: Partial<Chat> = {}): Chat => ({
  id: 'c1', title: 'Captured task', workspaceName: 'codey',
  selection: { type: 'none' }, createdAt: 1, updatedAt: 1,
  messages: [{ id: 'u1', role: 'user', content: 'do the thing', timestamp: 1, isComplete: true }],
  ...overrides,
})

function baseState(): State {
  return {
    chats: { c1: { id: 'c1', title: 't', workspaceName: 'ws', selection: { type: 'team', name: 'team' }, messages: [], createdAt: 0, updatedAt: 0 } },
    order: ['c1'], selectedChatId: 'c1',
    inFlight: { c1: { assistantMessageId: 'asst-x', userMessageId: 'u1', agentStatus: 'thinking' } },
    collapsedWorkspaces: {}, workspaces: ['ws'], pendingRestores: {}, unreadChats: {}, pendingPermissions: {},
  };
}

describe('team reducer routing', () => {
  it('workerStart appends a running worker message with the backend id', () => {
    let s = baseState();
    s = reducer(s, { type: 'workerStart', chatId: 'c1', teamTurnId: 'tt1', messageId: 'w1', step: 1, worker: 'pm', reason: 'kickoff', agent: 'codex', model: 'gpt-5' });
    const m = s.chats.c1.messages.find(x => x.id === 'w1')!;
    expect(m).toMatchObject({ id: 'w1', role: 'assistant', teamTurnId: 'tt1', worker: 'pm', workerStatus: 'running', advisorReason: 'kickoff', agent: 'codex', model: 'gpt-5' });
  });

  it('streamToken/toolCall route to the event messageId, not the single inFlight id', () => {
    let s = baseState();
    s = reducer(s, { type: 'workerStart', chatId: 'c1', teamTurnId: 'tt1', messageId: 'w1', step: 1, worker: 'a', reason: '' });
    s = reducer(s, { type: 'workerStart', chatId: 'c1', teamTurnId: 'tt1', messageId: 'w2', step: 2, worker: 'b', reason: '' });
    s = reducer(s, { type: 'streamToken', chatId: 'c1', token: 'hi', messageId: 'w1' });
    s = reducer(s, { type: 'toolCall', chatId: 'c1', entry: { id: 't', type: 'tool_start', tool: 'Read', message: 'Read(a)' }, status: 'working', messageId: 'w2' });
    expect(s.chats.c1.messages.find(x => x.id === 'w1')!.content).toBe('hi');
    expect(s.chats.c1.messages.find(x => x.id === 'w2')!.toolCalls).toHaveLength(1);
    expect(s.chats.c1.messages.find(x => x.id === 'w1')!.toolCalls ?? []).toHaveLength(0);
  });

  it('workerEnd sets status', () => {
    let s = baseState();
    s = reducer(s, { type: 'workerStart', chatId: 'c1', teamTurnId: 'tt1', messageId: 'w1', step: 1, worker: 'a', reason: '' });
    s = reducer(s, { type: 'workerEnd', chatId: 'c1', messageId: 'w1', step: 1, status: 'done' });
    expect(s.chats.c1.messages.find(x => x.id === 'w1')!.workerStatus).toBe('done');
  });
});

// Regression: quick-capture (and paired-channel) turns are created + run in the
// main process, so the renderer has no inFlight entry and previously dropped
// every live event until 'done' — the chat was invisible until refresh and
// showed no "working" indicator. adoptInFlight is how the renderer adopts such
// turns on their first live event.
describe('reducer: adoptInFlight (externally-initiated turns)', () => {
  it('inserts the chat, appends an assistant stub, and opens an inFlight entry', () => {
    const chat = makeChat()
    const next = reducer(emptyState(), { type: 'adoptInFlight', chat, assistantMessageId: 'a1' })
    expect(next.chats['c1']).toBeDefined()
    expect(next.order).toContain('c1')
    const msgs = next.chats['c1'].messages
    expect(msgs).toHaveLength(2) // persisted user msg + new assistant stub
    expect(msgs[1]).toMatchObject({ id: 'a1', role: 'assistant', content: '', isComplete: false })
    expect(next.inFlight['c1']).toMatchObject({ assistantMessageId: 'a1', userMessageId: 'u1', agentStatus: 'thinking' })
  })

  it('lets subsequent live events render (streamToken appends to the stub)', () => {
    const chat = makeChat()
    let s = reducer(emptyState(), { type: 'adoptInFlight', chat, assistantMessageId: 'a1' })
    s = reducer(s, { type: 'streamToken', chatId: 'c1', token: 'Hello' })
    const stub = s.chats['c1'].messages.find(m => m.id === 'a1')
    expect(stub?.content).toBe('Hello')
    expect(s.inFlight['c1'].agentStatus).toBe('writing')
  })

  it('is a no-op when the chat is already in flight (no double adopt)', () => {
    const chat = makeChat()
    const s1 = reducer(emptyState(), { type: 'adoptInFlight', chat, assistantMessageId: 'a1' })
    const s2 = reducer(s1, { type: 'adoptInFlight', chat, assistantMessageId: 'a2' })
    expect(s2).toBe(s1) // unchanged reference
    expect(s2.chats['c1'].messages).toHaveLength(2) // not a second stub
  })

  it('does not adopt a post-run skill notice as a new turn', () => {
    expect(shouldAdoptExternalTurn(
      { type: 'info', chatId: 'c1', message: 'Save this skill?', skillNotice: true },
      false,
      false,
    )).toBe(false)
    expect(shouldAdoptExternalTurn(
      { type: 'stream', chatId: 'c1', token: 'hello' },
      false,
      false,
    )).toBe(true)
  })
})
