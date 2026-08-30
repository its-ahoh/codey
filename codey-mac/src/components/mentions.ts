// Parsing for "@path" file mentions in the composer.
//
// Two jobs, both pure so they can be unit-tested away from React:
//   - findActiveMention/applyMention drive the autocomplete menu
//   - splitMentionSegments drives the highlight overlay behind the textarea

/** One indexed workspace path, as returned by the `workspace:files` IPC. */
export type MentionFile = { path: string; name: string; isDir: boolean }

/**
 * What a menu row refers to. Files are paths in the workspace; the other three
 * are capabilities the user already has installed, referenced by a namespaced
 * token (`skill:browser`) so one flat matcher can rank them all.
 */
export type MentionKind = 'file' | 'skill' | 'plugin' | 'mcp'

/**
 * A row in the "@" menu. `path` is the match key and the text inserted after
 * the "@" — for resources it is `<kind>:<name>`, which never collides with a
 * workspace-relative path because those never start with a bare `kind:`.
 */
export type MentionEntry = MentionFile & {
  /** Absent means 'file', so the existing file index needs no rewriting. */
  kind?: MentionKind
  /** One-line detail shown on the right of the row (a skill description...). */
  detail?: string
}

/** The namespace prefixes, in the order the menu groups them. */
export const RESOURCE_KINDS: Exclude<MentionKind, 'file'>[] = ['skill', 'plugin', 'mcp']

/** Build a menu row for an installed capability. */
export function resourceEntry(kind: Exclude<MentionKind, 'file'>, name: string, detail = ''): MentionEntry {
  return { path: `${kind}:${name}`, name, isDir: false, kind, detail }
}

/** The kind a resolved token belongs to, or 'file'. */
export function mentionKindOf(path: string): MentionKind {
  for (const kind of RESOURCE_KINDS) if (path.startsWith(`${kind}:`)) return kind
  return 'file'
}

export type ActiveMention = {
  /** Index of the "@" in the input. */
  start: number
  /** Exclusive end of the token — always the caret position. */
  end: number
  /** Text between the "@" and the caret. */
  query: string
}

export type MentionSegment = { text: string; isMention: boolean }

/** True for the characters that may sit directly before a mention's "@". */
const isBoundary = (ch: string | undefined) => ch === undefined || /\s/.test(ch)

/**
 * The mention the caret is currently inside, or null. A mention only starts at
 * the beginning of the input or after whitespace, so email addresses and
 * decorators never open the menu.
 */
export function findActiveMention(text: string, caret: number): ActiveMention | null {
  for (let i = caret - 1; i >= 0; i--) {
    const ch = text[i]
    if (/\s/.test(ch)) return null
    if (ch === '@') {
      if (!isBoundary(text[i - 1])) return null
      return { start: i, end: caret, query: text.slice(i + 1, caret) }
    }
  }
  return null
}

/** Wrap in quotes only when the path would otherwise break at a space. */
const formatPath = (path: string) => (/\s/.test(path) ? `"${path}"` : path)

/**
 * Replace the active token with the chosen path. Directories keep the caret
 * glued to a trailing slash so the next keystroke drills further in; files get
 * a trailing space so typing continues normally.
 */
export function applyMention(
  text: string,
  mention: ActiveMention,
  path: string,
  isDir = false,
): { text: string; caret: number } {
  const inserted = `@${formatPath(path)}${isDir ? '/' : ' '}`
  return {
    text: text.slice(0, mention.start) + inserted + text.slice(mention.end),
    caret: mention.start + inserted.length,
  }
}

/** Depth-first subsequence match — every query char appears in order. */
function subsequenceIndex(haystack: string, needle: string): number {
  let hi = 0
  let first = -1
  for (let ni = 0; ni < needle.length; ni++) {
    const ch = needle[ni]
    let found = -1
    while (hi < haystack.length) {
      if (haystack[hi] === ch) { found = hi; hi++; break }
      hi++
    }
    if (found === -1) return -1
    if (first === -1) first = found
  }
  return first
}

/**
 * Rank one entry against the query. Higher is better; `null` means no match.
 * Ordering intent: exact name > name prefix > name substring > path substring >
 * scattered subsequence, with shallower and shorter paths breaking ties.
 */
