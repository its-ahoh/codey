import { describe, expect, it } from 'vitest'
import { findMatchRanges, splitByMatches, stepMatchIndex } from './diffSearch'

describe('findMatchRanges', () => {
  it('finds every case-insensitive occurrence', () => {
    expect(findMatchRanges('Foo foo FOO', 'foo')).toEqual([
      { start: 0, end: 3 },
      { start: 4, end: 7 },
      { start: 8, end: 11 },
    ])
  })

  it('never overlaps matches', () => {
    expect(findMatchRanges('aaaa', 'aa')).toEqual([
      { start: 0, end: 2 },
      { start: 2, end: 4 },
    ])
  })

  it('keeps only the exactly-cased occurrences in exact mode', () => {
    expect(findMatchRanges('Foo foo FOO', 'foo', true)).toEqual([{ start: 4, end: 7 }])
    expect(findMatchRanges('Foo foo FOO', 'Foo', true)).toEqual([{ start: 0, end: 3 }])
    expect(findMatchRanges('foo', 'FOO', true)).toEqual([])
  })

  it('returns nothing for an empty query or empty text', () => {
    expect(findMatchRanges('hello', '')).toEqual([])
    expect(findMatchRanges('', 'hello')).toEqual([])
  })
})

describe('splitByMatches', () => {
  it('keeps the whole line as one plain segment when nothing matches', () => {
    expect(splitByMatches('const x = 1', [])).toEqual([{ text: 'const x = 1', matchIndex: null }])
  })

  it('interleaves plain and matched segments and preserves the text', () => {
    const text = 'const foo = foo'
    const segments = splitByMatches(text, findMatchRanges(text, 'foo'))
    expect(segments).toEqual([
      { text: 'const ', matchIndex: null },
      { text: 'foo', matchIndex: 0 },
      { text: ' = ', matchIndex: null },
      { text: 'foo', matchIndex: 1 },
    ])
    expect(segments.map(s => s.text).join('')).toBe(text)
  })
})

describe('stepMatchIndex', () => {
  it('wraps forward past the last match', () => {
    expect(stepMatchIndex(2, 3, 1)).toBe(0)
    expect(stepMatchIndex(0, 3, 1)).toBe(1)
  })

  it('wraps backward before the first match', () => {
    expect(stepMatchIndex(0, 3, -1)).toBe(2)
    expect(stepMatchIndex(2, 3, -1)).toBe(1)
  })

  it('stays at zero with no matches', () => {
    expect(stepMatchIndex(0, 0, 1)).toBe(0)
  })
})
