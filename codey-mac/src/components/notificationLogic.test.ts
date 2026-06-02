import { describe, it, expect } from 'vitest'
import { deriveNotifications, type InFlightLike } from './notificationLogic'
import type { Chat } from '../types'

function chat(id: string, over: Partial<Chat> = {}): Chat {
  return {
    id,
    title: `Title ${id}`,
    workspaceName: 'ws',
    selection: {} as any,
    messages: [],
    createdAt: 0,
    updatedAt: 0,
    ...over,
  } as Chat
}

const inflight = (over: Partial<InFlightLike> = {}): InFlightLike => ({
  agentStatus: 'working',
  ...over,
})

describe('deriveNotifications', () => {
  it('lists in-flight chats under inProgress with their agent status', () => {
    const chats = { a: chat('a', { updatedAt: 5 }) }
    const r = deriveNotifications(chats, { a: inflight({ agentStatus: 'thinking' }) }, {})
    expect(r.inProgress).toHaveLength(1)
    expect(r.inProgress[0]).toMatchObject({ chatId: 'a', agentStatus: 'thinking' })
    expect(r.completed).toHaveLength(0)
    expect(r.unreadCount).toBe(0)
  })

  it('lists unread-completed chats and counts them in unreadCount', () => {
    const chats = { a: chat('a'), b: chat('b') }
    const r = deriveNotifications(chats, {}, { a: true, b: true })
    expect(r.completed).toHaveLength(2)
    expect(r.unreadCount).toBe(2)
    expect(r.inProgress).toHaveLength(0)
  })

  it('shows a chat that is both unread and in-flight only under inProgress', () => {
    const chats = { a: chat('a') }
    const r = deriveNotifications(chats, { a: inflight() }, { a: true })
    expect(r.inProgress).toHaveLength(1)
    expect(r.completed).toHaveLength(0)
    expect(r.unreadCount).toBe(0)
  })

  it('skips ids that have no matching chat', () => {
    const r = deriveNotifications({}, { ghost: inflight() }, { phantom: true })
    expect(r.inProgress).toHaveLength(0)
    expect(r.completed).toHaveLength(0)
  })

  it('sorts each group by updatedAt descending', () => {
    const chats = {
      a: chat('a', { updatedAt: 1 }),
      b: chat('b', { updatedAt: 9 }),
    }
    const r = deriveNotifications(chats, {}, { a: true, b: true })
    expect(r.completed.map(c => c.chatId)).toEqual(['b', 'a'])
  })
})
