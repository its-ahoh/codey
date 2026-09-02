import React from 'react'
import { C } from '../theme'
import { findMatchRanges, splitByMatches, type MatchRange } from './diffSearch'
import hljs from 'highlight.js/lib/core'
import bash from 'highlight.js/lib/languages/bash'
import cpp from 'highlight.js/lib/languages/cpp'
import csharp from 'highlight.js/lib/languages/csharp'
import css from 'highlight.js/lib/languages/css'
import go from 'highlight.js/lib/languages/go'
import java from 'highlight.js/lib/languages/java'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import markdown from 'highlight.js/lib/languages/markdown'
import php from 'highlight.js/lib/languages/php'
import python from 'highlight.js/lib/languages/python'
import ruby from 'highlight.js/lib/languages/ruby'
import rust from 'highlight.js/lib/languages/rust'
import sql from 'highlight.js/lib/languages/sql'
import swift from 'highlight.js/lib/languages/swift'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'
import yaml from 'highlight.js/lib/languages/yaml'

Object.entries({
  bash, cpp, csharp, css, go, java, javascript, json, markdown,
  php, python, ruby, rust, sql, swift, typescript, xml, yaml,
}).forEach(([name, language]) => hljs.registerLanguage(name, language))

type Input = Record<string, unknown> | undefined

export type CanonicalTool =
  | 'Read' | 'Write' | 'Edit' | 'Bash' | 'Grep' | 'Glob' | 'LS'
  | 'WebFetch' | 'WebSearch' | 'TodoWrite' | 'Task' | 'Notebook'
  | 'Patch' | 'Plan' | 'Other'

const NAME_MAP: Record<string, CanonicalTool> = {
  // claude-code
  read: 'Read', write: 'Write', edit: 'Edit', multiedit: 'Edit',
  bash: 'Bash', grep: 'Grep', glob: 'Glob', ls: 'LS',
  webfetch: 'WebFetch', websearch: 'WebSearch',
  todowrite: 'TodoWrite', todoread: 'TodoWrite',
  task: 'Task', agent: 'Task',
  notebookedit: 'Notebook',
  // codex
  shell: 'Bash', shell_command: 'Bash', local_shell_call: 'Bash', exec: 'Bash',
  read_file: 'Read', write_file: 'Write', create_file: 'Write',
  apply_patch: 'Patch', patch: 'Patch',
  update_plan: 'Plan', plan: 'Plan',
  web_search: 'WebSearch',
  // opencode
  list: 'LS',
}

export const normalizeTool = (raw: string | undefined): CanonicalTool => {
  if (!raw) return 'Other'
  return NAME_MAP[raw.toLowerCase()] ?? 'Other'
}

const str = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : JSON.stringify(v))

const basename = (p: string): string => {
  const cleaned = p.replace(/\/+$/, '')
  const i = cleaned.lastIndexOf('/')
  return i >= 0 ? cleaned.slice(i + 1) : cleaned
}

const truncate = (s: string, n: number): string => (s.length <= n ? s : s.slice(0, n - 1) + '…')

const oneLine = (s: string, n = 80): string => truncate(s.replace(/\s+/g, ' ').trim(), n)

