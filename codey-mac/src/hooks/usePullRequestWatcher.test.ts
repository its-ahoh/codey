import { describe, it, expect } from 'vitest'
import { chatsWithTrackedPr, needsPrRefresh, prStatusChanged, prWorkingDir } from './usePullRequestWatcher'
import type { Chat } from '../types'

const makeChat = (overrides: Partial<Chat> = {}): Chat => ({
  id: 'c1', title: 'Ship it', workspaceName: 'codey',
  selection: { type: 'none' }, createdAt: 1, updatedAt: 1, messages: [],
  ...overrides,
})

const pr = (overrides: Partial<NonNullable<Chat['pullRequest']>> = {}): NonNullable<Chat['pullRequest']> => ({
  url: 'https://github.com/o/r/pull/1', number: 1, state: 'pr-open', lastCheckedAt: 100, ...overrides,
})

describe('chatsWithTrackedPr', () => {
  it('picks chats carrying a PR url', () => {
    const open = makeChat({ id: 'open', pullRequest: pr() })
    const merged = makeChat({ id: 'merged', pullRequest: pr({ state: 'merged' }) })
    const chats = [open, makeChat({ id: 'none' }), merged, makeChat({ id: 'urlless', pullRequest: pr({ url: '' }) })]
    expect(chatsWithTrackedPr(chats)).toEqual([open, merged])
  })
})

describe('needsPrRefresh', () => {
  it('always checks an open PR', () => {
    expect(needsPrRefresh(pr(), 'feature')).toBe(true)
  })

  it('skips a merged PR while the checkout is still on its branch', () => {
    expect(needsPrRefresh(pr({ state: 'merged', headBranch: 'feature' }), 'feature')).toBe(false)
  })

  it('re-checks a merged PR once a chat-owned checkout moved to another branch', () => {
    expect(needsPrRefresh(pr({ state: 'merged', headBranch: 'shipped' }), 'next-thing', true)).toBe(true)
  })

  it('leaves a terminal PR alone in a shared checkout, whoever moved the branch', () => {
    expect(needsPrRefresh(pr({ state: 'merged', headBranch: 'shipped' }), 'next-thing')).toBe(false)
  })

  it('leaves a terminal PR alone when the branch is unknown or detached', () => {
    const merged = pr({ state: 'merged', headBranch: 'shipped' })
    expect(needsPrRefresh(merged, undefined, true)).toBe(false)
    expect(needsPrRefresh(merged, 'HEAD', true)).toBe(false)
    expect(needsPrRefresh(pr({ state: 'merged' }), 'next-thing', true)).toBe(false)
  })

  it('ignores chats with no PR', () => {
    expect(needsPrRefresh(undefined, 'feature')).toBe(false)
  })
})

describe('prStatusChanged', () => {
  it('ignores a poll that only moved lastCheckedAt', () => {
    expect(prStatusChanged(pr(), pr({ lastCheckedAt: 999 }))).toBe(false)
  })

  it('reports a merge', () => {
    expect(prStatusChanged(pr(), pr({ state: 'merged', mergedAt: 500 }))).toBe(true)
  })

  it('reports a new head commit on the same state', () => {
    expect(prStatusChanged(pr({ headCommit: 'aaa' }), pr({ headCommit: 'bbb' }))).toBe(true)
  })
})

describe('prWorkingDir', () => {
  const dirs = { codey: '/repo/codey' }

  it('uses the worktree dir for isolated chats', () => {
    const chat = makeChat({
      executionMode: 'isolated-worktree',
      chatWorkspace: {
        repositoryRoot: '/repo/codey', worktreePath: '/wt/x', workingDir: '/wt/x',
        baseCommit: 'abc', createdAt: 1,
      },
    })
    expect(prWorkingDir(chat, dirs)).toBe('/wt/x')
  })

  it('prefers a per-chat override over the workspace dir', () => {
    expect(prWorkingDir(makeChat({ workingDirOverride: '/other' }), dirs)).toBe('/other')
  })

  it('falls back to the workspace dir', () => {
    expect(prWorkingDir(makeChat(), dirs)).toBe('/repo/codey')
  })

  it('returns undefined when the workspace dir is unknown', () => {
    expect(prWorkingDir(makeChat({ workspaceName: 'ghost' }), dirs)).toBeUndefined()
  })
})
