import { describe, it, expect } from 'vitest'
import { groupMessages, isLatestChatMessage } from './teamGroup'
import type { ChatMessage } from '../types'
const m = (id: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({ id, role: 'assistant', content: id, timestamp: 0, ...extra })
describe('shared bot transcript', () => {
  it('keeps user messages, concurrent bots, and replies in order', () => {
    const messages = [m('u', { role: 'user' }), m('a', { teamTurnId: 't', bot: 'a' }), m('b', { teamTurnId: 't', bot: 'b' }), m('reply', { role: 'user' }), m('a2', { teamTurnId: 't', bot: 'a' })]
    expect(groupMessages(messages).map(x => x.message)).toEqual(messages)
  })
  it('suppresses only a verified duplicate combined transcript', () => {
    const bot = m('a', { teamTurnId: 't', bot: 'a', content: 'hello' })
    const footer = m('footer', { teamTurnId: 't', content: '### Step 1: a\n\nhello' })
    expect(groupMessages([bot, footer]).map(x => x.message.id)).toEqual(['a'])
    expect(groupMessages([footer]).map(x => x.message.id)).toEqual(['footer'])
    expect(groupMessages([bot, { ...footer, userQuestion: { question: 'Continue?', options: [] } }])).toHaveLength(2)
    expect(groupMessages([bot, { ...footer, content: 'Failed to finish' }])).toHaveLength(2)
  })
  it('retains plain chat and legacy history unchanged', () => {
    const messages = [m('plain'), m('legacy', { content: '### Step 1: a\n\nx' })]
    expect(groupMessages(messages).map(x => x.message)).toEqual(messages)
  })
})

it('keeps controls on the latest message after pending team members are hidden', () => {
  const messages = [m('pending', { teamTurnId: 't', bot: 'b', botStatus: 'pending' }),
    m('question', { teamTurnId: 't', choices: ['Yes', 'No'] })];
  const visible = groupMessages(messages);
  expect(visible).toHaveLength(1);
  expect(isLatestChatMessage(visible[0].message, messages)).toBe(true);
  expect(isLatestChatMessage(visible[0].message, [...messages, m('answer', { role: 'user' })])).toBe(false);
});