/** Build the compact headline shown on the tool-call row. */
export const formatHeadline = (rawTool: string | undefined, input: Input): string => {
  const tool = normalizeTool(rawTool)
  const i = input ?? {}
  const path = str(i.file_path ?? i.path ?? i.filename ?? i.notebook_path)
  switch (tool) {
    case 'Read': {
      const range = i.offset != null || i.limit != null
        ? ` [${i.offset ?? 0}${i.limit != null ? `:+${i.limit}` : ''}]`
        : ''
      return `Read(${path ? basename(path) : '?'})${range}`
    }
    case 'Write': return `Write(${path ? basename(path) : '?'})`
    case 'Edit': return `Edit(${path ? basename(path) : '?'})`
    case 'Notebook': return `NotebookEdit(${path ? basename(path) : '?'})`
    case 'Bash': {
      const cmd = str(i.command ?? i.cmd ?? i.script)
      return `Bash(${oneLine(cmd, 70) || '?'})`
    }
    case 'Grep': {
      const pat = str(i.pattern ?? i.query ?? i.regex)
      const where = str(i.path ?? i.glob ?? '')
      return `Grep(${oneLine(pat, 50)}${where ? ` in ${basename(where)}` : ''})`
    }
    case 'Glob': return `Glob(${str(i.pattern ?? i.glob ?? '?')})`
    case 'LS': return `LS(${str(i.path ?? '.') || '.'})`
    case 'WebFetch': {
      const url = str(i.url ?? i.uri ?? '')
      return `WebFetch(${oneLine(url, 60) || '?'})`
    }
    case 'WebSearch': return `WebSearch(${oneLine(str(i.query ?? i.q ?? ''), 60) || '?'})`
    case 'TodoWrite': {
      const todos = (i.todos as Array<unknown> | undefined) ?? []
      return `TodoWrite${todos.length ? ` (${todos.length} items)` : ''}`
    }
    case 'Task': {
      const desc = str(i.description ?? i.subagent_type ?? i.prompt ?? '')
      return `Task(${oneLine(desc, 60) || '?'})`
    }
    case 'Patch': {
      const target = str(i.path ?? i.file_path ?? '')
      return `Patch(${target ? basename(target) : 'multi-file'})`
    }
    case 'Plan': return 'UpdatePlan'
    default: {
      const name = rawTool || 'tool'
      const summary = Object.entries(i)
        .slice(0, 2)
        .map(([k, v]) => `${k}: ${oneLine(str(v), 30)}`)
        .join(', ')
      return summary ? `${name}(${summary})` : name
    }
  }
}

// ── Inline diff (line-level LCS) ──────────────────────────────────────────────

export type DiffLine = { kind: 'eq' | 'add' | 'del'; text: string }

export const lineDiff = (a: string, b: string): DiffLine[] => {
  const A = a.split('\n')
  const B = b.split('\n')
  const m = A.length, n = B.length
  // LCS table
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const out: DiffLine[] = []
  let i = 0, j = 0
  while (i < m && j < n) {
    if (A[i] === B[j]) { out.push({ kind: 'eq', text: A[i] }); i++; j++ }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ kind: 'del', text: A[i] }); i++ }
    else { out.push({ kind: 'add', text: B[j] }); j++ }
  }
  while (i < m) out.push({ kind: 'del', text: A[i++] })
  while (j < n) out.push({ kind: 'add', text: B[j++] })
  return out
}

