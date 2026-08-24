import { describe, it, expect } from 'vitest'
import {
  normalizeVocabulary, vocabularyToDraft, draftToVocabulary,
  learnCorrections, mergeLearnedAliases, countAliases,
  recordCorrections, normalizePending, forgetCorrection,
  SIGHTINGS_BEFORE_ACTIVE, MAX_PENDING_CORRECTIONS,
  MAX_ALIASES_PER_TERM, MAX_VOCABULARY_ENTRIES,
} from './voiceVocabulary'

describe('normalizeVocabulary', () => {
  it('widens the bare-string shorthand into a term with no aliases', () => {
    expect(normalizeVocabulary(['WhisperKit'])).toEqual([{ term: 'WhisperKit', aliases: [] }])
  })

  it('keeps the object form intact', () => {
    expect(normalizeVocabulary([{ term: 'Codey', aliases: ['Coday', 'code E'] }]))
      .toEqual([{ term: 'Codey', aliases: ['Coday', 'code E'] }])
  })

  it('defaults a missing aliases field to empty', () => {
    expect(normalizeVocabulary([{ term: 'Codey' }])).toEqual([{ term: 'Codey', aliases: [] }])
  })

  it('drops non-string aliases rather than passing them through', () => {
    expect(normalizeVocabulary([{ term: 'Codey', aliases: ['ok', 3, null] }]))
      .toEqual([{ term: 'Codey', aliases: ['ok'] }])
  })

  it('skips malformed rows without losing the good ones', () => {
    expect(normalizeVocabulary(['A', 42, null, { noTerm: true }, { term: 'B' }]))
      .toEqual([{ term: 'A', aliases: [] }, { term: 'B', aliases: [] }])
  })

  it('skips blank strings', () => {
    expect(normalizeVocabulary(['   ', 'A'])).toEqual([{ term: 'A', aliases: [] }])
  })

  it('returns empty for a missing or non-array field', () => {
    expect(normalizeVocabulary(undefined)).toEqual([])
    expect(normalizeVocabulary('Codey')).toEqual([])
    expect(normalizeVocabulary({ term: 'Codey' })).toEqual([])
  })
})

describe('draft round-trip', () => {
  it('survives entries -> draft -> entries unchanged', () => {
    const entries = [
      { term: 'Codey', aliases: ['Coday', 'code E'] },
      { term: 'WhisperKit', aliases: [] },
    ]
    expect(draftToVocabulary(vocabularyToDraft(entries))).toEqual(entries)
  })

  it('shows aliases one per line for the textarea', () => {
    expect(vocabularyToDraft([{ term: 'Codey', aliases: ['a', 'b'] }]))
      .toEqual([{ term: 'Codey', aliasText: 'a\nb' }])
  })
})

describe('draftToVocabulary', () => {
  it('drops a row whose term is blank, so "+ Add word" writes nothing', () => {
    expect(draftToVocabulary([{ term: '', aliasText: '' }, { term: '  ', aliasText: 'x' }])).toEqual([])
  })

  it('keeps a term with no aliases — it still works as a hint', () => {
    expect(draftToVocabulary([{ term: 'Codey', aliasText: '' }]))
      .toEqual([{ term: 'Codey', aliases: [] }])
  })

  it('trims whitespace around the term and each alias', () => {
    expect(draftToVocabulary([{ term: '  Codey  ', aliasText: ' Coday ,  code E ' }]))
      .toEqual([{ term: 'Codey', aliases: ['Coday', 'code E'] }])
  })

  it('ignores empty slots from trailing or doubled commas while typing', () => {
    expect(draftToVocabulary([{ term: 'Codey', aliasText: 'a,,b, ' }]))
      .toEqual([{ term: 'Codey', aliases: ['a', 'b'] }])
  })
})

describe('countAliases', () => {
  it('agrees with what draftToVocabulary would save', () => {
    const text = 'Coday\ncode E, cody'
    expect(countAliases(text)).toBe(draftToVocabulary([{ term: 'Codey', aliasText: text }])[0].aliases.length)
  })

  it('counts nothing for an empty or whitespace-only field', () => {
    expect(countAliases('')).toBe(0)
    expect(countAliases('  \n , ')).toBe(0)
  })

  it('does not double-count a duplicate the save would drop', () => {
    expect(countAliases('Coday\ncoday')).toBe(1)
  })
})

