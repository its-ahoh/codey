import React from 'react'
import { C } from '../theme'
import { UIIcon } from './UIIcons'
import { stepMatchIndex } from './diffSearch'
import { findChunkMatches, matchCountLabel } from './chatSearch'

// The CSS Custom Highlight API is how a match gets painted without rewriting
// the rendered Markdown: ranges are registered by name and styled from the
// ::highlight() rules in App.tsx. Typed locally because the DOM lib shipped
// with this TypeScript version doesn't declare it.
type HighlightRegistry = { set(name: string, value: unknown): void; delete(name: string): void }
type HighlightCtor = new (...ranges: Range[]) => { priority: number }
const highlightRegistry = (): HighlightRegistry | null =>
  (globalThis as { CSS?: { highlights?: HighlightRegistry } }).CSS?.highlights ?? null
const HighlightClass = (): HighlightCtor | null =>
  (globalThis as { Highlight?: HighlightCtor }).Highlight ?? null

const ALL_HIGHLIGHT = 'codey-find'
const ACTIVE_HIGHLIGHT = 'codey-find-active'

/** Text nodes of one block element, in document order. */
type Block = Text[]

/**
 * Every text node under `root`, split into per-block runs. Whitespace-only
 * nodes are kept: dropping them would glue "the" and "build" into "thebuild"
 * and invent matches that aren't on screen.
 */
const collectBlocks = (root: HTMLElement): Block[] => {
  const displayCache = new Map<Element, string>()
  const displayOf = (el: Element): string => {
    let d = displayCache.get(el)
    if (d === undefined) { d = getComputedStyle(el).display; displayCache.set(el, d) }
    return d
  }
  // Nearest ancestor that lays its children out as a block. Inline wrappers
  // (<strong>, <code>, <a>) keep their text in the surrounding run so a match
  // can cross them.
  const blockOf = (node: Text): Element => {
    let el: Element | null = node.parentElement
    while (el && el !== root) {
      const d = displayOf(el)
      if (!d.startsWith('inline') && d !== 'contents') return el
      el = el.parentElement
    }
    return root
  }

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node: Node) => {
      if (!node.nodeValue) return NodeFilter.FILTER_REJECT
      const parent = (node as Text).parentElement
      if (!parent || parent.closest('[data-find-skip]')) return NodeFilter.FILTER_REJECT
      return NodeFilter.FILTER_ACCEPT
    },
  })

  const blocks: Block[] = []
  let currentBlock: Element | null = null
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const text = n as Text
    const block = blockOf(text)
    if (block !== currentBlock) { blocks.push([]); currentBlock = block }
    blocks[blocks.length - 1].push(text)
  }
  return blocks
}

/** Live DOM ranges for every hit under `root`, in on-screen order. */
export const findRanges = (root: HTMLElement, query: string, exact: boolean): Range[] => {
  const out: Range[] = []
  for (const nodes of collectBlocks(root)) {
    const chunks = nodes.map(n => n.nodeValue ?? '')
    for (const m of findChunkMatches(chunks, query, exact)) {
      const range = document.createRange()
      range.setStart(nodes[m.startChunk], m.startOffset)
      range.setEnd(nodes[m.endChunk], m.endOffset)
      out.push(range)
    }
  }
  return out
}

interface Props {
  /** The scrolling message list that gets searched and scrolled. */
  containerRef: React.RefObject<HTMLElement | null>
  /** Changes whenever the rendered conversation does, to re-run the search. */
  revision: string | number
  /** Called when a jump moves the viewport, so autoscroll stops fighting it. */
  onNavigate?: () => void
}

/**
 * Find-in-chat (⌘F): a sticky search bar over the message list that highlights
 * every hit and steps through them, mirroring the file-changes search.
 *
 * ⌘F is shared with the file-changes viewer, which registers its own window
 * listener. That view is a descendant of ChatTab, so React runs its effect
 * first and its handler calls preventDefault before this one sees the event —
 * hence the defaultPrevented bail below, which keeps ⌘F on whichever search is
 * more specific to what's open.
 */
