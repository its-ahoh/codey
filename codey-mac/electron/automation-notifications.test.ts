import { describe, it, expect } from 'vitest'
import { decideAutomationNotification, findUnseenRuns } from './automation-notifications'

const auto = (over: any = {}) => ({
  id: 'a1', name: 'Morning news', report: { notify: 'all' }, ...over,
})
const run = (over: any = {}) => ({
  runId: 'r1', startedAt: 1000, endedAt: 2000, status: 'success',
  trigger: 'schedule', output: 'Posted 5 items.', ...over,
})

describe('decideAutomationNotification', () => {
  it('notifies on finished runs when notify is "all"', () => {
    const d = decideAutomationNotification(auto(), run())
    expect(d).toMatchObject({ title: expect.stringContaining('Morning news') })
    expect(d!.body).toContain('Posted 5 items.')
  })
  it('returns null when notify is "none" or unrecognized (pre-mode boolean)', () => {
    expect(decideAutomationNotification(auto({ report: { notify: 'none' } }), run())).toBeNull()
    expect(decideAutomationNotification(auto({ report: { notify: true } }), run())).toBeNull()
  })
  it('"failure" notifies on failed and parked runs only', () => {
    const a = auto({ report: { notify: 'failure' } })
    expect(decideAutomationNotification(a, run())).toBeNull()
    expect(decideAutomationNotification(a, run({ status: 'failed', error: 'boom' }))).not.toBeNull()
    expect(decideAutomationNotification(a, run({ status: 'parked', question: 'Which account?' }))).not.toBeNull()
  })
  it('"success" notifies on successful runs only', () => {
    const a = auto({ report: { notify: 'success' } })
    expect(decideAutomationNotification(a, run())).not.toBeNull()
    expect(decideAutomationNotification(a, run({ status: 'failed', error: 'boom' }))).toBeNull()
    expect(decideAutomationNotification(a, run({ status: 'parked', question: 'Which account?' }))).toBeNull()
  })
  it('surfaces the parked question', () => {
    const d = decideAutomationNotification(auto(), run({ status: 'parked', question: 'Which account?' }))
    expect(d!.body).toContain('Which account?')
  })
})

describe('findUnseenRuns', () => {
  it('returns unseen, ended, recent runs only', () => {
    const now = 100 * 3600_000
    const runs = [
      run({ runId: 'seen', seenAt: 5 }),
      run({ runId: 'old', endedAt: now - 25 * 3600_000 }),
      run({ runId: 'active', endedAt: undefined }),
      run({ runId: 'fresh', endedAt: now - 3600_000 }),
    ]
    expect(findUnseenRuns(runs, now).map(r => r.runId)).toEqual(['fresh'])
  })
})