export function scoreEntry(entry: MentionEntry, query: string): number | null {
  if (!query) return 0
  const q = query.toLowerCase()
  const name = entry.name.toLowerCase()
  const path = entry.path.toLowerCase()

  let base: number
  if (name === q) base = 6000
  else if (name.startsWith(q)) base = 5000
  else if (name.includes(q)) base = 4000
  else if (path.startsWith(q)) base = 3000
  else if (path.includes(q)) base = 2000
  else if (subsequenceIndex(path, q) !== -1) base = 1000
  else return null

  const depth = entry.path.split('/').length
  return base - depth * 10 - Math.min(entry.path.length, 200) / 10
}

/** Best `limit` entries for `query`, already ordered for display. */
export function filterEntries(entries: MentionEntry[], query: string, limit = 12): MentionEntry[] {
  const scored: Array<{ entry: MentionEntry; score: number }> = []
  for (const entry of entries) {
    const score = scoreEntry(entry, query)
    if (score === null) continue
    scored.push({ entry, score })
  }
  scored.sort((a, b) => (b.score - a.score) || a.entry.path.localeCompare(b.entry.path))
  return scored.slice(0, limit).map(s => s.entry)
}

const MENTION_RE = /(^|\s)@("[^"\n]*"|\S+)/g

/**
 * Split `text` into alternating plain and mention segments. Only tokens that
 * `isKnownPath` recognises are highlighted, so a half-typed path stays plain
 * until it actually resolves to something in the workspace.
 */
export function splitMentionSegments(text: string, isKnownPath: (path: string) => boolean): MentionSegment[] {
  if (!text) return []
  const segments: MentionSegment[] = []
  let plainFrom = 0

  MENTION_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = MENTION_RE.exec(text)) !== null) {
    const tokenStart = match.index + match[1].length
    const token = `@${match[2]}`
    const raw = match[2].startsWith('"') ? match[2].slice(1, -1) : match[2]
    const path = raw.endsWith('/') ? raw.slice(0, -1) : raw
    if (!path || !isKnownPath(path)) continue
    if (tokenStart > plainFrom) segments.push({ text: text.slice(plainFrom, tokenStart), isMention: false })
    segments.push({ text: token, isMention: true })
    plainFrom = tokenStart + token.length
  }

  if (plainFrom < text.length) segments.push({ text: text.slice(plainFrom), isMention: false })
  return segments
}

/** Every resolved token in `text` that names a capability, in order, deduped. */
export function findResourceMentions(
  text: string,
  resolve: (path: string) => MentionEntry | undefined,
): MentionEntry[] {
  const found: MentionEntry[] = []
  const seen = new Set<string>()

  MENTION_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = MENTION_RE.exec(text)) !== null) {
    const raw = match[2].startsWith('"') ? match[2].slice(1, -1) : match[2]
    const path = raw.endsWith('/') ? raw.slice(0, -1) : raw
    if (!path || seen.has(path)) continue
    const entry = resolve(path)
    if (!entry || !entry.kind || entry.kind === 'file') continue
    seen.add(path)
    found.push(entry)
  }
  return found
}

const KIND_LABEL: Record<Exclude<MentionKind, 'file'>, string> = {
  skill: 'skill',
  plugin: 'plugin',
  mcp: 'MCP server',
}

/**
 * Append a short block naming the referenced capabilities. Agents do not know
 * what `@skill:foo` means on its own, so the message carries the name and the
 * one-line description with it. Nothing is enabled or configured — this is a
 * hint in the prompt, and an agent is free to ignore it.
 */
export function appendMentionContext(text: string, entries: MentionEntry[]): string {
  if (entries.length === 0) return text
  const lines = entries.map(e => {
    const label = KIND_LABEL[(e.kind ?? 'skill') as Exclude<MentionKind, 'file'>]
    return `- ${label} "${e.name}"${e.detail ? `: ${e.detail}` : ''}`
  })
  return `${text.trimEnd()}\n\n[Referenced by the user — use these if they fit the task]\n${lines.join('\n')}`
}
