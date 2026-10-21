// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatMessageNavigator, navigationItemsFor } from './ChatMessageNavigator'
import type { ChatMessage } from '../types'

const msg = (id: string, role: 'user' | 'assistant', content: string): ChatMessage => ({ id, role, content, timestamp: 0 })
const messages = [
  msg('u1', 'user', 'First?'), msg('a1', 'assistant', 'One.'), msg('a2', 'assistant', 'Two.'), msg('a3', 'assistant', 'Three.'),
  msg('u2', 'user', 'Second?'), msg('b1', 'assistant', 'Four.'), msg('b2', 'assistant', 'Five.'),
]
let host: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', undefined)
  Element.prototype.scrollIntoView = vi.fn()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})

describe('ChatMessageNavigator jumps', () => {
  it('scrolls to the question that started the turn, at the top', async () => {
    const Harness = () => {
      const ref = React.useRef<HTMLDivElement>(null)
      return React.createElement(React.Fragment, null,
        React.createElement('div', { ref }, messages.map(m =>
          React.createElement('div', { key: m.id, 'data-chat-navigation-id': m.id }, m.content))),
        React.createElement(ChatMessageNavigator, { containerRef: ref, items: navigationItemsFor(messages), revision: '1' }))
    }
    await act(async () => root.render(React.createElement(Harness)))
    const marks = host.querySelectorAll<HTMLButtonElement>('button[aria-label^="Jump to"]')
    expect(marks).toHaveLength(2)
    await act(async () => marks[1].click())
    const scroll = vi.mocked(Element.prototype.scrollIntoView)
    expect(scroll).toHaveBeenCalledTimes(1)
    expect((scroll.mock.contexts[0] as HTMLElement).dataset.chatNavigationId).toBe('u2')
    expect(scroll).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' })
  })
})
