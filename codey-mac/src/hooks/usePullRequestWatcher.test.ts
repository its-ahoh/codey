import { describe, it, expect } from 'vitest'
import { chatsNeedingPrRefresh, prStatusChanged, prWorkingDir } from './usePullRequestWatcher'
import type { Chat } from '../types'

const makeChat = (overrides: Partial<Chat> = {}): Chat => ({
  id: 'c1', title: 'Ship it', workspaceName: 'codey',
  selection: { type: 'none' }, createdAt: 1, updatedAt: 1, messages: [],
  ...overrides,
})

const pr = (overrides: Partial<NonNullable<Chat['pullRequest']>> = {}): NonNullable<Chat['pullRequest']> => ({
  url: 'https://github.com/o/r/pull/1', number: 1, state: 'pr-open', lastCheckedAt: 100, ...overrides,
})

describe('chatsNeedingPrRefresh', () => {
  it('picks chats with an open PR', () => {
    const open = makeChat({ id: 'open', pullRequest: pr() })
    const chats = [
      open,
      makeChat({ id: 'none' }),
      makeChat({ id: 'merged', pullRequest: pr({ state: 'merged' }) }),
      makeChat({ id: 'closed', pullRequest: pr({ state: 'closed-unmerged' }) }),
      makeChat({ id: 'changes', pullRequest: pr({ state: 'merged-with-changes' }) }),
    ]
    expect(chatsNeedingPrRefresh(chats)).toEqual([open])
  })

  it('skips an open PR with no url to check', () => {
    expect(chatsNeedingPrRefresh([makeChat({ pullRequest: pr({ url: '' }) })])).toEqual([])
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
