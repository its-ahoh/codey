/** One preferred spelling plus the mis-hearings that map onto it.
 *  Mirrors `VocabularyTerm` in the Swift helper (voice/Sources/CodeyVoice/Vocabulary.swift). */
export interface VocabularyEntry {
  term: string
  aliases: string[]
}

/** A Dictionary row mid-edit. Aliases stay one free-text blob while the user
 *  types, so a half-typed line isn't eaten between keystrokes. */
export interface VocabularyDraftRow {
  term: string
  aliasText: string
}

/** A mis-hearing observed by comparing what was dictated against what the
 *  user actually sent. */
export interface LearnedCorrection {
  /** The corrected spelling — what the user left in the composer. */
  term: string
  /** What the recognizer produced instead. */
  alias: string
}

/**
 * Widen whatever is in gateway.json into editor rows.
 *
 * The Swift side also accepts the terse hand-authored form — a bare string
 * means "hint only, no aliases" — so the editor has to understand it too,
 * otherwise opening Settings would silently drop hand-written entries.
 * Anything else in the array is skipped rather than thrown on: this field is
 * hand-edited, and one bad row must not blank the whole dictionary.
 */
export function normalizeVocabulary(raw: unknown): VocabularyEntry[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((entry): VocabularyEntry[] => {
    if (typeof entry === 'string') return entry.trim() ? [{ term: entry, aliases: [] }] : []
    if (entry && typeof entry === 'object' && typeof (entry as any).term === 'string') {
      const aliases = Array.isArray((entry as any).aliases)
        ? (entry as any).aliases.filter((a: unknown): a is string => typeof a === 'string')
        : []
      return [{ term: (entry as any).term, aliases }]
    }
    return []
  })
}

export function vocabularyToDraft(entries: VocabularyEntry[]): VocabularyDraftRow[] {
  return entries.map(entry => ({ term: entry.term, aliasText: entry.aliases.join('\n') }))
}

/**
 * Parse editor rows back into config entries.
 *
 * Blank terms are dropped here but stay visible in the draft, so "+ Add word"
 * can leave an empty row on screen without writing junk into gateway.json.
 * Aliases split on newlines *and* commas: the textarea invites one per line,
 * but comma-separated is what people type by habit and both are unambiguous.
 */
export function draftToVocabulary(draft: VocabularyDraftRow[]): VocabularyEntry[] {
  return draft
    .map(row => ({
      term: row.term.trim(),
      aliases: dedupeAliases(row.aliasText.split(/[\n,]/).map(a => a.trim()).filter(Boolean)),
    }))
    .filter(row => row.term !== '')
}

/** Aliases in a mid-edit draft row, matching what `draftToVocabulary` would
 *  keep. Used for the chip badge, so the count on screen can never disagree
 *  with what actually gets saved. */
export function countAliases(aliasText: string): number {
  return dedupeAliases(aliasText.split(/[\n,]/).map(a => a.trim()).filter(Boolean)).length
}

