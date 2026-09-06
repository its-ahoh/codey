import { describe, it, expect } from 'vitest'
import { groupMessages } from './teamGroup'
import type { ChatMessage } from '../types'
const m = (id: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({ id, role: 'assistant', content: id, timestamp: 0, ...extra })
describe('shared worker transcript', () => {
  it('keeps user messages, concurrent workers, and replies in order', () => {
    const messages = [m('u', { role: 'user' }), m('a', { teamTurnId: 't', worker: 'a' }), m('b', { teamTurnId: 't', worker: 'b' }), m('reply', { role: 'user' }), m('a2', { teamTurnId: 't', worker: 'a' })]
    expect(groupMessages(messages).map(x => x.message)).toEqual(messages)
  })
  it('suppresses only a verified duplicate combined transcript', () => {
    const worker = m('a', { teamTurnId: 't', worker: 'a', content: 'hello' })
    const footer = m('footer', { teamTurnId: 't', content: '### Step 1: a\n\nhello' })
    expect(groupMessages([worker, footer]).map(x => x.message.id)).toEqual(['a'])
    expect(groupMessages([footer]).map(x => x.message.id)).toEqual(['footer'])
    expect(groupMessages([worker, { ...footer, userQuestion: { question: 'Continue?', options: [] } }])).toHaveLength(2)
    expect(groupMessages([worker, { ...footer, content: 'Failed to finish' }])).toHaveLength(2)
  })
  it('retains plain chat and legacy history unchanged', () => {
    const messages = [m('plain'), m('legacy', { content: '### Step 1: a\n\nx' })]
    expect(groupMessages(messages).map(x => x.message)).toEqual(messages)
  })
})
