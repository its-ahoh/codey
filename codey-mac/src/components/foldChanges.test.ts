import { describe, it, expect } from 'vitest'
import { foldFileChanges, type FoldableChange } from './foldChanges'

const edit = (oldText: string, newText: string): FoldableChange => ({ tool: 'Edit', oldText, newText })
const write = (newText: string): FoldableChange => ({ tool: 'Write', oldText: '', newText })

describe('foldFileChanges', () => {
  it('keeps unrelated edits as separate regions', () => {
    const out = foldFileChanges([edit('a', 'A'), edit('b', 'B')])
    expect(out.map(c => [c.oldText, c.newText])).toEqual([['a', 'A'], ['b', 'B']])
  })

  it('folds a rewrite of the same region into one net hunk', () => {
    const out = foldFileChanges([edit('one', 'two'), edit('two', 'three')])
    expect(out).toHaveLength(1)
    expect(out[0].oldText).toBe('one')
    expect(out[0].newText).toBe('three')
    expect(out[0].sources).toHaveLength(2)
  })

  it('folds a later edit that rewrites part of an earlier result', () => {
    const out = foldFileChanges([
      edit('const a = 1', 'const a = 1\nconst b = 2'),
      edit('const b = 2', 'const b = 22'),
    ])
    expect(out).toHaveLength(1)
    expect(out[0].oldText).toBe('const a = 1')
    expect(out[0].newText).toBe('const a = 1\nconst b = 22')
  })

  it('folds a later edit whose region swallows an earlier one', () => {
    const out = foldFileChanges([
      edit('b', 'B'),
      edit('a\nB\nc', 'X'),
    ])
    expect(out).toHaveLength(1)
    // The wider before-text keeps the original 'b', not the intermediate 'B'.
    expect(out[0].oldText).toBe('a\nb\nc')
    expect(out[0].newText).toBe('X')
  })

  it('drops a region that was edited back to its original text', () => {
    expect(foldFileChanges([edit('x', 'y'), edit('y', 'x')])).toEqual([])
  })

  it('lets a Write supersede earlier edits while keeping their count', () => {
    const out = foldFileChanges([edit('a', 'A'), edit('b', 'B'), write('whole file')])
    expect(out).toHaveLength(1)
    expect(out[0].oldText).toBe('')
    expect(out[0].newText).toBe('whole file')
    expect(out[0].sources).toHaveLength(3)
  })

  it('folds edits that follow a Write into the written content', () => {
    const out = foldFileChanges([write('line1\nline2'), edit('line2', 'line2b')])
    expect(out).toHaveLength(1)
    expect(out[0].oldText).toBe('')
    expect(out[0].newText).toBe('line1\nline2b')
  })

  it('handles an insert-style edit with empty old text', () => {
    const out = foldFileChanges([edit('', 'added')])
    expect(out.map(c => [c.oldText, c.newText])).toEqual([['', 'added']])
  })

  it('returns nothing for no changes', () => {
    expect(foldFileChanges([])).toEqual([])
  })
})
