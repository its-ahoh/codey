import { describe, expect, it } from 'vitest'
import { chatInputHistory, moveInInputHistory } from './chatInputHistory'

describe('chat composer input history', () => {
  const messages = [
    { role: 'user' as const, content: 'first' },
    { role: 'assistant' as const, content: 'answer' },
    { role: 'user' as const, content: 'second\nline' },
  ]

  it('keeps only user input from the current chat', () => {
    expect(chatInputHistory(messages)).toEqual(['first', 'second\nline'])
  })

  it('moves newest-to-oldest with up and returns to blank with down', () => {
    const history = chatInputHistory(messages)
    expect(moveInInputHistory(history, null, 'up')).toEqual({ index: 1, value: 'second\nline' })
    expect(moveInInputHistory(history, 1, 'up')).toEqual({ index: 0, value: 'first' })
    expect(moveInInputHistory(history, 0, 'down')).toEqual({ index: 1, value: 'second\nline' })
    expect(moveInInputHistory(history, 1, 'down')).toEqual({ index: null, value: '' })
  })
})
