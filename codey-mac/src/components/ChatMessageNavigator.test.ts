import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { CHAT_NAV_MAX_TICKS, CHAT_NAV_MIN_ITEMS, ChatMessageNavigator, navigationItemsFor, shouldShowNavigator, tickWidthFor, ticksFor, type ChatNavigationItem } from './ChatMessageNavigator'
import type { ChatMessage } from '../types'

const makeItems = (count: number): ChatNavigationItem[] => Array.from({ length: count }, (_, index) => ({
  id: `message-${index}`,
  title: `Message ${index + 1}`,
  preview: `Preview ${index + 1}`,
  role: index % 3 === 0 ? 'team' : 'assistant',
  questionId: `question-${index}`,
}))

const renderNavigator = (count: number) => renderToStaticMarkup(React.createElement(ChatMessageNavigator, {
  containerRef: React.createRef<HTMLDivElement>(),
  items: makeItems(count),
  revision: String(count),
}))

describe('ChatMessageNavigator', () => {
  it('stays hidden for short conversations', () => {
    expect(renderNavigator(CHAT_NAV_MIN_ITEMS - 1)).toBe('')
  })

  it('renders one jump target per message once the threshold is reached', () => {
    const html = renderNavigator(CHAT_NAV_MIN_ITEMS)
    expect(html).toContain('aria-label="Conversation message navigation"')
    expect(html.match(/aria-label="Jump to Message/g)).toHaveLength(CHAT_NAV_MIN_ITEMS)
    expect(html).toContain('aria-current="location"')
  })

  it('merges neighbours so a very long chat never exceeds the tick cap', () => {
    const html = renderNavigator(CHAT_NAV_MAX_TICKS * 3)
    expect(html.match(/<button/g)).toHaveLength(CHAT_NAV_MAX_TICKS)
    expect(html).toContain('aria-label="Jump to 3 turns from Message 1"')
  })
})

describe('shouldShowNavigator', () => {
  const turn = (replies: number, questionId?: string): ChatNavigationItem => ({
    id: `a-${questionId}`, title: '', preview: '', role: 'team',
    rowIds: Array.from({ length: replies }, (_, i) => `r-${questionId}-${i}`), questionId,
  })

  it('counts every reply, not just turns', () => {
    expect(shouldShowNavigator([turn(3, 'q1'), turn(2, 'q2')])).toBe(true)
    expect(shouldShowNavigator([turn(2, 'q1'), turn(2, 'q2')])).toBe(false)
  })

  it('needs at least two questions', () => {
    expect(shouldShowNavigator([turn(9, 'q1')])).toBe(false)
    expect(shouldShowNavigator([turn(4), turn(4, 'q1')])).toBe(false)
  })
})

describe('ticksFor', () => {
  it('keeps one item per tick under the cap', () => {
    expect(ticksFor(makeItems(10), 42).map(t => t.length)).toEqual(Array(10).fill(1))
  })

  it('covers every item in order with near-equal buckets', () => {
    const items = makeItems(100)
    const ticks = ticksFor(items, 42)
    expect(ticks).toHaveLength(42)
    expect(ticks.flat()).toEqual(items)
    expect(Math.max(...ticks.map(t => t.length)) - Math.min(...ticks.map(t => t.length))).toBeLessThanOrEqual(1)
  })
})

const msg = (id: string, role: 'user' | 'assistant', content: string, extra: Partial<ChatMessage> = {}): ChatMessage =>
  ({ id, role, content, timestamp: 0, ...extra })

describe('navigationItemsFor', () => {
  it('maps each user turn once, labelled by its final reply', () => {
    const items = navigationItemsFor([
      msg('u1', 'user', 'Fix it'),
      msg('a1', 'assistant', 'Developer did the fix.', { bot: 'developer' }),
      msg('a2', 'assistant', '', { bot: 'code-reviewer' }),
      msg('a3', 'assistant', 'Fixed and reviewed. Next step.', { teamFinal: { source: 'aide', reason: 'done' } }),
      msg('u2', 'user', 'Thanks'),
      msg('b1', 'assistant', 'You are welcome.'),
    ])
    expect(items).toHaveLength(2)
    expect(items[0]).toMatchObject({ id: 'a1', questionId: 'u1', title: 'Fixed and reviewed.', role: 'team', rowIds: ['a1', 'a2', 'a3'] })
    expect(items[1]).toMatchObject({ id: 'b1', questionId: 'u2', title: 'You are welcome.', role: 'assistant', rowIds: ['b1'] })
  })

  it('falls back to a placeholder when every reply is empty', () => {
    expect(navigationItemsFor([msg('u', 'user', 'hi'), msg('a', 'assistant', '')])[0].title).toBe('Agent update')
  })
})

describe('tickWidthFor', () => {
  it('keeps every tick at the same base width when the pointer is away', () => {
    expect(tickWidthFor(null)).toBe(7)
  })

  it('grows the nearest tick the most and tapers with distance', () => {
    expect(tickWidthFor(0)).toBe(20)
    expect(tickWidthFor(10)).toBeLessThan(tickWidthFor(0))
    expect(tickWidthFor(30)).toBeLessThan(tickWidthFor(10))
    expect(tickWidthFor(200)).toBeCloseTo(7, 5)
  })
})
