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

  // Authored-graph (Sequential) teams emit the "flow results" / **worker**:
  // transcript, not the `### Step` format. deriveWorkerRuns must handle it too.
  it('derives runs from the Sequential "flow results" transcript', () => {
    const content = [
      '📊 Team **Feature** flow results',
      '',
      '**product-manager**:',
      'PM output here.',
      '',
      '**developer**: ❌ Failed - build error',
    ].join('\n')
    const runs = deriveWorkerRuns(teamTurn({ content, thinkingByStep: undefined }), false)
    expect(runs).toHaveLength(2)
    expect(runs[0]).toMatchObject({ step: 1, worker: 'product-manager', output: 'PM output here.', status: 'done' })
    expect(runs[1]).toMatchObject({ step: 2, worker: 'developer', status: 'failed' })
  })
})

import { synthesizeChainGraph, nodeStatuses } from './teamRunModel'
import type { WorkerRun } from './teamRunModel'
import { validateGraph } from '../../../packages/core/src/team-graph'

const run = (step: number, worker: string, status: WorkerRun['status']): WorkerRun =>
  ({ step, worker, status, output: 'o' })

describe('synthesizeChainGraph', () => {
  it('builds start -> w1 -> w2 -> end and validates', () => {
    const runs = [run(1, 'pm', 'done'), run(2, 'dev', 'running')]
    const g = synthesizeChainGraph(runs)
    expect(g.entry).toBe('start')
    expect(g.nodes.find(n => n.type === 'start')).toBeTruthy()
    expect(g.nodes.find(n => n.type === 'end')).toBeTruthy()
    expect(g.nodes.filter(n => n.type === 'worker').map(n => n.worker)).toEqual(['pm', 'dev'])
    expect(validateGraph(g, ['pm', 'dev'])).toEqual([])
  })

  it('dedupes a revisited worker into one node', () => {
    const g = synthesizeChainGraph([run(1, 'pm', 'done'), run(2, 'dev', 'done'), run(3, 'pm', 'done')])
    expect(g.nodes.filter(n => n.type === 'worker')).toHaveLength(2)
  })
})

describe('nodeStatuses', () => {
  it('maps run status onto matching worker nodes, pending for unreached', () => {
    const runs = [run(1, 'pm', 'done')]
    const g = synthesizeChainGraph([run(1, 'pm', 'done'), run(2, 'dev', 'done')])
    const st = nodeStatuses(g, runs)
    const pmNode = g.nodes.find(n => n.worker === 'pm')!
    const devNode = g.nodes.find(n => n.worker === 'dev')!
    expect(st[pmNode.id]).toBe('done')
    expect(st[devNode.id]).toBe('pending')
  })

  it('marks the asking worker askedUser', () => {
    const g = synthesizeChainGraph([run(1, 'pm', 'done'), run(2, 'dev', 'running')])
    const st = nodeStatuses(g, [run(1, 'pm', 'done'), run(2, 'dev', 'running')], 'dev')
    const devNode = g.nodes.find(n => n.worker === 'dev')!
    expect(st[devNode.id]).toBe('askedUser')
  })

  it('end is pending while a run is running, done otherwise', () => {
    const g = synthesizeChainGraph([run(1, 'pm', 'done')])
    const endId = g.nodes.find(n => n.type === 'end')!.id
    expect(nodeStatuses(g, [run(1, 'pm', 'running')])[endId]).toBe('pending')
    expect(nodeStatuses(g, [run(1, 'pm', 'done')])[endId]).toBe('done')
  })
})