describe('learnCorrections', () => {
  it('learns a single misheard word from an edit', () => {
    expect(learnCorrections('open coday now', 'open Codey now'))
      .toEqual([{ term: 'Codey', alias: 'coday' }])
  })

  it('learns a capitalization-only fix', () => {
    expect(learnCorrections('run cody', 'run Codey'))
      .toEqual([{ term: 'Codey', alias: 'cody' }])
  })

  it('learns a multi-word mis-hearing', () => {
    expect(learnCorrections('use whisper kit here', 'use WhisperKit here'))
      .toEqual([{ term: 'WhisperKit', alias: 'whisper kit' }])
  })

  it('learns more than one correction in a single edit', () => {
    expect(learnCorrections('coday uses whisper kit', 'Codey uses WhisperKit'))
      .toEqual([
        { term: 'Codey', alias: 'coday' },
        { term: 'WhisperKit', alias: 'whisper kit' },
      ])
  })

  it('ignores text the user appended', () => {
    expect(learnCorrections('fix the bug', 'fix the bug in the parser please')).toEqual([])
  })

  it('ignores text the user deleted', () => {
    expect(learnCorrections('fix the bug in the parser', 'fix the bug')).toEqual([])
  })

  it('ignores a whole-message rewrite', () => {
    expect(learnCorrections('please look at the failing test', 'run the build instead')).toEqual([])
  })

  it('ignores a punctuation-only edit', () => {
    expect(learnCorrections('hello there', 'hello, there!')).toEqual([])
  })

  it('refuses a one-character alias, which would rewrite everything', () => {
    expect(learnCorrections('a bug', 'the bug')).toEqual([])
  })

  it('refuses a correction longer than a name', () => {
    const spoken = 'x '.repeat(30) + 'this whole clause was wrong here'
    expect(learnCorrections(spoken, spoken.replace('this whole clause was wrong here', 'something entirely different instead'))).toEqual([])
  })

  it('handles empty input on either side', () => {
    expect(learnCorrections('', 'Codey')).toEqual([])
    expect(learnCorrections('Codey', '')).toEqual([])
  })

  it('learns a transliteration, which shares no characters with the term', () => {
    // "\u5bc7\u8fea" is a plausible Chinese rendering of "Codey".
    expect(learnCorrections('open \u5bc7\u8fea now', 'open Codey now'))
      .toEqual([{ term: 'Codey', alias: '\u5bc7\u8fea' }])
  })

  it('refuses a same-script swap for an unrelated word', () => {
    expect(learnCorrections('the build is wrong', 'the build is different')).toEqual([])
  })

  // Chinese dictation is the main use here and almost none of it was being
  // learned: homophone slips look nothing alike, and a one-character slip
  // inside a word diffs down to that character alone.
  it('learns a Chinese homophone, which shares no characters', () => {
    // "\u5973\u827a" for "\u8bed\u4e49" - same sound, unrelated shapes.
    expect(learnCorrections('\u5973\u827a\u7684\u4f18\u5316', '\u8bed\u4e49\u7684\u4f18\u5316'))
      .toEqual([{ term: '\u8bed\u4e49', alias: '\u5973\u827a' }])
  })

  it('widens a one-character Chinese slip into a usable alias', () => {
    // Only the middle character differs; on its own it would be too dangerous
    // an alias, so unchanged neighbours are pulled in from both sides.
    expect(learnCorrections('\u7528\u4e00\u4e0b\u8f6c\u5f55\u5668', '\u7528\u4e00\u4e0b\u8f6c\u5199\u5668'))
      .toEqual([{ term: '\u8f6c\u5199\u5668', alias: '\u8f6c\u5f55\u5668' }])
  })

  it('widens symmetrically rather than guessing a word boundary', () => {
    // Expanding left alone would pair "\u5728\u7ebf"/"\u5728\u8fdb"; both sides gives a
    // rule that is correct without needing a segmenter.
    expect(learnCorrections('\u8fd9\u4e2a\u5728\u7ebf\u7a0b\u91cc\u9762', '\u8fd9\u4e2a\u5728\u8fdb\u7a0b\u91cc\u9762'))
      .toEqual([{ term: '\u5728\u8fdb\u7a0b', alias: '\u5728\u7ebf\u7a0b' }])
  })

  it('still refuses a Chinese swap of clearly different length', () => {
    // Not a homophone slip: the replacement is much longer than the original.
    expect(learnCorrections('\u7528\u5b83', '\u7528\u90a3\u4e2a\u5de5\u5177')).toEqual([])
  })

  it('has no left context to borrow at the start of a sentence', () => {
    // Must not crash or invent context that is not there.
    expect(() => learnCorrections('\u5f55\u5668\u597d', '\u5199\u5668\u597d')).not.toThrow()
  })

  it('returns nothing when the text is unchanged', () => {
    expect(learnCorrections('open Codey now', 'open Codey now')).toEqual([])
  })

  it('bails on input too large to diff', () => {
    const huge = 'word '.repeat(500)
    expect(learnCorrections(huge, huge + 'x')).toEqual([])
  })
})

