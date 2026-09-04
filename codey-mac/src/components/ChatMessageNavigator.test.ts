import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { CHAT_NAV_MIN_ITEMS, ChatMessageNavigator, tickWidthFor, type ChatNavigationItem } from './ChatMessageNavigator'

const makeItems = (count: number): ChatNavigationItem[] => Array.from({ length: count }, (_, index) => ({
  id: `message-${index}`,
  title: `Message ${index + 1}`,
  preview: `Preview ${index + 1}`,
  role: index % 3 === 0 ? 'team' : 'assistant',
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
