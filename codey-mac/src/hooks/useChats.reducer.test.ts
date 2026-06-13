import { describe, it, expect } from 'vitest'
import { reducer, type State } from './useChats'
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
})
