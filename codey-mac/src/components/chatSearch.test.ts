import { describe, it, expect } from 'vitest'
import { findChunkMatches, matchCountLabel } from './chatSearch'

describe('findChunkMatches', () => {
  it('returns nothing for an empty query or no chunks', () => {
    expect(findChunkMatches(['hello'], '')).toEqual([])
    expect(findChunkMatches([], 'hello')).toEqual([])
  })

  it('finds a match inside a single chunk', () => {
    expect(findChunkMatches(['the quick fox'], 'quick')).toEqual([
      { startChunk: 0, startOffset: 4, endChunk: 0, endOffset: 9 },
    ])
  })

  it('finds every non-overlapping occurrence', () => {
    expect(findChunkMatches(['aaaa'], 'aa')).toEqual([
      { startChunk: 0, startOffset: 0, endChunk: 0, endOffset: 2 },
      { startChunk: 0, startOffset: 2, endChunk: 0, endOffset: 4 },
    ])
  })

  it('matches across an inline boundary (bold splits the sentence)', () => {
    // Rendered "run the build now" as: "run the " + <b>build</b> + " now"
    expect(findChunkMatches(['run the ', 'build', ' now'], 'the build')).toEqual([
      { startChunk: 0, startOffset: 4, endChunk: 1, endOffset: 5 },
    ])
  })

  it('spans more than two chunks', () => {
    expect(findChunkMatches(['ab', 'cd', 'ef'], 'bcde')).toEqual([
      { startChunk: 0, startOffset: 1, endChunk: 2, endOffset: 1 },
    ])
  })

  it('is case-insensitive by default and case-sensitive when exact', () => {
    expect(findChunkMatches(['Build the Build'], 'build')).toHaveLength(2)
    expect(findChunkMatches(['Build the Build'], 'build', true)).toHaveLength(0)
    expect(findChunkMatches(['Build the Build'], 'Build', true)).toHaveLength(2)
  })

  it('skips empty chunks when placing boundaries', () => {
    expect(findChunkMatches(['ab', '', 'cd'], 'bc')).toEqual([
      { startChunk: 0, startOffset: 1, endChunk: 2, endOffset: 1 },
    ])
  })

  it('ends a match exactly at a chunk tail without spilling into the next', () => {
    expect(findChunkMatches(['abc', 'def'], 'abc')).toEqual([
      { startChunk: 0, startOffset: 0, endChunk: 0, endOffset: 3 },
    ])
  })
})

describe('matchCountLabel', () => {
  it('is blank with no query', () => expect(matchCountLabel('', 0, 0)).toBe(''))
  it('reports no results', () => expect(matchCountLabel('x', 0, 0)).toBe('No results'))
  it('is 1-based', () => expect(matchCountLabel('x', 7, 2)).toBe('3/7'))
})
