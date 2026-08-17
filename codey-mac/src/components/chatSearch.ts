/**
 * Text-search helpers for find-in-chat (⌘F over the message list).
 *
 * The chat renders Markdown, so a message's on-screen text is spread over many
 * DOM text nodes ("chunks") — a bolded word alone splits a sentence into three.
 * Matching each chunk on its own would miss any hit that crosses an inline
 * boundary, so chunks belonging to the same block element are searched as one
 * continuous string and the hits are mapped back to (chunk, offset) pairs.
 *
 * Grouping stops at block boundaries: joining two paragraphs would invent
 * matches that straddle text the user sees on separate lines.
 */

import { findMatchRanges } from './diffSearch'

export type ChunkMatch = {
  startChunk: number
  startOffset: number
  endChunk: number
  endOffset: number
}

/**
 * All non-overlapping occurrences of `query` across `chunks`, treated as one
 * concatenated string. Case-insensitive unless `exact`. Empty chunks are kept
 * in the index space (so callers can map results back positionally) but never
 * carry a match boundary.
 */
export const findChunkMatches = (chunks: string[], query: string, exact = false): ChunkMatch[] => {
  if (!query || chunks.length === 0) return []
  const starts: number[] = []
  let total = 0
  for (const c of chunks) { starts.push(total); total += c.length }
  const joined = chunks.join('')

  // Chunk containing absolute index `abs` as a *start* boundary: the first
  // chunk whose span covers it. Empty chunks cover nothing, so they're skipped.
  const locateStart = (abs: number): { chunk: number; offset: number } => {
    for (let i = 0; i < chunks.length; i++) {
      if (chunks[i].length > 0 && abs < starts[i] + chunks[i].length) {
        return { chunk: i, offset: abs - starts[i] }
      }
    }
    const last = chunks.length - 1
    return { chunk: last, offset: chunks[last].length }
  }
  // Exclusive end boundary: `abs` sits at the tail of the chunk it closes, so
  // the comparison is `<=` rather than `<`.
  const locateEnd = (abs: number): { chunk: number; offset: number } => {
    for (let i = 0; i < chunks.length; i++) {
      if (chunks[i].length > 0 && abs <= starts[i] + chunks[i].length) {
        return { chunk: i, offset: abs - starts[i] }
      }
    }
    const last = chunks.length - 1
    return { chunk: last, offset: chunks[last].length }
  }

  return findMatchRanges(joined, query, exact).map(r => {
    const s = locateStart(r.start)
    const e = locateEnd(r.end)
    return { startChunk: s.chunk, startOffset: s.offset, endChunk: e.chunk, endOffset: e.offset }
  })
}

/** Human-readable position for the search bar's counter. */
export const matchCountLabel = (query: string, total: number, activeIndex: number): string => {
  if (!query) return ''
  if (total === 0) return 'No results'
  return `${activeIndex + 1}/${total}`
}