describe('mergeLearnedAliases', () => {
  it('adds an alias to the matching existing term', () => {
    const result = mergeLearnedAliases(
      [{ term: 'Codey', aliases: ['cody'] }],
      [{ term: 'Codey', alias: 'coday' }],
    )
    expect(result.changed).toBe(true)
    expect(result.entries).toEqual([{ term: 'Codey', aliases: ['cody', 'coday'] }])
  })

  it('creates a new entry when the term is unknown', () => {
    const result = mergeLearnedAliases([], [{ term: 'WhisperKit', alias: 'whisper kit' }])
    expect(result.entries).toEqual([{ term: 'WhisperKit', aliases: ['whisper kit'] }])
  })

  it('reports no change when the alias is already known', () => {
    const entries = [{ term: 'Codey', aliases: ['coday'] }]
    const result = mergeLearnedAliases(entries, [{ term: 'Codey', alias: 'CODAY' }])
    expect(result.changed).toBe(false)
    expect(result.entries).toBe(entries)
  })

  it('does not mutate the array it was given', () => {
    const entries = [{ term: 'Codey', aliases: ['cody'] }]
    mergeLearnedAliases(entries, [{ term: 'Codey', alias: 'coday' }])
    expect(entries).toEqual([{ term: 'Codey', aliases: ['cody'] }])
  })

  it('refuses an alias that is another entry preferred spelling', () => {
    const entries = [{ term: 'Codey', aliases: [] }, { term: 'Cody', aliases: [] }]
    const result = mergeLearnedAliases(entries, [{ term: 'Codey', alias: 'Cody' }])
    expect(result.changed).toBe(false)
  })

  it('stops adding aliases to one term past the cap', () => {
    const aliases = Array.from({ length: MAX_ALIASES_PER_TERM }, (_, i) => `a${i}`)
    const result = mergeLearnedAliases(
      [{ term: 'Codey', aliases }],
      [{ term: 'Codey', alias: 'one-too-many' }],
    )
    expect(result.changed).toBe(false)
  })

  it('stops creating entries past the cap', () => {
    const entries = Array.from({ length: MAX_VOCABULARY_ENTRIES }, (_, i) => ({ term: `t${i}`, aliases: [] }))
    const result = mergeLearnedAliases(entries, [{ term: 'Codey', alias: 'coday' }])
    expect(result.changed).toBe(false)
  })

  it('reports exactly what landed, so the UI can name it', () => {
    const result = mergeLearnedAliases([], [
      { term: 'Codey', alias: 'coday' },
      { term: 'WhisperKit', alias: 'whisper kit' },
    ])
    expect(result.added).toEqual([
      { term: 'Codey', alias: 'coday' },
      { term: 'WhisperKit', alias: 'whisper kit' },
    ])
  })

  it('leaves a dropped correction out of added', () => {
    const result = mergeLearnedAliases(
      [{ term: 'Codey', aliases: ['coday'] }],
      [{ term: 'Codey', alias: 'CODAY' }, { term: 'Codey', alias: 'cody' }],
    )
    expect(result.added).toEqual([{ term: 'Codey', alias: 'cody' }])
  })

  it('reports added under the existing spelling of the term, not the typed one', () => {
    const result = mergeLearnedAliases(
      [{ term: 'Codey', aliases: [] }],
      [{ term: 'codey', alias: 'coday' }],
    )
    expect(result.added).toEqual([{ term: 'Codey', alias: 'coday' }])
  })

  it('reports an empty added list when nothing changed', () => {
    expect(mergeLearnedAliases([{ term: 'Codey', aliases: ['coday'] }], [{ term: 'Codey', alias: 'coday' }]).added).toEqual([])
  })

  it('reports no change for an empty correction list', () => {
    const entries = [{ term: 'Codey', aliases: [] }]
    expect(mergeLearnedAliases(entries, []).changed).toBe(false)
  })
})

