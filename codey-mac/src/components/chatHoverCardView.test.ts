import { describe, it, expect } from 'vitest'
import { buildChatHoverCard, hoverCardPosition, HOVER_CARD_WIDTH } from './chatHoverCardView'
import type { Chat } from '../types'

const NOW = 1_700_000_000_000

function makeChat(overrides: Partial<Chat> = {}): Chat {
  return {
    id: 'c1',
    title: 'Fix the reducer',
    workspaceName: 'codey',
    selection: { type: 'none' },
    messages: [],
    createdAt: NOW - 3_600_000,
    updatedAt: NOW - 60_000,
    ...overrides,
  } as Chat
}

function rowValue(card: ReturnType<typeof buildChatHoverCard>, label: string) {
  return card.rows.find(r => r.label === label)?.value
}

describe('buildChatHoverCard — status', () => {
  it('reports the live activity while a turn is in flight', () => {
    const card = buildChatHoverCard({
      chat: makeChat(),
      flight: { agentStatus: 'editing' },
      unread: false,
      now: NOW,
    })
    expect(card.status).toEqual({ label: 'Editing', tone: 'accent' })
  })

  it('says where in the queue a waiting turn sits', () => {
    const card = buildChatHoverCard({
      chat: makeChat(),
      flight: { agentStatus: 'thinking', queuedPosition: 2 },
      unread: false,
      now: NOW,
    })
    expect(card.status.label).toBe('Queued · 2nd in line')
  })

  it('puts a permission prompt ahead of the running state — it is the thing blocking', () => {
    const card = buildChatHoverCard({
      chat: makeChat(),
      flight: { agentStatus: 'running' },
      unread: false,
      pendingPermissions: ['Bash'],
      now: NOW,
    })
    expect(card.status).toEqual({ label: 'Needs permission', tone: 'yellow' })
    expect(card.detail).toBe('Bash')
  })

  it('names all the tools waiting on a permission decision', () => {
    const card = buildChatHoverCard({
      chat: makeChat(),
      unread: false,
      pendingPermissions: ['Bash', 'Write'],
      now: NOW,
    })
    expect(card.detail).toBe('Bash, Write')
  })

  it('surfaces a paused team run as waiting on the user', () => {
    const card = buildChatHoverCard({
      chat: makeChat({ pendingTeam: { askingWorker: 'aide', question: 'Which database?' } as unknown as Chat['pendingTeam'] }),
      unread: false,
      now: NOW,
    })
    expect(card.status).toEqual({ label: 'Waiting on you', tone: 'yellow' })
    expect(card.detail).toBe('Which database?')
  })

  it('falls back to the task brief when the chat is idle', () => {
    const card = buildChatHoverCard({
      chat: makeChat({
        messages: [{ id: 'm1', role: 'assistant', content: 'hi', timestamp: NOW - 120_000 }] as Chat['messages'],
        taskBrief: {
          goal: 'Ship the hover card',
          state: { progress: 40, status: 'blocked' },
          nextAction: { text: 'Waiting on API access' },
          timeline: [],
          generatedAt: NOW - 60_000,
        },
      }),
      unread: false,
      now: NOW,
    })
    expect(card.status).toEqual({ label: 'Blocked', tone: 'red' })
    expect(card.detail).toBe('Waiting on API access')
    expect(card.progress).toMatchObject({ percent: 40 })
  })

  it('ignores a task brief that predates the newest message rather than showing a stale claim', () => {
    const card = buildChatHoverCard({
      chat: makeChat({
        messages: [{ id: 'm1', role: 'assistant', content: 'hi', timestamp: NOW - 10_000 }] as Chat['messages'],
        taskBrief: {
          goal: 'Ship the hover card',
          state: { progress: 40, status: 'done' },
          timeline: [],
          generatedAt: NOW - 600_000,
        },
      }),
      unread: false,
      now: NOW,
    })
    expect(card.status.label).not.toBe('Done')
    expect(card.progress).toBeUndefined()
  })

  it('marks an unread finished chat as having a new reply', () => {
    const card = buildChatHoverCard({
      chat: makeChat({ messages: [{ id: 'm1', role: 'assistant', content: 'done', timestamp: NOW }] as Chat['messages'] }),
      unread: true,
      now: NOW,
    })
    expect(card.status).toEqual({ label: 'New reply', tone: 'green' })
  })

  it('calls an empty chat empty instead of idle', () => {
    const card = buildChatHoverCard({ chat: makeChat(), unread: false, now: NOW })
    expect(card.status).toEqual({ label: 'No messages yet', tone: 'muted' })
  })

  it('prefers the agent-reported checklist item over the activity word', () => {
    const card = buildChatHoverCard({
      chat: makeChat({
        checklist: [
          { text: 'Write the model', status: 'completed' },
          { text: 'Wire the card', activeForm: 'Wiring the card', status: 'in_progress' },
          { text: 'Test it', status: 'pending' },
        ] as Chat['checklist'],
      }),
      flight: { agentStatus: 'editing' },
      unread: false,
      now: NOW,
    })
    expect(card.detail).toBe('Wiring the card')
    expect(card.progress).toEqual({ percent: 33, label: '1/3' })
  })
})