const diffStyles: Record<string, React.CSSProperties> = {
  // overflowX:auto lets long lines scroll horizontally instead of being clipped.
  wrap: {
    fontFamily: 'Menlo, Monaco, "Courier New", monospace', fontSize: 11.5, lineHeight: 1.55,
    borderRadius: 6, overflowX: 'auto', border: `1px solid ${C.border2}`, background: C.surface,
  },
  // The inner column is as wide as the longest line (min: the visible width),
  // so every row can stretch to that same width — add/delete tints then span
  // the full block instead of stopping at the end of their own code.
  inner: { display: 'flex', flexDirection: 'column', width: 'max-content', minWidth: '100%' },
  row: { display: 'flex', whiteSpace: 'pre', width: '100%', minWidth: 'max-content' },
  // Code text stays in the readable foreground color in both light and dark
  // mode; the row tint + colored marker carry the add/delete meaning.
  add: { background: `color-mix(in srgb, ${C.green} 16%, transparent)` },
  del: { background: `color-mix(in srgb, ${C.red} 15%, transparent)` },
  eq:  {},
  // Gutter + marker are not selectable, so line numbers stay out of copied text.
  gutter: {
    flexShrink: 0, textAlign: 'right', padding: '0 6px',
    color: C.fg2, opacity: 0.8, userSelect: 'none', WebkitUserSelect: 'none',
    minWidth: 30,
  },
  marker: { width: 18, flexShrink: 0, textAlign: 'center', fontWeight: 700, userSelect: 'none', WebkitUserSelect: 'none' },
  code: { flexShrink: 0, paddingRight: 14 },
  contextRow: { background: C.surface },
  contextButton: {
    display: 'block', width: '100%', minWidth: '100%', padding: '5px 10px', boxSizing: 'border-box',
    border: 'none', borderTop: `1px solid ${C.border}`, borderBottom: `1px solid ${C.border}`,
    background: C.surface2, color: C.accent, cursor: 'pointer',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    fontSize: 10.5, fontWeight: 600, textAlign: 'center', whiteSpace: 'nowrap',
  },
  // The bar spans the whole (possibly scrolled) width; its label stays centered
  // until horizontal scrolling would push it off, then pins to the left edge.
  contextButtonLabel: { position: 'sticky', left: 0, zIndex: 2, display: 'inline-block' },
  // Divider between separate edits to the same file in a combined view.
  hunkSep: { minWidth: '100%', height: 0, borderTop: `1px dashed ${C.border2}`, margin: '2px 0' },
  match: {
    background: `color-mix(in srgb, ${C.yellow} 45%, transparent)`,
    borderRadius: 2,
  },
  matchActive: {
    background: C.yellow, color: '#000',
    borderRadius: 2, boxShadow: `0 0 0 1px ${C.yellow}`,
  },
}

/** Search wiring for a diff view: what to look for, and which hit is current. */
export type DiffSearch = {
  query: string
  /** Exact (case-sensitive) matching. Off means case-insensitive. */
  exact: boolean
  /** Namespace for this view's match ids (the file path, in the Files tab). */
  idPrefix: string
  /** Id of the match to render as the current hit, if it lives in this view. */
  activeId: string | null
  /** Called with this view's match ids, in top-to-bottom render order. */
  onMatches: (idPrefix: string, ids: string[]) => void
}

/** Stable id for one search hit: which view, which line, which occurrence. */
export const matchId = (idPrefix: string, lineKey: string, occurrence: number): string =>
  `${idPrefix} ${lineKey} ${occurrence}`

export type DiffHunk = {
  oldText: string
  newText: string
  /**
   * Real 1-based line in the current file where this edit begins, resolved by
   * locating the edit's text on disk. When provided, the gutter numbers this
   * hunk from its true position; when absent it falls back to continuing from
   * the previous hunk (or line 1 for the first).
   */
  startLine?: number
}

type HunkContext = { before: number; after: number }
const CONTEXT_STEP = 10

export const resolveSharedContextGap = (gap: number | undefined, after: number, before: number) => {
  if (gap == null) return { merged: false, after: 0, before: 0 }
  const shownAfter = Math.min(gap, Math.max(0, after))
  const shownBefore = Math.min(gap, Math.max(0, before))
  return shownAfter + shownBefore >= gap
    ? { merged: true, after: gap, before: 0 }
    : { merged: false, after: shownAfter, before: shownBefore }
}

const contentLineCount = (text: string): number => {
  if (!text) return 0
  const lines = text.split('\n')
  return text.endsWith('\n') ? lines.length - 1 : lines.length
}

const EXTENSION_LANGUAGES: Record<string, string> = {
  bash: 'bash', sh: 'bash', zsh: 'bash',
  c: 'cpp', cc: 'cpp', cpp: 'cpp', cxx: 'cpp', h: 'cpp', hpp: 'cpp',
  cs: 'csharp', css: 'css', go: 'go', java: 'java',
  js: 'javascript', cjs: 'javascript', jsx: 'javascript', mjs: 'javascript',
  json: 'json', jsonc: 'json', md: 'markdown', mdx: 'markdown',
  php: 'php', py: 'python', rb: 'ruby', rs: 'rust', sql: 'sql', swift: 'swift',
  ts: 'typescript', tsx: 'typescript',
  html: 'xml', htm: 'xml', svg: 'xml', vue: 'xml', svelte: 'xml', xml: 'xml',
  yaml: 'yaml', yml: 'yaml',
}

