import { describe, it, expect } from 'vitest'
import { deriveBotRuns, groupTeamMessagesByMember, teamFinalAnswer } from './teamRunModel'
import type { ChatMessage } from '../types'

const teamTurn = (over: Partial<ChatMessage> = {}): ChatMessage => ({
  id: 't1', role: 'assistant', timestamp: 0, isComplete: true,
  content: '### Step 1: product-manager\n\nPM output here.\n\n---\n\n### Step 2: developer\n\n❌ Failed - build error',
  thinkingByStep: { 1: 'pm reasoning', 2: 'dev reasoning' },
  ...over,
})

describe('deriveBotRuns', () => {
  it('maps each step to a bot run with output and thinking', () => {
    const runs = deriveBotRuns(teamTurn(), false)
    expect(runs).toHaveLength(2)
    expect(runs[0]).toMatchObject({ step: 1, bot: 'product-manager', output: 'PM output here.', thinking: 'pm reasoning', status: 'done' })
    expect(runs[1]).toMatchObject({ step: 2, bot: 'developer', thinking: 'dev reasoning' })
  })

  it('marks the last step running while streaming', () => {
    const runs = deriveBotRuns(teamTurn(), true)
    expect(runs[1].status).toBe('running')
  })

  it('marks a failed-output step failed when not streaming', () => {
    const runs = deriveBotRuns(teamTurn(), false)
    expect(runs[1].status).toBe('failed')
  })

  it('returns [] for a non-team turn', () => {
    const runs = deriveBotRuns(teamTurn({ content: 'just a normal reply' }), false)
    expect(runs).toEqual([])
  })

  // Mid-run, the Sequential transcript has no `**bot**:` structure yet —
  // only live `info` step markers exist. deriveBotRuns must surface those so
  // the overlay can highlight the active bot live.
  it('derives live bot runs from info step markers when content is unstructured', () => {
    const turn = teamTurn({
      content: 'raw streamed tokens with no bot headers yet',
      thinkingByStep: undefined,
      toolCalls: [
        { id: 'a', type: 'info', message: '🔄 Step 1: **product-manager** is working...' },
        { id: 'b', type: 'info', message: '🔄 Step 2: **architect** is working...' },
      ] as any,
    })
    const runs = deriveBotRuns(turn, true)
    expect(runs).toHaveLength(2)
    expect(runs[0]).toMatchObject({ step: 1, bot: 'product-manager', status: 'done' })
    expect(runs[1]).toMatchObject({ step: 2, bot: 'architect', status: 'running' })
  })

  it('merges live info steps with structured output (output wins, live fills the running step)', () => {
    const turn = teamTurn({
      content: '📊 Team **Feature** flow results\n\n**product-manager**:\nPM done.',
      thinkingByStep: undefined,
      toolCalls: [
        { id: 'a', type: 'info', message: '🔄 Step 1: **product-manager** is working...' },
        { id: 'b', type: 'info', message: '🔄 Step 2: **architect** is working...' },
      ] as any,
    })
    const runs = deriveBotRuns(turn, true)
    expect(runs).toHaveLength(2)
    expect(runs[0]).toMatchObject({ step: 1, bot: 'product-manager', output: 'PM done.', status: 'done' })
    expect(runs[1]).toMatchObject({ step: 2, bot: 'architect', output: '', status: 'running' })
  })

  it('parses the auto-path info marker (Step N: bot — reason)', () => {
    const turn = teamTurn({
      content: 'unstructured', thinkingByStep: undefined,
      toolCalls: [{ id: 'a', type: 'info', message: 'Step 1: alice — picked alice to start' }] as any,
    })
    const runs = deriveBotRuns(turn, true)
    expect(runs[0]).toMatchObject({ step: 1, bot: 'alice', status: 'running' })
  })

  // Authored-graph (Sequential) teams emit the "flow results" / **bot**:
  // transcript, not the `### Step` format. deriveBotRuns must handle it too.
  it('derives runs from the Sequential "flow results" transcript', () => {
    const content = [
      '📊 Team **Feature** flow results',
      '',
      '**product-manager**:',
      'PM output here.',
      '',
      '**developer**: ❌ Failed - build error',
    ].join('\n')
    const runs = deriveBotRuns(teamTurn({ content, thinkingByStep: undefined }), false)
    expect(runs).toHaveLength(2)
    expect(runs[0]).toMatchObject({ step: 1, bot: 'product-manager', output: 'PM output here.', status: 'done' })
    expect(runs[1]).toMatchObject({ step: 2, bot: 'developer', status: 'failed' })
  })
})

