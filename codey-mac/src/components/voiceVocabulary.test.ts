import { describe, it, expect } from 'vitest'
import {
  normalizeVocabulary, vocabularyToDraft, draftToVocabulary,
  learnCorrections, mergeLearnedAliases,
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