describe('recordCorrections', () => {
  const codey = { term: 'Codey', alias: 'coday' }

  it('does not promote a correction the first time it is seen', () => {
    const r = recordCorrections([], [], [codey])
    expect(r.promoted).toEqual([])
    expect(r.pending).toEqual([{ ...codey, count: 1 }])
  })

  it('promotes on the second sighting', () => {
    const first = recordCorrections([], [], [codey])
    const second = recordCorrections(first.pending, [], [codey])
    expect(second.promoted).toEqual([codey])
  })

  it('takes the promoted correction off the waiting list', () => {
    const first = recordCorrections([], [], [codey])
    const second = recordCorrections(first.pending, [], [codey])
    expect(second.pending).toEqual([])
  })

  // The whole point: a one-off edit must never start rewriting a real word.
  it('leaves a one-off edit inert no matter how much else happens', () => {
    let pending = recordCorrections([], [], [codey]).pending
    for (const other of ['alpha', 'bravo', 'charlie']) {
      const r = recordCorrections(pending, [], [{ term: other, alias: `${other}x` }])
      expect(r.promoted).toEqual([])
      pending = r.pending
    }
    expect(pending.find(p => p.alias === 'coday')?.count).toBe(1)
  })

  it('matches sightings case-insensitively', () => {
    const first = recordCorrections([], [], [{ term: 'Codey', alias: 'CODAY' }])
    const second = recordCorrections(first.pending, [], [codey])
    expect(second.promoted).toHaveLength(1)
  })

  it('ignores a correction the dictionary already covers', () => {
    const entries = [{ term: 'Codey', aliases: ['coday'] }]
    const r = recordCorrections([], entries, [codey])
    expect(r.promoted).toEqual([])
    expect(r.pending).toEqual([])
  })

  it('returns the same list untouched when nothing was observed', () => {
    const pending = [{ ...codey, count: 1 }]
    const r = recordCorrections(pending, [], [])
    expect(r.pending).toBe(pending)
  })

  it('stops the waiting list growing without bound', () => {
    const pending = Array.from({ length: MAX_PENDING_CORRECTIONS }, (_, i) => ({
      term: `t${i}`, alias: `a${i}`, count: 1,
    }))
    const r = recordCorrections(pending, [], [{ term: 'New', alias: 'nue' }])
    expect(r.pending).toHaveLength(MAX_PENDING_CORRECTIONS)
  })

  it('needs exactly SIGHTINGS_BEFORE_ACTIVE sightings', () => {
    let pending: ReturnType<typeof recordCorrections>['pending'] = []
    let promotedAt = 0
    for (let i = 1; i <= SIGHTINGS_BEFORE_ACTIVE; i++) {
      const r = recordCorrections(pending, [], [codey])
      pending = r.pending
      if (r.promoted.length > 0 && promotedAt === 0) promotedAt = i
    }
    expect(promotedAt).toBe(SIGHTINGS_BEFORE_ACTIVE)
  })
})

describe('normalizePending', () => {
  it('defaults a missing or bad count to one sighting', () => {
    expect(normalizePending([{ term: 'a', alias: 'b' }])).toEqual([{ term: 'a', alias: 'b', count: 1 }])
    expect(normalizePending([{ term: 'a', alias: 'b', count: -3 }])).toEqual([{ term: 'a', alias: 'b', count: 1 }])
  })

  it('skips malformed rows rather than throwing', () => {
    expect(normalizePending([null, 3, { term: 'a' }, { alias: 'b' }, { term: ' ', alias: 'b' }])).toEqual([])
  })

  it('returns empty for a missing field', () => {
    expect(normalizePending(undefined)).toEqual([])
  })
})

describe('forgetCorrection', () => {
  it('removes the alias from the dictionary', () => {
    const r = forgetCorrection(
      [{ term: 'Codey', aliases: ['coday', 'kodi'] }], [], { term: 'Codey', alias: 'coday' })
    expect(r.entries).toEqual([{ term: 'Codey', aliases: ['kodi'] }])
  })

  it('removes a term that existed only to hold that alias', () => {
    const r = forgetCorrection([{ term: 'Codey', aliases: ['coday'] }], [], { term: 'Codey', alias: 'coday' })
    expect(r.entries).toEqual([])
  })

  it('keeps a hint-only term the user typed', () => {
    const entries = [{ term: 'WhisperKit', aliases: [] }, { term: 'Codey', aliases: ['coday'] }]
    const r = forgetCorrection(entries, [], { term: 'Codey', alias: 'coday' })
    expect(r.entries).toEqual([{ term: 'WhisperKit', aliases: [] }])
  })

  it('clears the waiting list too, so undo is not just "not yet"', () => {
    const r = forgetCorrection([], [{ term: 'Codey', alias: 'coday', count: 1 }], { term: 'Codey', alias: 'coday' })
    expect(r.pending).toEqual([])
  })

  it('leaves unrelated entries and sightings alone', () => {
    const entries = [{ term: 'Other', aliases: ['othr'] }]
    const pending = [{ term: 'Third', alias: 'thrd', count: 1 }]
    const r = forgetCorrection(entries, pending, { term: 'Codey', alias: 'coday' })
    expect(r.entries).toEqual(entries)
    expect(r.pending).toEqual(pending)
  })
})
