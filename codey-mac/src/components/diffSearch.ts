/** Text-search helpers shared by the file-change diff viewer and its search bar. */

export type MatchRange = { start: number; end: number }

/**
 * All case-insensitive, non-overlapping occurrences of `query` in `text`.
 * An empty query matches nothing.
 */
export const findMatchRanges = (text: string, query: string): MatchRange[] => {
  if (!query || !text) return []
  const haystack = text.toLowerCase()
  const needle = query.toLowerCase()
  const out: MatchRange[] = []
  let from = 0
  for (;;) {
    const idx = haystack.indexOf(needle, from)
    if (idx < 0) return out
    out.push({ start: idx, end: idx + needle.length })
    from = idx + needle.length
  }
}

/** Split `text` into alternating plain/match segments for rendering. */
export const splitByMatches = (
  text: string,
  ranges: MatchRange[],
): Array<{ text: string; matchIndex: number | null }> => {
  if (ranges.length === 0) return [{ text, matchIndex: null }]
  const out: Array<{ text: string; matchIndex: number | null }> = []
  let cursor = 0
  ranges.forEach((r, i) => {
    if (r.start > cursor) out.push({ text: text.slice(cursor, r.start), matchIndex: null })
    out.push({ text: text.slice(r.start, r.end), matchIndex: i })
    cursor = r.end
  })
  if (cursor < text.length) out.push({ text: text.slice(cursor), matchIndex: null })
  return out
}

/** Wrapping next/previous index over `total` matches. Returns 0 when empty. */
export const stepMatchIndex = (current: number, total: number, direction: 1 | -1): number => {
  if (total <= 0) return 0
  const next = (current + direction) % total
  return next < 0 ? next + total : next
}
