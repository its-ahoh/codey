import { describe, it, expect } from 'vitest'
import { deriveWorkerRuns } from './teamRunModel'
import type { ChatMessage } from '../types'

const teamTurn = (over: Partial<ChatMessage> = {}): ChatMessage => ({
  id: 't1', role: 'assistant', timestamp: 0, isComplete: true,
  content: '### Step 1: product-manager\n\nPM output here.\n\n---\n\n### Step 2: developer\n\n❌ Failed - build error',
  thinkingByStep: { 1: 'pm reasoning', 2: 'dev reasoning' },
  ...over,
})

describe('deriveWorkerRuns', () => {
  it('maps each step to a worker run with output and thinking', () => {
    const runs = deriveWorkerRuns(teamTurn(), false)
    expect(runs).toHaveLength(2)
    expect(runs[0]).toMatchObject({ step: 1, worker: 'product-manager', output: 'PM output here.', thinking: 'pm reasoning', status: 'done' })
    expect(runs[1]).toMatchObject({ step: 2, worker: 'developer', thinking: 'dev reasoning' })
  })

  it('marks the last step running while streaming', () => {
    const runs = deriveWorkerRuns(teamTurn(), true)
    expect(runs[1].status).toBe('running')
  })

  it('marks a failed-output step failed when not streaming', () => {
    const runs = deriveWorkerRuns(teamTurn(), false)
    expect(runs[1].status).toBe('failed')
  })

  it('returns [] for a non-team turn', () => {
    const runs = deriveWorkerRuns(teamTurn({ content: 'just a normal reply' }), false)
    expect(runs).toEqual([])
  })
})