function dedupeAliases(aliases: string[]): string[] {
  const seen = new Set<string>()
  return aliases.filter(alias => {
    const key = alias.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

// ── Learning from edits ─────────────────────────────────────────────

/** Longest single mis-hearing worth recording, in tokens and in characters.
 *  Past this it stops being "the recognizer misheard a name" and starts being
 *  "the user rephrased the sentence", which must not enter the dictionary. */
const MAX_CORRECTION_TOKENS = 4
const MAX_CORRECTION_CHARS = 30
/** A single character is never a safe alias — it would rewrite half the
 *  transcript. Two is the floor. */
const MIN_ALIAS_CHARS = 2
/** How alike a mis-hearing has to be to the word it replaced, as a share of
 *  the longer side's characters. A misheard name sounds like the real one, so
 *  it looks like it too ("coday"/"Codey"); a rephrasing does not
 *  ("wrong"/"different"). This, not the size of the edit, is what separates a
 *  correction from a rewrite — a share-of-the-message threshold kept rejecting
 *  short utterances, where fixing one name is most of the sentence. */
const MIN_SIMILARITY = 0.5
/** Diffing is O(n*m); a pasted wall of text isn't a dictation correction
 *  anyway, so bail rather than burn the main thread. */
const MAX_DIFF_TOKENS = 400
/** Ceilings so a runaway learner can't crowd out the prompt hint or the UI. */
export const MAX_ALIASES_PER_TERM = 12
export const MAX_VOCABULARY_ENTRIES = 200

/**
 * Split into diff units: a run of ASCII letters/digits is one token, a run of
 * whitespace is one token, and anything else (CJK characters, punctuation) is
 * one token each.
 *
 * The mixed granularity is the point. Word-level diffing would turn
 * "wo zai xie Codey" into one giant replacement for Chinese, which has no
 * spaces; character-level diffing would shred "coday" into "Codey" as a
 * handful of nonsense single-letter edits. This gets both right.
 */
function tokenize(text: string): string[] {
  return text.match(/[A-Za-z0-9]+|\s+|[\s\S]/g) ?? []
}

type DiffOp = { kind: 'equal' | 'delete' | 'insert'; token: string }

/** Classic LCS diff. Inputs are one dictated utterance, so the quadratic
 *  table stays small — `MAX_DIFF_TOKENS` guards the pathological case. */
function diffTokens(before: string[], after: string[]): DiffOp[] {
  const n = before.length
  const m = after.length
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = before[i] === after[j]
        ? lcs[i + 1][j + 1] + 1
        : Math.max(lcs[i + 1][j], lcs[i][j + 1])
    }
  }
  const ops: DiffOp[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (before[i] === after[j]) {
      ops.push({ kind: 'equal', token: before[i] })
      i++; j++
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      ops.push({ kind: 'delete', token: before[i] })
      i++
    } else {
      ops.push({ kind: 'insert', token: after[j] })
      j++
    }
  }
  while (i < n) ops.push({ kind: 'delete', token: before[i++] })
  while (j < m) ops.push({ kind: 'insert', token: after[j++] })
  return ops
}

/** True when the string carries no letters, digits or CJK — pure punctuation
 *  or whitespace, which is formatting rather than a mis-hearing. */
function isSubstantive(text: string): boolean {
  return /[A-Za-z0-9\u3040-\u30ff\u4e00-\u9fff\uac00-\ud7af]/.test(text)
}

const CJK_RE = /[\u3040-\u30ff\u4e00-\u9fff\uac00-\ud7af]/

/** Case, spacing and punctuation are all things the recognizer gets wrong on
 *  its own, so they must not count against similarity. */
function similarityKey(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9\u3040-\u30ff\u4e00-\u9fff\uac00-\ud7af]/g, '')
}

/** Length of the longest common subsequence of characters. */
function lcsLength(a: string, b: string): number {
  if (!a || !b) return 0
  let prev = new Array(b.length + 1).fill(0)
  for (let i = 1; i <= a.length; i++) {
    const cur = new Array(b.length + 1).fill(0)
    for (let j = 1; j <= b.length; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1])
    }
    prev = cur
  }
  return prev[b.length]
}

/** A single CJK character, i.e. a token the diff can narrow a change down to
 *  even though the word it belongs to is longer. */
function isSingleCJKToken(token: string): boolean {
  return token.length === 1 && CJK_RE.test(token)
}

/**
 * Widen a change that the diff narrowed below `MIN_ALIAS_CHARS`.
 *
 * Chinese has no spaces, so a one-character slip inside a word diffs down to
 * exactly that character: "zhuan-LU-qi" vs "zhuan-XIE-qi" yields a single-token
 * region. Recording that as an alias is unsafe — it would rewrite the
 * character everywhere it appears — so the old code dropped it, which is why
 * almost nothing was learned from Chinese dictation.
 *
 * Pulling unchanged neighbours onto *both* sides keeps the rewrite rule valid
 * (the same context is added to each side) and makes it more specific rather
 * than less. Symmetric on purpose: expanding one way only would need to know
 * where the word boundary is, and there is no segmenter here — left-only turns
 * "xian->jin" into the wrong pair, right-only does the same to another. Taking
 * one from each side is right in both.
 */
