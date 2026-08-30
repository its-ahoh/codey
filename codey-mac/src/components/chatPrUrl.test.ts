import { describe, expect, it } from 'vitest'
import { chatOwnedPrUrl } from './chatPrUrl'
import type { Chat, ChatMessage } from '../types'

const message = (role: ChatMessage['role'], content: string, id = content.slice(0, 8)): ChatMessage =>
  ({ id, role, content, timestamp: 1 })

const chat = (messages: ChatMessage[]): Chat => ({
  id: 'c1', title: 'Ship it', workspaceName: 'codey',
  selection: { type: 'none' }, createdAt: 1, updatedAt: 1, messages,
})

describe('chatOwnedPrUrl', () => {
  it('finds the PR the agent reported', () => {
    expect(chatOwnedPrUrl(chat([
      message('user', 'open a pr'),
      message('assistant', 'PR is up: https://github.com/its-ahoh/codey/pull/376\n\nMerge when green.'),
    ]))).toBe('https://github.com/its-ahoh/codey/pull/376')
  })

  it('takes the newest mention when the chat opened a second PR', () => {
    expect(chatOwnedPrUrl(chat([
      message('assistant', 'https://github.com/its-ahoh/codey/pull/374', 'a1'),
      message('user', 'another one'),
      message('assistant', 'https://github.com/its-ahoh/codey/pull/376', 'a2'),
    ]))).toBe('https://github.com/its-ahoh/codey/pull/376')
  })

  it('takes the last url within a single reply', () => {
    expect(chatOwnedPrUrl(chat([
      message('assistant', 'rebased on https://github.com/its-ahoh/codey/pull/370, opened https://github.com/its-ahoh/codey/pull/376'),
    ]))).toBe('https://github.com/its-ahoh/codey/pull/376')
  })

  it('ignores a PR the user pasted — that is usually somebody else’s', () => {
    expect(chatOwnedPrUrl(chat([
      message('user', 'review https://github.com/its-ahoh/codey/pull/370'),
      message('assistant', 'Looks fine to me.'),
    ]))).toBeUndefined()
  })

  it('ignores links that are not pull requests', () => {
    expect(chatOwnedPrUrl(chat([
      message('assistant', 'see https://github.com/its-ahoh/codey/issues/376 and https://github.com/its-ahoh/codey'),
    ]))).toBeUndefined()
  })

  it('is quiet on an empty chat', () => {
    expect(chatOwnedPrUrl(chat([]))).toBeUndefined()
    expect(chatOwnedPrUrl(undefined)).toBeUndefined()
  })
})
