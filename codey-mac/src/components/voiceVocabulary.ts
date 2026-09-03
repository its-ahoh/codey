/**
 * The dictionary is a plain list of preferred spellings.
 *
 * Each one is handed to the recognizer *before* it decodes, as a prompt hint,
 * so a name it would otherwise snap to a common word becomes reachable. There
 * is no after-the-fact rewrite table any more: that existed because
 * WhisperKit 0.18 ignored the hint entirely, and 1.1 does not.
 */

/** A word swap observed by comparing what was dictated against what the user
 *  actually sent. `alias` never reaches the dictionary — it is the evidence
 *  that `term` is a word the recognizer cannot spell, and the key the waiting
 *  list counts sightings under. */
export interface LearnedCorrection {
  /** The corrected spelling — what the user left in the composer. */
  term: string
  /** What the recognizer produced instead. */
  alias: string
}

/**
 * Widen whatever is in gateway.json into a clean word list.
 *
 * Accepts three shapes because all three exist on disk: a bare string (the
 * terse hand-authored form the Swift helper has always taken), the old
 * `{ term, aliases }` object (aliases are dropped — this is the migration),
 * and anything else, which is skipped rather than thrown on. This field is
 * hand-edited, and one bad row must not blank the whole dictionary.
 */
export function normalizeVocabulary(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const entry of raw) {
    const word = typeof entry === 'string'
      ? entry
      : entry && typeof entry === 'object' && typeof (entry as any).term === 'string'
        ? (entry as any).term
        : ''
    const trimmed = word.trim()
    if (!trimmed) continue
    const key = trimmed.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(trimmed)
  }
  return out
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
/** Ceiling so a runaway learner can't crowd out the prompt hint or the UI. */
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
  const left = [...before]
  const right = [...after]
  const del = [...deleted]
  const ins = [...inserted]

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

/** A correction seen once, waiting to see whether it repeats. */
export interface PendingCorrection {
  term: string
  alias: string
  /** How many times this exact swap has been observed. */
  count: number
}

/** How many sightings before a correction starts rewriting transcripts.
 *
 * One sighting cannot tell a mis-hearing from a change of mind: swapping one
 * short word for another is indistinguishable from fixing a homophone, and
 * for Chinese the shape test cannot separate them either. What does separate
 * them is repetition - the recognizer fails the same way every time, while a
 * deliberate rewording happens once and never again. Waiting for the second
 * sighting costs one extra correction and removes the failure mode where a
 * one-off edit quietly rewrites a real word for weeks afterwards. */
export const SIGHTINGS_BEFORE_ACTIVE = 2

/** Cap on the waiting list, so one-off edits cannot grow without bound. */
export const MAX_PENDING_CORRECTIONS = 100

export function normalizePending(raw: unknown): PendingCorrection[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((entry): PendingCorrection[] => {
    if (!entry || typeof entry !== 'object') return []
    const term = (entry as any).term
    const alias = (entry as any).alias
    const count = (entry as any).count
    if (typeof term !== 'string' || typeof alias !== 'string') return []
    if (!term.trim() || !alias.trim()) return []
    return [{ term, alias, count: Number.isFinite(count) && count > 0 ? Math.floor(count) : 1 }]
  })
}

function pendingKey(term: string, alias: string): string {
  return `${alias.toLowerCase()}\u0000${term.toLowerCase()}`
}

/**
 * Record this turn's corrections and report the ones that have now been seen
 * often enough to act on.
 *
 * A correction whose term is already in the dictionary is dropped rather than
 * counted: the hint was in play and did not take, so counting to two would
 * only add the word a second time.
 */
export function recordCorrections(
  pending: PendingCorrection[],
  terms: string[],
  observed: LearnedCorrection[],
): { pending: PendingCorrection[]; promoted: LearnedCorrection[] } {
  if (observed.length === 0) return { pending, promoted: [] }

  const known = new Set(terms.map(t => t.toLowerCase()))

  const next = pending.map(p => ({ ...p }))
  const index = new Map(next.map((p, i) => [pendingKey(p.term, p.alias), i]))
  const promoted: LearnedCorrection[] = []
  let changed = false

  for (const correction of observed) {
    // Already a dictionary word: the recognizer had the hint and still got it
    // wrong, which a second sighting would not change. Nothing to learn.
    if (known.has(correction.term.toLowerCase())) continue
    const key = pendingKey(correction.term, correction.alias)

    const at = index.get(key)
    if (at === undefined) {
      if (next.length >= MAX_PENDING_CORRECTIONS) continue
      next.push({ term: correction.term, alias: correction.alias, count: 1 })
      index.set(key, next.length - 1)
      changed = true
      continue
    }
    next[at].count += 1
    changed = true
    if (next[at].count >= SIGHTINGS_BEFORE_ACTIVE) {
      promoted.push({ term: next[at].term, alias: next[at].alias })
    }
  }

  // Anything promoted leaves the waiting list; it lives in the dictionary now.
  const survivors = promoted.length === 0
    ? next
    : next.filter(p => !promoted.some(q => pendingKey(q.term, q.alias) === pendingKey(p.term, p.alias)))

  if (!changed && promoted.length === 0) return { pending, promoted: [] }
  return { pending: survivors, promoted }
}

/** Drop a learned word from both the dictionary and the waiting list. Used by
 *  undo, which has to work whether or not the correction went active. */
export function forgetCorrection(
  terms: string[],
  pending: PendingCorrection[],
  correction: LearnedCorrection,
): { terms: string[]; pending: PendingCorrection[] } {
  const key = pendingKey(correction.term, correction.alias)
  return {
    terms: terms.filter(t => t.toLowerCase() !== correction.term.toLowerCase()),
    pending: pending.filter(p => pendingKey(p.term, p.alias) !== key),
  }
}

/**
 * Fold learned words into the saved dictionary.
 *
 * Returns a new array plus the subset that actually landed, so the caller can
 * skip the config write on the common "nothing new" path and tell the user
 * exactly what was added. `added` is not the same as the input: a word can be
 * dropped here for already being present or for hitting the cap.
 */
export function mergeLearnedTerms(
  terms: string[],
  learned: LearnedCorrection[],
): { terms: string[]; changed: boolean; added: string[] } {
  if (learned.length === 0) return { terms, changed: false, added: [] }

  const next = [...terms]
  const known = new Set(next.map(t => t.toLowerCase()))
  const added: string[] = []

  for (const { term } of learned) {
    const word = term.trim()
    if (!word) continue
    const key = word.toLowerCase()
    if (known.has(key)) continue
    if (next.length >= MAX_VOCABULARY_ENTRIES) continue
    next.push(word)
    known.add(key)
    added.push(word)
  }

  return added.length > 0 ? { terms: next, changed: true, added } : { terms, changed: false, added: [] }
}
