import { describe, it, expect } from 'vitest'
import { pickChangeSource } from './changeSource'
import type { WriteDiff } from '../types'

const rec = (added: number, removed: number, patch?: string, truncated?: boolean): WriteDiff =>
  ({ path: '/w/a.ts', added, removed, patch, blob: 'x', truncated })

const git = { added: 4, removed: 2, patch: '@@ git @@', isNew: false }

describe('pickChangeSource', () => {
  it('returns null when nothing is known', () => {
    expect(pickChangeSource('all', undefined, undefined)).toBeNull()
    expect(pickChangeSource('all', [], undefined)).toBeNull()
  })

  it('all: prefers the working-tree diff, the net change since the last commit', () => {
    const r = pickChangeSource('all', [rec(1, 1, '@@ rec @@')], git)
    expect(r).toEqual({ added: 4, removed: 2, patches: ['@@ git @@'], truncated: false })
  })

  it('all: falls back to the recorded diffs once the work is committed', () => {
    // git diff HEAD is empty after the agent commits, but the chat still
    // changed the file: sum every recorded write.
    const r = pickChangeSource('all', [rec(3, 0, '@@ one @@'), rec(2, 1, '@@ two @@')], undefined)
    expect(r).toEqual({ added: 5, removed: 1, patches: ['@@ one @@', '@@ two @@'], truncated: false })
  })

  it('turn: prefers the recorded diffs, which are that turn alone', () => {
    const r = pickChangeSource('turn', [rec(1, 1, '@@ rec @@')], git)
    expect(r).toEqual({ added: 1, removed: 1, patches: ['@@ rec @@'], truncated: false })
  })

  it('turn: falls back to git for chats recorded before diffs existed', () => {
    expect(pickChangeSource('turn', [], git)).toEqual({ added: 4, removed: 2, patches: ['@@ git @@'], truncated: false })
  })

  it('keeps counts but no patch for truncated or binary writes', () => {
    const r = pickChangeSource('turn', [rec(9, 9, undefined, true), rec(1, 0, '@@ p @@')], undefined)
    expect(r).toEqual({ added: 10, removed: 9, patches: ['@@ p @@'], truncated: true })
  })
})