export const languageForFilePath = (filePath?: string): string | undefined => {
  if (!filePath) return undefined
  const fileName = filePath.split('/').pop()?.toLowerCase() ?? ''
  if (fileName === 'dockerfile' || fileName.startsWith('dockerfile.')) return 'bash'
  const extension = fileName.includes('.') ? fileName.split('.').pop() ?? '' : ''
  return EXTENSION_LANGUAGES[extension]
}

export const highlightedLine = (text: string, language?: string): string | undefined => {
  if (!text || !language) return undefined
  try { return hljs.highlight(language, text, true).value }
  catch { return undefined }
}

/**
 * Renders several edits to the SAME file as one diff. When a hunk's real
 * startLine is known the gutter shows true file line numbers; otherwise
 * numbering continues across hunks. A dashed divider marks each edit boundary.
 */
export const CombinedDiffView: React.FC<{
  hunks: DiffHunk[]
  fileContent?: string | null
  filePath?: string
  search?: DiffSearch
}> = ({ hunks, fileContent, filePath, search }) => {
  const [context, setContext] = React.useState<Record<number, HunkContext>>({})
  const language = languageForFilePath(filePath)
  const fileLines = fileContent?.split('\n')
  if (fileLines && fileContent?.endsWith('\n')) fileLines.pop()

  // Work in file order so each pair of neighboring hunks shares exactly one
  // context gap. The original index remains the stable state/key identifier.
  const entries = hunks
    .map((hunk, key) => {
      const startIndex = hunk.startLine != null ? hunk.startLine - 1 : undefined
      const afterIndex = startIndex != null ? startIndex + contentLineCount(hunk.newText) : undefined
      return { hunk, key, startIndex, afterIndex }
    })
    .sort((a, b) => {
      if (a.startIndex == null) return b.startIndex == null ? a.key - b.key : 1
      if (b.startIndex == null) return -1
      return a.startIndex - b.startIndex || a.key - b.key
    })

  // A finite value is the number of unchanged lines between two adjacent
  // hunks. Invalid/overlapping locations deliberately have no expandable gap.
  const gapsAfter = entries.map((entry, index): number | undefined => {
    const next = entries[index + 1]
    if (!next || entry.afterIndex == null || next.startIndex == null || next.startIndex < entry.afterIndex) return undefined
    return next.startIndex - entry.afterIndex
  })

  // Once expansions from both ends touch, the gap becomes a single continuous
  // block rendered after the first hunk. This prevents duplicate context and
  // removes the separator/buttons between the now-connected hunks.
  const mergedAfter = gapsAfter.map((gap, index) => {
    const next = entries[index + 1]
    if (!next) return false
    const left = context[entries[index].key]?.after ?? 0
    const right = context[next.key]?.before ?? 0
    return resolveSharedContextGap(gap, left, right).merged
  })

  const reveal = (hunkIndex: number, direction: keyof HunkContext, available: number) => {
    setContext(prev => {
      const current = prev[hunkIndex] ?? { before: 0, after: 0 }
      return {
        ...prev,
        [hunkIndex]: { ...current, [direction]: Math.min(available, current[direction] + CONTEXT_STEP) },
      }
    })
  }

  // Everything the view renders, flattened in display order. Building the list
  // before rendering lets search matches be numbered exactly top-to-bottom.
  type Item =
    | { kind: 'sep'; key: string }
    | { kind: 'button'; key: string; label: string; onClick: () => void }
    | {
        kind: 'line'; key: string; text: string
        oldLabel: string; newLabel: string; marker: string
        markerColor: string; codeColor: string; rowStyle: React.CSSProperties
      }

  const items: Item[] = []
  let oldNo = 0
  let newNo = 0
  entries.forEach((entry, hi) => {
    const { hunk: h, key: hunkKey, startIndex, afterIndex } = entry
    const lines = lineDiff(h.oldText, h.newText)
    const previousGap = hi > 0 ? gapsAfter[hi - 1] : undefined
    const nextGap = gapsAfter[hi]
    const availableBefore = fileLines && startIndex != null
      ? hi === 0 ? Math.max(0, startIndex) : previousGap ?? 0
      : 0
    const availableAfter = fileLines && afterIndex != null
      ? hi === entries.length - 1 ? Math.max(0, fileLines.length - afterIndex) : nextGap ?? 0
      : 0
    const shown = context[hunkKey] ?? { before: 0, after: 0 }
    const mergedWithPrevious = hi > 0 && mergedAfter[hi - 1]
    const mergedWithNext = mergedAfter[hi]
    const shownBefore = mergedWithPrevious ? 0 : Math.min(shown.before, availableBefore)
    const shownAfter = mergedWithNext ? availableAfter : Math.min(shown.after, availableAfter)
    // Anchor this hunk's gutter to the real file line when we resolved one.
    if (h.startLine != null && Number.isFinite(h.startLine)) {
      oldNo = h.startLine - 1
      newNo = h.startLine - 1
    }

    const contextItem = (text: string, lineNo: number, key: string): Item => ({
      kind: 'line', key, text,
      oldLabel: String(lineNo), newLabel: String(lineNo), marker: ' ',
      markerColor: C.fg3, codeColor: C.fg2, rowStyle: diffStyles.contextRow,
    })

    if (hi > 0 && !mergedWithPrevious) items.push({ kind: 'sep', key: `${hunkKey}:sep` })
    if (!mergedWithPrevious && availableBefore > shownBefore) {
      const step = Math.min(CONTEXT_STEP, availableBefore - shownBefore)
      items.push({
        kind: 'button', key: `${hunkKey}:more-before`,
        label: `↑ Show ${step} more line${step === 1 ? '' : 's'} above`,
        onClick: () => reveal(hunkKey, 'before', availableBefore),
      })
    }
    if (fileLines && startIndex != null) {
      fileLines.slice(startIndex - shownBefore, startIndex).forEach((text, idx) => {
        items.push(contextItem(text, startIndex - shownBefore + idx + 1, `${hi}:before:${idx}`))
      })
    }
    lines.forEach((l, idx) => {
      items.push({
        kind: 'line', key: `${hunkKey}:${idx}`, text: l.text,
        oldLabel: l.kind === 'add' ? '' : String(++oldNo),
        newLabel: l.kind === 'del' ? '' : String(++newNo),
        marker: l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' ',
        markerColor: l.kind === 'add' ? C.green : l.kind === 'del' ? C.red : C.fg3,
        codeColor: l.kind === 'eq' ? C.fg2 : C.fg,
        rowStyle: l.kind === 'add' ? diffStyles.add : l.kind === 'del' ? diffStyles.del : diffStyles.eq,
      })
    })
    if (fileLines && afterIndex != null) {
      fileLines.slice(afterIndex, afterIndex + shownAfter).forEach((text, idx) => {
        items.push(contextItem(text, afterIndex + idx + 1, `${hi}:after:${idx}`))
      })
    }
    if (!mergedWithNext && availableAfter > shownAfter) {
      const step = Math.min(CONTEXT_STEP, availableAfter - shownAfter)
      items.push({
        kind: 'button', key: `${hunkKey}:more-after`,
        label: `↓ Show ${step} more line${step === 1 ? '' : 's'} below`,
        onClick: () => reveal(hunkKey, 'after', availableAfter),
      })
    }
  })

  // This view's match ids, in display order. Recomputed each render; the effect
  // below only notifies the owner when the list actually changed.
  const query = search?.query ?? ''
  const exact = search?.exact ?? false
  const idPrefix = search?.idPrefix
  const rangesByKey = new Map<string, MatchRange[]>()
  const matchIds: string[] = []
  if (query && idPrefix != null) {
    for (const item of items) {
      if (item.kind !== 'line') continue
      const ranges = findMatchRanges(item.text, query, exact)
      if (ranges.length === 0) continue
      rangesByKey.set(item.key, ranges)
      ranges.forEach((_, i) => matchIds.push(matchId(idPrefix, item.key, i)))
    }
  }
  const onMatches = search?.onMatches
  const matchSignature = matchIds.join('\n')
  React.useEffect(() => {
    if (onMatches && idPrefix != null) {
      onMatches(idPrefix, matchSignature ? matchSignature.split('\n') : [])
    }
  }, [onMatches, idPrefix, matchSignature])

  // Bring the current hit into view once it has rendered. Views that don't own
  // the active hit must stay put — their ref still points at an older one.
  const activeId = search?.activeId ?? null
  const ownsActive = activeId != null && matchIds.includes(activeId)
  const activeElRef = React.useRef<HTMLElement | null>(null)
  React.useEffect(() => {
    if (ownsActive) activeElRef.current?.scrollIntoView({ block: 'center', inline: 'nearest' })
  }, [activeId, ownsActive])

  const codeLine = (text: string, style: React.CSSProperties, itemKey: string) => {
    const ranges = rangesByKey.get(itemKey)
    if (ranges && idPrefix != null) {
      // Matched lines drop syntax highlighting: hit markers have to wrap plain
      // text spans, which can't be interleaved with pre-highlighted HTML.
      return (
        <span style={style}>
          {splitByMatches(text, ranges).map((seg, i) => {
            if (seg.matchIndex == null) return <React.Fragment key={i}>{seg.text}</React.Fragment>
            const isActive = matchId(idPrefix, itemKey, seg.matchIndex) === activeId
            return (
              <span
                key={i}
                ref={isActive ? (el => { activeElRef.current = el }) : undefined}
                style={isActive ? diffStyles.matchActive : diffStyles.match}
              >{seg.text}</span>
            )
          })}
        </span>
      )
    }
    const html = highlightedLine(text, language)
    return html
      ? <span style={style} dangerouslySetInnerHTML={{ __html: html }} />
      : <span style={style}>{text || ' '}</span>
  }

  return (
    <div style={diffStyles.wrap}>
      <div style={diffStyles.inner}>
        {items.map(item => {
          if (item.kind === 'sep') return <div key={item.key} style={diffStyles.hunkSep} />
          if (item.kind === 'button') {
            return (
              <button key={item.key} style={diffStyles.contextButton} onClick={item.onClick}>
                <span style={diffStyles.contextButtonLabel}>{item.label}</span>
              </button>
            )
          }
          return (
            <div key={item.key} style={{ ...diffStyles.row, ...item.rowStyle }}>
              <span style={diffStyles.gutter}>{item.oldLabel}</span>
              <span style={diffStyles.gutter}>{item.newLabel}</span>
              <span style={{ ...diffStyles.marker, color: item.markerColor }}>{item.marker}</span>
              {codeLine(item.text, { ...diffStyles.code, color: item.codeColor }, item.key)}
            </div>
          )
        })}
      </div>
    </div>
  )
}

