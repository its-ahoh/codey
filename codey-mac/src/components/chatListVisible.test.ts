import { describe, it, expect } from 'vitest'
import { visibleChatCount } from './chatListVisible'

const chats = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `c${i}` }))

describe('visibleChatCount', () => {
  it('shows everything when the group fits under the limit', () => {
    expect(visibleChatCount(chats(3), 8, false, null)).toBe(3)
  })

  it('cuts the group at the limit when folded', () => {
    expect(visibleChatCount(chats(20), 8, false, null)).toBe(8)
  })

  it('shows everything once expanded', () => {
    expect(visibleChatCount(chats(20), 8, true, null)).toBe(20)
  })

  it('keeps an active chat that sits past the cut visible', () => {
    expect(visibleChatCount(chats(20), 8, false, 'c12')).toBe(13)
  })

  it('ignores an active chat that is already above the cut', () => {
    expect(visibleChatCount(chats(20), 8, false, 'c2')).toBe(8)
  })

  it('ignores an active chat from another workspace', () => {
    expect(visibleChatCount(chats(20), 8, false, 'elsewhere')).toBe(8)
  })
})