export const ChatFindBar: React.FC<Props> = ({ containerRef, revision, onNavigate }) => {
  const [open, setOpen] = React.useState(false)
  const [query, setQuery] = React.useState('')
  // Off: case-insensitive. On: only exactly-cased hits count.
  const [exact, setExact] = React.useState(false)
  const [index, setIndex] = React.useState(0)
  const [total, setTotal] = React.useState(0)
  const inputRef = React.useRef<HTMLInputElement>(null)
  const rangesRef = React.useRef<Range[]>([])
  // Bumped by ⌘F so a second press re-focuses an already-open bar.
  const [focusTick, setFocusTick] = React.useState(0)

  const clearHighlights = React.useCallback(() => {
    const registry = highlightRegistry()
    registry?.delete(ALL_HIGHLIGHT)
    registry?.delete(ACTIVE_HIGHLIGHT)
    rangesRef.current = []
  }, [])

  const close = React.useCallback(() => {
    setOpen(false)
    setQuery('')
    setIndex(0)
    setTotal(0)
    clearHighlights()
  }, [clearHighlights])

  React.useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        setOpen(true)
        setFocusTick(t => t + 1)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  React.useEffect(() => {
    if (!open) return
    const input = inputRef.current
    input?.focus()
    // Reopening on an existing query selects it, so typing replaces it.
    input?.select()
  }, [open, focusTick])

  React.useEffect(() => clearHighlights, [clearHighlights])

  // Re-scan whenever the query, the case mode, or the conversation changes.
  // Ranges point at live text nodes, so a re-render invalidates them; scanning
  // again is the only way to keep the highlights on the right words.
  React.useEffect(() => {
    const root = containerRef.current
    if (!open || !query || !root) {
      clearHighlights()
      setTotal(0)
      return
    }
    const ranges = findRanges(root, query, exact)
    rangesRef.current = ranges
    setTotal(ranges.length)
    const registry = highlightRegistry()
    const Ctor = HighlightClass()
    if (!registry || !Ctor) return
    if (ranges.length === 0) { clearHighlights(); return }
    registry.set(ALL_HIGHLIGHT, new Ctor(...ranges))
  }, [open, query, exact, revision, containerRef, clearHighlights])

  const activeIndex = total === 0 ? 0 : Math.min(index, total - 1)

  // Paint the current hit differently and bring it into view. Split from the
  // scan above so stepping through matches doesn't re-walk the DOM.
  React.useEffect(() => {
    const registry = highlightRegistry()
    const Ctor = HighlightClass()
    const range = rangesRef.current[activeIndex]
    if (!registry || !Ctor) return
    if (!range) { registry.delete(ACTIVE_HIGHLIGHT); return }
    const highlight = new Ctor(range)
    // Outranks the all-matches highlight where they overlap.
    highlight.priority = 1
    registry.set(ACTIVE_HIGHLIGHT, highlight)

    const container = containerRef.current
    if (!container) return
    const rect = range.getBoundingClientRect()
    // A collapsed rect means the range is detached or hidden — nothing to
    // scroll to, and the next scan will replace it.
    if (rect.width === 0 && rect.height === 0) return
    const view = container.getBoundingClientRect()
    const centered = rect.top - view.top - view.height / 2 + rect.height / 2
    if (Math.abs(centered) < 1) return
    container.scrollTop += centered
  }, [activeIndex, total, query, exact, revision, containerRef])

  const goTo = (direction: 1 | -1) => {
    if (total === 0) return
    onNavigate?.()
    setIndex(stepMatchIndex(activeIndex, total, direction))
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') { e.preventDefault(); goTo(e.shiftKey ? -1 : 1) }
    else if (e.key === 'Escape') { e.preventDefault(); close() }
  }

  if (!open) return null

  return (
    <div style={styles.bar} data-find-skip>
      <div style={styles.field}>
        <input
          ref={inputRef}
          style={styles.input}
          value={query}
          placeholder="Find in conversation"
          aria-label="Find in conversation"
          onChange={e => { setQuery(e.target.value); setIndex(0); onNavigate?.() }}
          onKeyDown={onKeyDown}
        />
        <button
          style={{ ...styles.filterBtn, ...(exact ? styles.filterBtnActive : null) }}
          onClick={() => { setExact(v => !v); setIndex(0) }}
          aria-pressed={exact}
          aria-label="Exact match"
          title={exact ? 'Exact match on — case-sensitive' : 'Exact match off — case-insensitive'}
        ><UIIcon name="match-case" size={13} /></button>
      </div>
      <span style={styles.count}>{matchCountLabel(query, total, activeIndex)}</span>
      <button
        style={styles.navBtn}
        onClick={() => goTo(-1)}
        disabled={total === 0}
        title="Previous match (Shift+Enter)"
        aria-label="Previous match"
      >↑</button>
      <button
        style={styles.navBtn}
        onClick={() => goTo(1)}
        disabled={total === 0}
        title="Next match (Enter)"
        aria-label="Next match"
      >↓</button>
      <button
        style={styles.navBtn}
        onClick={close}
        title="Close search (Esc)"
        aria-label="Close search"
      >×</button>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  // Sticky so the bar and its counter stay reachable while the list scrolls to
  // the current hit. The negative margins cancel the message list's padding so
  // the bar spans the full column width.
  bar: {
    position: 'sticky', top: -22, zIndex: 6,
    display: 'flex', alignItems: 'center', gap: 4,
    margin: '-22px calc(-1 * max(22px, 5%)) 14px',
    padding: '10px max(22px, 5%)',
    background: C.surface2, borderBottom: `1px solid ${C.border}`,
  },
  // The field owns the border so the match-case toggle can sit inside it,
  // flush against the right edge.
  field: {
    flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 2,
    background: C.surface, border: `1px solid ${C.border2}`, borderRadius: 6,
    padding: '0 3px 0 0',
  },
  input: {
    flex: 1, minWidth: 0,
    background: 'transparent', border: 'none',
    color: C.fg, fontSize: 11.5, padding: '4px 7px', outline: 'none',
  },
  filterBtn: {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    width: 20, height: 18, padding: 0, flexShrink: 0, borderRadius: 4,
    background: 'transparent', border: '1px solid transparent',
    color: C.fg3, cursor: 'pointer',
  },
  filterBtnActive: { background: C.accentDim, borderColor: C.accent, color: C.fg },
  count: {
    color: C.fg3, fontSize: 10.5, fontVariantNumeric: 'tabular-nums',
    whiteSpace: 'nowrap', flexShrink: 0,
  },
  navBtn: {
    background: 'transparent', border: 'none', color: C.fg2,
    cursor: 'pointer', fontSize: 12, lineHeight: 1, padding: '3px 5px', flexShrink: 0,
  },
}
