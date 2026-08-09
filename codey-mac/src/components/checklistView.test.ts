import { describe, expect, it } from 'vitest'
import type { ChecklistItem, ToolCallEntry } from '../types'
import {
  activeToolHeadline,
  checklistProgress,
  checklistWindow,
  currentChecklistItem,
  currentItemLabel,
  statusLine,
} from './checklistView'

const item = (text: string, status: ChecklistItem['status'], activeForm?: string): ChecklistItem =>
  ({ text, status, ...(activeForm ? { activeForm } : {}) })

const start = (tool: string, input?: Record<string, unknown>): ToolCallEntry =>
  ({ id: `s-${tool}`, type: 'tool_start', tool, message: '', input })
const end = (tool: string): ToolCallEntry =>
  ({ id: `e-${tool}`, type: 'tool_end', tool, message: '' })
const info = (): ToolCallEntry => ({ id: 'i', type: 'info', message: 'note' })

const headline = (tool: string, input?: Record<string, unknown>) =>
  input?.file_path ? `${tool}(${input.file_path})` : tool

describe('checklistProgress', () => {
  it('counts only completed items', () => {
    const p = checklistProgress([
      item('a', 'completed'), item('b', 'in_progress'), item('c', 'pending'),
    ])
    expect(p).toEqual({ done: 1, total: 3, percent: 33, label: '1/3' })
  })

  it('reports 0% rather than dividing by zero on an empty list', () => {
    expect(checklistProgress([])).toEqual({ done: 0, total: 0, percent: 0, label: '0/0' })
  })

  it('reaches 100% only when every item is done', () => {
    expect(checklistProgress([item('a', 'completed'), item('b', 'completed')]).percent).toBe(100)
  })
})

describe('currentChecklistItem', () => {
  it('takes the declared in_progress item as fact', () => {
    const items = [item('a', 'completed'), item('b', 'in_progress'), item('c', 'pending')]
    expect(currentChecklistItem(items)).toEqual({ item: items[1], index: 1, inferred: false })
  })

  it('falls back to the first unfinished item and marks it a guess', () => {
    // Codex's shape: booleans only, so nothing is ever in_progress.
    const items = [item('a', 'completed'), item('b', 'pending'), item('c', 'pending')]
    expect(currentChecklistItem(items)).toEqual({ item: items[1], index: 1, inferred: true })
  })

  it('returns null when the list is finished', () => {
    expect(currentChecklistItem([item('a', 'completed')])).toBeNull()
  })

  it('prefers a declared in_progress item even when an earlier one is pending', () => {
    const items = [item('a', 'pending'), item('b', 'in_progress')]
    expect(currentChecklistItem(items)?.index).toBe(1)
  })
})

describe('currentItemLabel', () => {
  it('uses activeForm when the agent wrote one', () => {
    expect(currentItemLabel(item('Implement it', 'in_progress', 'Implementing it'))).toBe('Implementing it')
  })

  it('falls back to the imperative content rather than rewriting the tense', () => {
    expect(currentItemLabel(item('Implement it', 'in_progress'))).toBe('Implement it')
  })
})

describe('activeToolHeadline', () => {
  it('names the tool that is still running', () => {
    expect(activeToolHeadline([start('Edit', { file_path: 'a.ts' })], headline)).toBe('Edit(a.ts)')
  })

  it('goes quiet once the tool finished', () => {
    expect(activeToolHeadline([start('Edit'), end('Edit')], headline)).toBeUndefined()
  })

  it('ignores info entries when deciding what is running', () => {
    expect(activeToolHeadline([start('Read'), info()], headline)).toBe('Read')
  })

  it('handles no entries at all', () => {
    expect(activeToolHeadline(undefined, headline)).toBeUndefined()
  })
})

describe('checklistWindow', () => {
  const many = (n: number, currentAt: number) =>
    Array.from({ length: n }, (_, i) =>
      item(`t${i}`, i === currentAt ? 'in_progress' : i < currentAt ? 'completed' : 'pending'))

  it('shows a short list whole', () => {
    const items = many(4, 1)
    expect(checklistWindow(items)).toEqual({ shown: items, hiddenBefore: 0, hiddenAfter: 0 })
  })

  it('keeps one finished line above the current item', () => {
    const w = checklistWindow(many(12, 5))
    expect(w.shown.map(i => i.text)).toEqual(['t4', 't5', 't6', 't7', 't8', 't9'])
    expect(w).toMatchObject({ hiddenBefore: 4, hiddenAfter: 2 })
  })

  it('does not scroll past the end for a current item near the tail', () => {
    const w = checklistWindow(many(10, 9))
    expect(w.shown.map(i => i.text)).toEqual(['t4', 't5', 't6', 't7', 't8', 't9'])
    expect(w.hiddenAfter).toBe(0)
  })

  it('anchors on the last item when the list is finished', () => {
    const done = Array.from({ length: 9 }, (_, i) => item(`t${i}`, 'completed'))
    const w = checklistWindow(done)
    expect(w.shown.map(i => i.text)).toEqual(['t3', 't4', 't5', 't6', 't7', 't8'])
    expect(w.hiddenAfter).toBe(0)
  })
})

describe('statusLine', () => {
  const items = [
    item('Set up', 'completed'),
    item('Implement the reducer', 'in_progress', 'Implementing the reducer'),
    item('Test it', 'pending'),
  ]

  it('joins what, how and how far', () => {
    const line = statusLine({
      checklist: items, entries: [start('Edit', { file_path: 'sessionReducer.ts' })],
      format: headline, fallback: 'Working',
    })
    expect(line.parts).toEqual(['Implementing the reducer', 'Edit(sessionReducer.ts)', '1/3'])
    expect(line.inferred).toBe(false)
  })

  it('keeps the item and count when no tool is running', () => {
    const line = statusLine({ checklist: items, entries: [start('Edit'), end('Edit')], format: headline, fallback: 'Working' })
    expect(line.parts).toEqual(['Implementing the reducer', '1/3'])
  })

  it('flags an inferred current item', () => {
    const line = statusLine({
      checklist: [item('a', 'completed'), item('b', 'pending')],
      format: headline, fallback: 'Working',
    })
    expect(line.parts).toEqual(['b', '1/2'])
    expect(line.inferred).toBe(true)
  })

  it('falls back to the activity word when there is no checklist', () => {
    const line = statusLine({ entries: [start('Read')], format: headline, fallback: 'Reading' })
    expect(line.parts).toEqual(['Reading', 'Read'])
    expect(line.inferred).toBe(false)
  })

  it('is just the activity word with neither checklist nor tool', () => {
    expect(statusLine({ format: headline, fallback: 'Thinking' }).parts).toEqual(['Thinking'])
  })

  it('still shows the count once every item is done', () => {
    const done = [item('a', 'completed'), item('b', 'completed')]
    const line = statusLine({ checklist: done, format: headline, fallback: 'Writing' })
    expect(line.parts).toEqual(['Writing', '2/2'])
    expect(line.inferred).toBe(false)
  })
})
