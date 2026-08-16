import { describe, it, expect } from 'vitest'
import { buildChatHoverCard, clampCardTop } from './chatHoverCardView'
import type { Chat } from '../types'

const NOW = 1_700_000_000_000

function chat(over: Partial<Chat> = {}): Chat {
  return {
    id: 'c1',
    title: 'Fix the parser',
    workspaceName: 'codey',
    selection: { type: 'none' },
    messages: [],
    createdAt: NOW - 3_600_000,
    updatedAt: NOW - 300_000,
    ...over,
  } as Chat
}

const rowValue = (view: ReturnType<typeof buildChatHoverCard>, label: string) =>
  view.rows.find(r => r.label === label)?.value

describe('buildChatHoverCard', () => {
  it('falls back to a placeholder title and the gateway agent', () => {
    const view = buildChatHoverCard(chat({ title: '  ' }), { now: NOW })
    expect(view.title).toBe('New Chat')
    expect(rowValue(view, 'Agent')).toBe('gateway default')
    expect(view.status).toEqual({ label: 'Idle', tone: 'accent' })
  })

  it('pairs the agent with its model override', () => {
    const view = buildChatHoverCard(chat({ agent: 'codex', model: 'gpt-5' }), { now: NOW })
    expect(rowValue(view, 'Agent')).toBe('codex · gpt-5')
  })

  it('ranks a permission prompt above a running turn', () => {
    const view = buildChatHoverCard(chat(), {
      now: NOW,
      activity: 'editing',
      pendingPermissions: ['Bash', 'Write'],
    })
    expect(view.status).toEqual({ label: 'Needs permission — Bash +1', tone: 'red' })
  })

  it('ranks a running turn above an unread reply', () => {
    const view = buildChatHoverCard(chat(), { now: NOW, activity: 'searching', unread: true })
    expect(view.status).toEqual({ label: 'Searching', tone: 'accent' })
  })

  it('reports a paused team run', () => {
    const view = buildChatHoverCard(chat({ pendingTeam: {} as Chat['pendingTeam'] }), { now: NOW })
    expect(view.status.label).toBe('Paused — waiting on your reply')
  })

  it('falls back to the task brief status when nothing is live', () => {
    const view = buildChatHoverCard(
      chat({
        taskBrief: {
          goal: 'Ship the hover card',
          state: { progress: 60, status: 'blocked' },
          timeline: [],
          generatedAt: NOW - 60_000,
        },
      }),
      { now: NOW },
    )
    expect(view.status).toEqual({ label: 'Blocked', tone: 'red' })
    expect(view.goal).toBe('Ship the hover card')
    expect(view.progress).toBe(60)
  })

  it('omits progress when the brief has no goal text', () => {
    const view = buildChatHoverCard(
      chat({ taskBrief: { goal: '', state: { progress: 30, status: 'working' }, timeline: [], generatedAt: NOW } }),
      { now: NOW },
    )
    expect(view.goal).toBeUndefined()
    expect(view.progress).toBeUndefined()
  })

  it('describes worker and team selections', () => {
    expect(rowValue(buildChatHoverCard(chat({ selection: { type: 'worker', name: 'Aide' } }), { now: NOW }), 'Runs as'))
      .toBe('Worker · Aide')
    expect(rowValue(buildChatHoverCard(chat({ selection: { type: 'team', name: 'Squad' } }), { now: NOW }), 'Runs as'))
      .toBe('Team · Squad')
    expect(rowValue(buildChatHoverCard(chat(), { now: NOW }), 'Runs as')).toBeUndefined()
  })

  it('names the chat worktree, falling back to the checkout mode', () => {
    expect(rowValue(buildChatHoverCard(chat({ chatWorkspace: { name: 'hover-card' } as Chat['chatWorkspace'] }), { now: NOW }), 'Checkout'))
      .toBe('hover-card')
    expect(rowValue(buildChatHoverCard(chat({ executionMode: 'isolated-worktree' }), { now: NOW }), 'Checkout'))
      .toBe('Isolated worktree')
    expect(rowValue(buildChatHoverCard(chat(), { now: NOW }), 'Checkout')).toBe('Shared checkout')
  })

  it('summarizes the pull request state', () => {
    const view = buildChatHoverCard(
      chat({ pullRequest: { url: 'u', number: 242, state: 'merged-with-changes', lastCheckedAt: NOW } }),
      { now: NOW },
    )
    expect(rowValue(view, 'Pull request')).toBe('#242 · merged · new changes')
  })

  it('counts messages and formats the last activity', () => {
    const view = buildChatHoverCard(chat({ messages: [{}, {}] as Chat['messages'] }), { now: NOW })
    expect(rowValue(view, 'Messages')).toBe('2')
    expect(rowValue(view, 'Last activity')).toBe('5m ago')
  })

  it('labels linked channels', () => {
    const view = buildChatHoverCard(
      chat({ routes: [{ channel: 'telegram', channelUserId: '1' }, { channel: 'imessage', channelUserId: '2' }] as Chat['routes'] }),
      { now: NOW },
    )
    expect(view.channels).toEqual(['Telegram', 'iMessage'])
  })
})

describe('clampCardTop', () => {
  it('keeps the card aligned with the row when it fits', () => {
    expect(clampCardTop(200, 300, 900)).toBe(200)
  })

  it('slides the card up when it would spill past the bottom', () => {
    expect(clampCardTop(800, 300, 900)).toBe(588)
  })

  it('pins to the top margin when the card is taller than the viewport', () => {
    expect(clampCardTop(400, 900, 500)).toBe(12)
  })

  it('never rises above the top margin', () => {
    expect(clampCardTop(-50, 200, 900)).toBe(12)
  })
})