function expandCJKRegion(
  deleted: string[],
  inserted: string[],
  before: string[],
  after: string[],
): { alias: string; term: string; aliasTokens: number; termTokens: number } | null {
  let left = [...before]
  let right = [...after]
  let del = [...deleted]
  let ins = [...inserted]

  while (del.join('').length < MIN_ALIAS_CHARS || ins.join('').length < MIN_ALIAS_CHARS) {
    const canLeft = isSingleCJKToken(left[left.length - 1] ?? '')
    const canRight = isSingleCJKToken(right[0] ?? '')
    if (!canLeft && !canRight) return null
    if (del.length + ins.length + 2 > MAX_CORRECTION_TOKENS * 2) return null
    if (canLeft) {
      const token = left.pop() as string
      del.unshift(token)
      ins.unshift(token)
    }
    if (canRight) {
      const token = right.shift() as string
      del.push(token)
      ins.push(token)
    }
  }
  return { alias: del.join(''), term: ins.join(''), aliasTokens: del.length, termTokens: ins.length }
}

/**
 * Does this replacement look like a mis-hearing rather than a rewrite?
 *
 * Two ways to qualify. Normally the two spellings have to share most of their
 * characters. But a transliteration — the recognizer wrote a name in the
 * script the user was speaking, and the user wanted the Latin spelling —
 * shares no characters at all by definition, and is one of the main things
 * this feature exists to fix. Crossing scripts is itself the evidence there.
 */
function looksLikeMishearing(alias: string, term: string): boolean {
  if (CJK_RE.test(alias) !== CJK_RE.test(term)) return true
  const a = similarityKey(alias)
  const b = similarityKey(term)
  if (!a || !b) return false

  // Chinese mis-hearings are homophones: they sound alike and look nothing
  // alike, so character overlap says "unrelated" about exactly the corrections
  // worth learning. Judging a Chinese pair by shape rejected essentially all
  // of them. Length is the signal that survives — a homophone slip has the
  // same syllable count as the word it replaced — combined with the fact that
  // the change is already short and surrounded by untouched text.
  //
  // This does let a deliberate short swap through. That is the accepted cost:
  // without pronunciation data the two are indistinguishable, and the result
  // is shown in the composer pill and removable in Settings.
  if (CJK_RE.test(alias) && CJK_RE.test(term)) {
    return Math.abs(a.length - b.length) <= 1
  }

  return lcsLength(a, b) / Math.max(a.length, b.length) >= MIN_SIMILARITY
}

/**
 * Compare what the recognizer produced against what the user actually sent,
 * and report the word-sized swaps in between.
 *
 * Only *replacements* are learned. Text the user appended shows up as a pure
 * insertion and text they deleted as a pure deletion; neither says anything
 * about how a word was misheard, and treating them as corrections is how a
 * dictionary fills up with garbage.
 *
 * Every candidate still has to look like a mis-hearing (see
 * `looksLikeMishearing`), so a caller can apply the result unconditionally.
 */
