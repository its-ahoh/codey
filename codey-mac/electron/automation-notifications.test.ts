import { describe, it, expect } from 'vitest'
import { decideAutomationNotification, findUnseenRuns } from './automation-notifications'

const auto = (over: any = {}) => ({
  id: 'a1', name: 'Morning news', report: { notify: true }, ...over,
})
const run = (over: any = {}) => ({
  runId: 'r1', startedAt: 1000, endedAt: 2000, status: 'success',
  trigger: 'schedule', output: 'Posted 5 items.', ...over,
})

describe('decideAutomationNotification', () => {
  it('notifies on finished runs when report.notify is on', () => {
    const d = decideAutomationNotification(auto(), run())
    expect(d).toMatchObject({ title: expect.stringContaining('Morning news') })
    expect(d!.body).toContain('Posted 5 items.')
  })
  it('returns null when notify is off', () => {
    expect(decideAutomationNotification(auto({ report: { notify: false } }), run())).toBeNull()
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