export const DiffView: React.FC<{ oldText: string; newText: string }> = ({ oldText, newText }) => {
  const lines = lineDiff(oldText, newText)
  let oldNo = 0
  let newNo = 0
  return (
    <div style={diffStyles.wrap}>
      <div style={diffStyles.inner}>
        {lines.map((l, idx) => {
          const bg = l.kind === 'add' ? diffStyles.add : l.kind === 'del' ? diffStyles.del : diffStyles.eq
          const markerColor = l.kind === 'add' ? C.green : l.kind === 'del' ? C.red : C.fg3
          const codeColor = l.kind === 'eq' ? C.fg2 : C.fg
          const marker = l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' '
          const oldLabel = l.kind === 'add' ? '' : String(++oldNo)
          const newLabel = l.kind === 'del' ? '' : String(++newNo)
          return (
            <div key={idx} style={{ ...diffStyles.row, ...bg }}>
              <span style={diffStyles.gutter}>{oldLabel}</span>
              <span style={diffStyles.gutter}>{newLabel}</span>
              <span style={{ ...diffStyles.marker, color: markerColor }}>{marker}</span>
              <span style={{ ...diffStyles.code, color: codeColor }}>{l.text ||' '}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── Detail rendering ──────────────────────────────────────────────────────────

const detailStyles: Record<string, React.CSSProperties> = {
  label: { fontSize: 10, color: C.fg2, fontWeight: 600, fontFamily: 'Menlo, Monaco, "Courier New", monospace', marginBottom: 4, marginTop: 7, textTransform: 'uppercase', letterSpacing: 0.5 },
  pre: { margin: 0, fontSize: 11.5, lineHeight: 1.5, color: C.codeFg, fontFamily: 'Menlo, Monaco, "Courier New", monospace', whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
  block: { padding: 9, background: C.codeBg, borderRadius: 6, border: `1px solid ${C.border2}` },
  meta: { fontSize: 11, color: C.fg2, fontFamily: 'Menlo, Monaco, "Courier New", monospace' },
  todoRow: { display: 'flex', gap: 6, alignItems: 'flex-start', fontSize: 12, padding: '2px 0', fontFamily: 'Menlo, Monaco, "Courier New", monospace' },
}

const TodoList: React.FC<{ todos: Array<{ content?: string; status?: string; activeForm?: string }> }> = ({ todos }) => (
  <div>
    {todos.map((t, i) => {
      const status = t.status ?? 'pending'
      const mark = status === 'completed' ? '✓' : status === 'in_progress' ? '◐' : '○'
      const color = status === 'completed' ? C.green : status === 'in_progress' ? C.yellow : C.fg3
      return (
        <div key={i} style={detailStyles.todoRow}>
          <span style={{ color, width: 14, flexShrink: 0 }}>{mark}</span>
          <span style={{ color: status === 'completed' ? C.fg3 : C.fg, textDecoration: status === 'completed' ? 'line-through' : 'none' }}>
            {t.content ?? t.activeForm ?? ''}
          </span>
        </div>
      )
    })}
  </div>
)

const Block: React.FC<{ label: string; children: React.ReactNode; mono?: boolean }> = ({ label, children, mono = true }) => (
  <>
    <div style={detailStyles.label}>{label}</div>
    <div style={mono ? detailStyles.block : undefined}>{children}</div>
  </>
)

export const ToolDetail: React.FC<{
  rawTool: string | undefined
  input: Input
  output?: string
}> = ({ rawTool, input, output }) => {
  const tool = normalizeTool(rawTool)
  const i = input ?? {}
  const Pre: React.FC<{ children: string }> = ({ children }) => <pre style={detailStyles.pre}>{children}</pre>

  switch (tool) {
    case 'Read': {
      const path = str(i.file_path ?? i.path ?? i.filename)
      return (
        <>
          <div style={detailStyles.meta}>{path || '(no path)'}</div>
          {output && <Block label="Output"><Pre>{output}</Pre></Block>}
        </>
      )
    }
    case 'Edit': {
      const path = str(i.file_path ?? i.path)
      const oldS = str(i.old_string ?? i.oldText ?? '')
      const newS = str(i.new_string ?? i.newText ?? '')
      return (
        <>
          {path && <div style={detailStyles.meta}>{path}</div>}
          {(oldS || newS) && (
            <>
              <div style={detailStyles.label}>Diff</div>
              <DiffView oldText={oldS} newText={newS} />
            </>
          )}
          {output && <Block label="Result"><Pre>{output}</Pre></Block>}
        </>
      )
    }
    case 'Write': {
      const path = str(i.file_path ?? i.path)
      const content = str(i.content ?? i.text ?? '')
      return (
        <>
          {path && <div style={detailStyles.meta}>{path}</div>}
          {content && <Block label="Content"><Pre>{content}</Pre></Block>}
          {output && <Block label="Result"><Pre>{output}</Pre></Block>}
        </>
      )
    }
    case 'Bash': {
      const cmd = str(i.command ?? i.cmd ?? i.script)
      const desc = str(i.description ?? '')
      return (
        <>
          {desc && <div style={detailStyles.meta}>{desc}</div>}
          {cmd && <Block label="$"><Pre>{cmd}</Pre></Block>}
          {output && <Block label="Output"><Pre>{output}</Pre></Block>}
        </>
      )
    }
    case 'Grep': {
      const pat = str(i.pattern ?? i.query ?? i.regex)
      const where = str(i.path ?? i.glob ?? '')
      return (
        <>
          <div style={detailStyles.meta}>{pat}{where ? `  in ${where}` : ''}</div>
          {output && <Block label="Matches"><Pre>{output}</Pre></Block>}
        </>
      )
    }
    case 'TodoWrite': {
      const todos = (i.todos as Array<{ content?: string; status?: string; activeForm?: string }> | undefined) ?? []
      return todos.length
        ? <TodoList todos={todos} />
        : output ? <Block label="Output"><Pre>{output}</Pre></Block> : null
    }
    case 'Patch': {
      const patch = str(i.patch ?? i.diff ?? i.input ?? '')
      return (
        <>
          {patch && <Block label="Patch"><Pre>{patch}</Pre></Block>}
          {output && <Block label="Result"><Pre>{output}</Pre></Block>}
        </>
      )
    }
    case 'WebFetch':
    case 'WebSearch': {
      const url = str(i.url ?? i.query ?? i.q ?? '')
      const prompt = str(i.prompt ?? '')
      return (
        <>
          {url && <div style={detailStyles.meta}>{url}</div>}
          {prompt && <Block label="Prompt"><Pre>{prompt}</Pre></Block>}
          {output && <Block label="Output"><Pre>{output}</Pre></Block>}
        </>
      )
    }
    case 'Task': {
      const desc = str(i.description ?? '')
      const prompt = str(i.prompt ?? '')
      const sub = str(i.subagent_type ?? '')
      return (
        <>
          {sub && <div style={detailStyles.meta}>agent: {sub}</div>}
          {desc && <div style={detailStyles.meta}>{desc}</div>}
          {prompt && <Block label="Prompt"><Pre>{prompt}</Pre></Block>}
          {output && <Block label="Result"><Pre>{output}</Pre></Block>}
        </>
      )
    }
    case 'Plan': {
      const plan = str(i.plan ?? i.explanation ?? '')
      return (
        <>
          {plan && <Block label="Plan"><Pre>{plan}</Pre></Block>}
          {output && <Block label="Result"><Pre>{output}</Pre></Block>}
        </>
      )
    }
    default: {
      return (
        <>
          {input && Object.keys(input).length > 0 && (
            <Block label="Input"><Pre>{JSON.stringify(input, null, 2)}</Pre></Block>
          )}
          {output && <Block label="Output"><Pre>{output}</Pre></Block>}
        </>
      )
    }
  }
}

/** Whether a tool call has any expandable detail worth rendering. */
export const hasDetail = (rawTool: string | undefined, input: Input, output?: string): boolean => {
  if (output) return true
  if (!input) return false
  const tool = normalizeTool(rawTool)
  if (tool === 'Edit') return !!(input.old_string || input.new_string)
  if (tool === 'TodoWrite') return Array.isArray(input.todos) && (input.todos as unknown[]).length > 0
  return Object.keys(input).length > 0
}