import { synthesizeChainGraph, nodeStatuses, toolCallsForStep, deriveBotRunsFromGroup } from './teamRunModel'
import type { BotRun } from './teamRunModel'
import { validateGraph } from '../../../packages/core/src/team-graph'

const w = (step: number, bot: string, status: any, content: string): ChatMessage =>
  ({ id: `w${step}`, role: 'assistant', content, timestamp: 0, teamTurnId: 'tt', bot, step, botStatus: status })

describe('deriveBotRunsFromGroup', () => {
  it('builds ordered runs from the group, carrying status + output', () => {
    const runs = deriveBotRunsFromGroup([w(2, 'b', 'running', 'B'), w(1, 'a', 'done', 'A')])
    expect(runs.map(r => [r.step, r.bot, r.status, r.output])).toEqual([
      [1, 'a', 'done', 'A'], [2, 'b', 'running', 'B'],
    ])
  })
})

describe('groupTeamMessagesByMember', () => {
  it('collects revisited bots into ordered rounds and preserves member order', () => {
    const groups = groupTeamMessagesByMember([
      w(1, 'pm', 'done', 'scope'),
      w(4, 'architect', 'done', 'revision'),
      w(2, 'architect', 'done', 'design'),
      w(3, 'developer', 'running', 'build'),
    ])
    expect(groups.map(group => [group.bot, group.messages.map(message => message.step)])).toEqual([
      ['pm', [1]], ['architect', [2, 4]], ['developer', [3]],
    ])
    expect(groups[1].latest.content).toBe('revision')
    expect(groups[2].status).toBe('running')
  })

  it('keeps roster-only members visible as pending', () => {
    const groups = groupTeamMessagesByMember([
      w(1, 'pm', 'running', ''),
      w(2, 'developer', 'pending', ''),
    ])
    expect(groups.map(group => [group.bot, group.status])).toEqual([
      ['pm', 'running'], ['developer', 'pending'],
    ])
  })
})

describe('toolCallsForStep', () => {
  const calls = [
    { id: 'm1', type: 'info', message: '🔄 Step 1: **product-manager** is working...' },
    { id: 't1', type: 'tool_start', tool: 'Read', message: 'reading spec', input: { file: 'a' } },
    { id: 't1', type: 'tool_end', tool: 'Read', output: 'contents' },
    { id: 'm2', type: 'info', message: '🔄 Step 2: **developer** is working...' },
    { id: 't2', type: 'tool_start', tool: 'Edit', message: 'editing' },
  ] as any

  it('returns only the tool calls that belong to a step', () => {
    expect(toolCallsForStep(calls, 1).map(c => c.id)).toEqual(['t1', 't1'])
    expect(toolCallsForStep(calls, 2).map(c => c.id)).toEqual(['t2'])
  })

  it('excludes the info step markers themselves', () => {
    expect(toolCallsForStep(calls, 1).some(c => c.type === 'info')).toBe(false)
  })

  it('returns [] for a step with no tool calls or missing toolCalls', () => {
    expect(toolCallsForStep(calls, 3)).toEqual([])
    expect(toolCallsForStep(undefined, 1)).toEqual([])
  })
})

const run = (step: number, bot: string, status: BotRun['status']): BotRun =>
  ({ step, bot, status, output: 'o' })

describe('synthesizeChainGraph', () => {
  it('builds start -> w1 -> w2 -> end and validates', () => {
    const runs = [run(1, 'pm', 'done'), run(2, 'dev', 'running')]
    const g = synthesizeChainGraph(runs)
    expect(g.entry).toBe('start')
    expect(g.nodes.find(n => n.type === 'start')).toBeTruthy()
    expect(g.nodes.find(n => n.type === 'end')).toBeTruthy()
    expect(g.nodes.filter(n => n.type === 'bot').map(n => n.bot)).toEqual(['pm', 'dev'])
    expect(validateGraph(g, ['pm', 'dev'])).toEqual([])
  })

  it('dedupes a revisited bot into one node', () => {
    const g = synthesizeChainGraph([run(1, 'pm', 'done'), run(2, 'dev', 'done'), run(3, 'pm', 'done')])
    expect(g.nodes.filter(n => n.type === 'bot')).toHaveLength(2)
  })
})

