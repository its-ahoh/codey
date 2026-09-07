import { describe, it, expect } from 'vitest'
import { visibleChatCount } from './chatListVisible'

const chats = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `c${i}` }))

describe('visibleChatCount', () => {
  it('shows everything when the group fits under the limit', () => {
    expect(visibleChatCount(chats(3), 8, 0, null)).toBe(3)
  })

  it('cuts the group at the limit when folded', () => {
    expect(visibleChatCount(chats(20), 8, 0, null)).toBe(8)
  })

  it('grows by the revealed step instead of jumping to the end', () => {
    expect(visibleChatCount(chats(40), 8, 10, null)).toBe(18)
    expect(visibleChatCount(chats(40), 8, 20, null)).toBe(28)
  })

  it('stops at the group size once everything is revealed', () => {
    expect(visibleChatCount(chats(20), 8, 30, null)).toBe(20)
  })

  it('keeps an active chat that sits past the cut visible', () => {
    expect(visibleChatCount(chats(20), 8, 0, 'c12')).toBe(13)
  })

  it('ignores an active chat that is already above the cut', () => {
    expect(visibleChatCount(chats(20), 8, 0, 'c2')).toBe(8)
  })

  it('ignores an active chat from another workspace', () => {
    expect(visibleChatCount(chats(20), 8, 0, 'elsewhere')).toBe(8)
  })
})