describe('buildChatHoverCard — rows', () => {
  it('names the agent, model and effort on one line', () => {
    const card = buildChatHoverCard({
      chat: makeChat({ agent: 'claude-code', model: 'claude-opus-5', effort: 'high' }),
      unread: false,
      now: NOW,
    })
    expect(rowValue(card, 'Agent')).toBe('claude-code · claude-opus-5 · high effort')
  })

  it('marks an unset agent as following the gateway default', () => {
    const card = buildChatHoverCard({ chat: makeChat(), unread: false, defaultAgent: 'codex', now: NOW })
    expect(rowValue(card, 'Agent')).toBe('codex (default)')
  })

  it('says gateway default when even the default is unknown', () => {
    const card = buildChatHoverCard({ chat: makeChat(), unread: false, now: NOW })
    expect(rowValue(card, 'Agent')).toBe('Gateway default')
  })

  it('reports the worktree a chat is isolated in', () => {
    const card = buildChatHoverCard({
      chat: makeChat({
        executionMode: 'isolated-worktree',
        chatWorkspace: {
          name: 'hover-card',
          repositoryRoot: '/repo',
          worktreePath: '/repo/.worktrees/hover-card',
          workingDir: '/repo/.worktrees/hover-card',
          baseCommit: 'abc',
          createdAt: NOW,
        },
      }),
      unread: false,
      now: NOW,
    })
    expect(rowValue(card, 'Checkout')).toBe('Isolated worktree · hover-card')
  })

  it('says shared checkout when the chat is not isolated', () => {
    const card = buildChatHoverCard({ chat: makeChat(), unread: false, now: NOW })
    expect(rowValue(card, 'Checkout')).toBe('Shared checkout')
  })

  it('shows the team or worker a chat is bound to', () => {
    const team = buildChatHoverCard({ chat: makeChat({ selection: { type: 'team', name: 'builders' } }), unread: false, now: NOW })
    expect(rowValue(team, 'Team')).toBe('builders')
    const worker = buildChatHoverCard({ chat: makeChat({ selection: { type: 'worker', name: 'aide' } }), unread: false, now: NOW })
    expect(rowValue(worker, 'Worker')).toBe('aide')
  })

  it('omits the team row for a plain chat', () => {
    const card = buildChatHoverCard({ chat: makeChat(), unread: false, now: NOW })
    expect(rowValue(card, 'Team')).toBeUndefined()
    expect(rowValue(card, 'Worker')).toBeUndefined()
  })

  it('reports the pull request state in words', () => {
    const card = buildChatHoverCard({
      chat: makeChat({ pullRequest: { url: 'u', number: 42, state: 'merged-with-changes', lastCheckedAt: NOW } }),
      unread: false,
      now: NOW,
    })
    expect(rowValue(card, 'Delivery')).toBe('PR #42 · merged, new changes since')
  })

  it('counts messages and dates the last activity', () => {
    const card = buildChatHoverCard({
      chat: makeChat({
        messages: [
          { id: 'm1', role: 'user', content: 'a', timestamp: NOW - 200_000 },
          { id: 'm2', role: 'assistant', content: 'b', timestamp: NOW - 100_000 },
        ] as Chat['messages'],
        updatedAt: NOW - 7_200_000,
      }),
      unread: false,
      now: NOW,
    })
    expect(rowValue(card, 'Messages')).toBe('2')
    expect(rowValue(card, 'Last active')).toBe('2h ago')
  })

  it('singularizes a lone message', () => {
    const card = buildChatHoverCard({
      chat: makeChat({ messages: [{ id: 'm1', role: 'user', content: 'a', timestamp: NOW }] as Chat['messages'] }),
      unread: false,
      now: NOW,
    })
    expect(rowValue(card, 'Messages')).toBe('1')
  })

  it('lists the channels a chat is routed to', () => {
    const card = buildChatHoverCard({
      chat: makeChat({
        routes: [
          { channel: 'telegram', channelUserId: 'u1', channelChatId: '1', attachedAt: NOW },
          { channel: 'discord', channelUserId: 'u2', channelChatId: '2', attachedAt: NOW },
        ],
      }),
      unread: false,
      now: NOW,
    })
    expect(rowValue(card, 'Channels')).toBe('telegram, discord')
  })

  it('falls back to a placeholder title for an unnamed chat', () => {
    const card = buildChatHoverCard({ chat: makeChat({ title: '   ' }), unread: false, now: NOW })
    expect(card.title).toBe('New Chat')
  })
})

describe('hoverCardPosition', () => {
  const viewport = { width: 1400, height: 900 }
  const rect = { top: 100, bottom: 128, left: 20, right: 240 }

  it('anchors to the right of the row, level with its top', () => {
    const pos = hoverCardPosition(rect, viewport, 200)
    expect(pos.left).toBe(rect.right + 8)
    expect(pos.top).toBe(rect.top)
  })

  it('flips to the left of the row when the card would overflow the viewport', () => {
    const pos = hoverCardPosition({ ...rect, left: 1150, right: 1380 }, viewport, 200)
    expect(pos.left).toBe(1150 - 8 - HOVER_CARD_WIDTH)
  })

  it('lifts the card so a tall one stays on screen', () => {
    const pos = hoverCardPosition({ ...rect, top: 820, bottom: 848 }, viewport, 200)
    expect(pos.top).toBe(900 - 200 - 8)
  })

  it('never pushes the card off the top edge', () => {
    const pos = hoverCardPosition({ ...rect, top: 10, bottom: 38 }, { width: 1400, height: 180 }, 200)
    expect(pos.top).toBe(8)
  })

  it('keeps the card on screen when neither side has room', () => {
    const pos = hoverCardPosition({ top: 10, bottom: 38, left: 4, right: 100 }, { width: 320, height: 900 }, 200)
    expect(pos.left).toBeGreaterThanOrEqual(8)
    expect(pos.left + HOVER_CARD_WIDTH).toBeLessThanOrEqual(320 - 8)
  })
})