describe('nodeStatuses', () => {
  it('maps run status onto matching bot nodes, pending for unreached', () => {
    const runs = [run(1, 'pm', 'done')]
    const g = synthesizeChainGraph([run(1, 'pm', 'done'), run(2, 'dev', 'done')])
    const st = nodeStatuses(g, runs)
    const pmNode = g.nodes.find(n => n.bot === 'pm')!
    const devNode = g.nodes.find(n => n.bot === 'dev')!
    expect(st[pmNode.id]).toBe('done')
    expect(st[devNode.id]).toBe('pending')
  })

  it('marks the asking bot askedUser', () => {
    const g = synthesizeChainGraph([run(1, 'pm', 'done'), run(2, 'dev', 'running')])
    const st = nodeStatuses(g, [run(1, 'pm', 'done'), run(2, 'dev', 'running')], 'dev')
    const devNode = g.nodes.find(n => n.bot === 'dev')!
    expect(st[devNode.id]).toBe('askedUser')
  })

  it('end is pending while a run is running, done otherwise', () => {
    const g = synthesizeChainGraph([run(1, 'pm', 'done')])
    const endId = g.nodes.find(n => n.type === 'end')!.id
    expect(nodeStatuses(g, [run(1, 'pm', 'running')])[endId]).toBe('pending')
    expect(nodeStatuses(g, [run(1, 'pm', 'done')])[endId]).toBe('done')
  })
})

describe('teamFinalAnswer', () => {
  const bot = (over: Partial<ChatMessage>): ChatMessage => ({
    id: over.id ?? `w-${over.step}`, role: 'assistant', timestamp: 0, isComplete: true,
    content: '', teamTurnId: 'tt1', ...over,
  })

  it('returns null while any bot is still running', () => {
    const msgs = [
      bot({ step: 1, bot: 'a', botStatus: 'done', content: 'first' }),
      bot({ step: 2, bot: 'b', botStatus: 'running', content: '' }),
    ]
    expect(teamFinalAnswer(msgs, 'auto')).toBeNull()
  })

  it('returns null while a bot is waiting on the user', () => {
    const msgs = [bot({ step: 1, bot: 'a', botStatus: 'askedUser', content: 'Which one?' })]
    expect(teamFinalAnswer(msgs, 'sequential')).toBeNull()
  })

  it('uses the last finished bot output for auto and sequential, without whiteboard markers', () => {
    const msgs = [
      bot({ step: 1, bot: 'a', botStatus: 'done', content: 'first' }),
      bot({ step: 2, bot: 'b', botStatus: 'done', content: 'Final answer.\n\n[FACT]: seen' }),
      bot({ id: 'footer', botStatus: undefined, content: '📊 Team **t** results\n\n**a**: first\n\n**b**: Final answer.' }),
    ]
    expect(teamFinalAnswer(msgs, 'auto')).toEqual({ bot: 'b', text: 'Final answer.' })
    expect(teamFinalAnswer(msgs, 'sequential')).toEqual({ bot: 'b', text: 'Final answer.' })
  })

  it('surfaces a failed last bot as the answer', () => {
    const msgs = [bot({ step: 1, bot: 'a', botStatus: 'failed', content: '❌ build broke' })]
    expect(teamFinalAnswer(msgs, 'auto')).toEqual({ bot: 'a', text: '❌ build broke' })
  })

  it('uses the Advisor summary for roundtable', () => {
    const footer = [
      '🪑 Roundtable: **t**', 'Termination reason: consensus', '',
      '## Advisor Summary', 'We agree on X.', '',
      '## Viewpoints', '**a**: yes', '', 'Done.',
    ].join('\n')
    const msgs = [
      bot({ step: 1, bot: 'a', botStatus: 'done', content: 'yes' }),
      bot({ id: 'footer', botStatus: undefined, content: footer }),
    ]
    expect(teamFinalAnswer(msgs, 'roundtable')).toEqual({ bot: 'Advisor', text: 'We agree on X.' })
  })

  it('returns null for an empty run', () => {
    expect(teamFinalAnswer([], 'auto')).toBeNull()
  })

  it('ignores unselected pending roster members after a serial run finishes', () => {
    const msgs = [
      bot({ step: 1, bot: 'a', botStatus: 'done', content: 'Final answer.' }),
      bot({ step: 2, bot: 'b', botStatus: 'pending', content: '' }),
    ]
    expect(teamFinalAnswer(msgs, 'auto')).toEqual({ bot: 'a', text: 'Final answer.' })
  })
})