export function learnCorrections(spoken: string, edited: string): LearnedCorrection[] {
  const before = tokenize(spoken)
  const after = tokenize(edited)
  if (before.length === 0 || after.length === 0) return []
  if (before.length > MAX_DIFF_TOKENS || after.length > MAX_DIFF_TOKENS) return []

  const ops = diffTokens(before, after)

  // Group runs of non-equal ops into replacement regions, keeping the
  // untouched tokens on either side: a change the diff narrowed to a single
  // CJK character needs that context to be widened back into a usable alias.
  type RawRegion = { deleted: string[]; inserted: string[]; before: string[]; after: string[] }
  const raw: RawRegion[] = []
  let equalRun: string[] = []
  let pendingBefore: string[] = []
  let deleted: string[] = []
  let inserted: string[] = []
  const flush = () => {
    if (deleted.length || inserted.length) {
      raw.push({ deleted, inserted, before: pendingBefore, after: [] })
    }
    deleted = []
    inserted = []
    pendingBefore = []
  }
  for (const op of ops) {
    if (op.kind === 'equal') {
      flush()
      equalRun.push(op.token)
      // The equal run *after* a region is only known once we reach it.
      const last = raw[raw.length - 1]
      if (last && last.after.length < MAX_CORRECTION_TOKENS) last.after.push(op.token)
    } else {
      // Snapshot the left-hand context as the region opens; `equalRun` is
      // about to start collecting the *next* region's context instead.
      if (deleted.length === 0 && inserted.length === 0) {
        pendingBefore = equalRun.slice(-MAX_CORRECTION_TOKENS)
        equalRun = []
      }
      if (op.kind === 'delete') deleted.push(op.token)
      else inserted.push(op.token)
    }
  }
  flush()

  const regions = raw.flatMap(r => {
    const alias = r.deleted.join('').trim()
    const term = r.inserted.join('').trim()
    // Both sides present and long enough already: take it as-is.
    if (alias && term && alias.length >= MIN_ALIAS_CHARS && term.length >= MIN_ALIAS_CHARS) {
      return [{ alias, term, aliasTokens: r.deleted.length, termTokens: r.inserted.length }]
    }
    // Too short, but a real swap — try to widen it using untouched neighbours.
    if (alias && term) {
      const widened = expandCJKRegion(r.deleted, r.inserted, r.before, r.after)
      if (widened) return [widened]
    }
    return [{ alias, term, aliasTokens: r.deleted.length, termTokens: r.inserted.length }]
  })

  const out: LearnedCorrection[] = []
  const seen = new Set<string>()
  for (const region of regions) {
    // Pure insertion or pure deletion — the user added or removed text rather
    // than correcting a word.
    if (!region.alias || !region.term) continue
    if (region.alias === region.term) continue
    if (region.aliasTokens > MAX_CORRECTION_TOKENS || region.termTokens > MAX_CORRECTION_TOKENS) continue
    if (region.alias.length > MAX_CORRECTION_CHARS || region.term.length > MAX_CORRECTION_CHARS) continue
    if (region.alias.length < MIN_ALIAS_CHARS) continue
    if (!isSubstantive(region.alias) || !isSubstantive(region.term)) continue
    if (!looksLikeMishearing(region.alias, region.term)) continue
    const key = `${region.alias.toLowerCase()} ${region.term.toLowerCase()}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ term: region.term, alias: region.alias })
  }
  return out
}

/**
 * Fold learned corrections into the saved dictionary.
 *
 * Returns a new array plus the subset that actually landed, so the caller can
 * skip the config write on the common "nothing new" path and tell the user
 * exactly what was learned. `added` is not the same as the input: a
 * correction can be dropped here for being a duplicate or hitting a cap.
 */
export function mergeLearnedAliases(
  entries: VocabularyEntry[],
  learned: LearnedCorrection[],
): { entries: VocabularyEntry[]; changed: boolean; added: LearnedCorrection[] } {
  if (learned.length === 0) return { entries, changed: false, added: [] }

  const next = entries.map(entry => ({ term: entry.term, aliases: [...entry.aliases] }))
  const termIndex = new Map(next.map((entry, i) => [entry.term.toLowerCase(), i]))
  const added: LearnedCorrection[] = []
  let changed = false

  for (const { term, alias } of learned) {
    if (alias.toLowerCase() === term.toLowerCase()) continue
    // Never learn an alias that is itself somebody's preferred spelling —
    // the two rules would fight, and the correct word would get rewritten
    // into a different one.
    if (termIndex.has(alias.toLowerCase())) continue

    let index = termIndex.get(term.toLowerCase())
    if (index === undefined) {
      if (next.length >= MAX_VOCABULARY_ENTRIES) continue
      next.push({ term, aliases: [] })
      index = next.length - 1
      termIndex.set(term.toLowerCase(), index)
      changed = true
    }
    const entry = next[index]
    if (entry.aliases.some(a => a.toLowerCase() === alias.toLowerCase())) continue
    if (entry.aliases.length >= MAX_ALIASES_PER_TERM) continue
    entry.aliases.push(alias)
    added.push({ term: entry.term, alias })
    changed = true
  }

  return changed ? { entries: next, changed: true, added } : { entries, changed: false, added: [] }
}
