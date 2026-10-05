import React from 'react'
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { BotInteractionCard } from './BotInteractionCard'
import type { ChatMessage } from '../types'

const message: ChatMessage = { id: 'q', role: 'assistant', content: 'Database?', timestamp: 0,
  botInteraction: { id: 'q', bot: 'a', scope: 'bot', question: 'Database?', choices: ['SQLite', 'Postgres'], status: 'pending' } }

describe('independent Bot controls', () => {
  it('renders active choices without depending on the latest message or chat busy state', () => {
    const html = renderToStaticMarkup(React.createElement(BotInteractionCard, { chatId: 'c', message }))
    expect(html).toContain('SQLite')
    expect(html).toContain('Postgres')
    expect(html).toContain('Reply to a')
    expect(html).not.toContain('<button disabled="">SQLite')
  })
  it('shows permission controls separately from ordinary answers', () => {
    const html = renderToStaticMarkup(React.createElement(BotInteractionCard, { chatId: 'c', message: { ...message, botInteraction: { ...message.botInteraction!, permissionTools: ['Read'] } } }))
    expect(html).toContain('Allow and continue')
    expect(html).toContain('Deny')
    expect(html).not.toContain('>SQLite</button>')
  })
  it('removes actionable controls after cancellation', () => {
    const html = renderToStaticMarkup(React.createElement(BotInteractionCard, { chatId: 'c', message: { ...message, botInteraction: { ...message.botInteraction!, status: 'cancelled' } } }))
    expect(html).toContain('Cancelled')
    expect(html).not.toContain('<button')
  })
})
