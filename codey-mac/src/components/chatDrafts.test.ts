import { describe, it, expect, beforeEach } from 'vitest'
import { getDraft, setDraft, appendDraftText, subscribeDrafts, __resetDrafts } from './chatDrafts'
import type { FileAttachment } from '../types'

const att = (id: string): FileAttachment => ({
  id,
  name: `${id}.png`,
  path: `/tmp/${id}.png`,
  mimeType: 'image/png',
  size: 1,
})

describe('chatDrafts', () => {
  beforeEach(() => __resetDrafts())

  it('returns an empty draft for an unknown chat', () => {
    expect(getDraft('a')).toEqual({ text: '', attachments: [] })
  })

  it('persists text and attachments for a chat', () => {
    setDraft('a', { text: 'hello', attachments: [att('x')] })
    expect(getDraft('a')).toEqual({ text: 'hello', attachments: [att('x')] })
  })

  it('keeps drafts isolated per chat (switching does not clear)', () => {
    setDraft('a', { text: 'draft for a', attachments: [att('x')] })
    setDraft('b', { text: 'draft for b', attachments: [] })
    // Reading either chat after the other was written must not lose the first.
    expect(getDraft('a')).toEqual({ text: 'draft for a', attachments: [att('x')] })
    expect(getDraft('b')).toEqual({ text: 'draft for b', attachments: [] })
  })

  it('drops the entry when the draft becomes empty', () => {
    setDraft('a', { text: 'hi', attachments: [] })
    setDraft('a', { text: '', attachments: [] })
    expect(getDraft('a')).toEqual({ text: '', attachments: [] })
  })
})

describe('appendDraftText', () => {
  beforeEach(() => __resetDrafts())

  it('appends to an empty draft and notifies subscribers', () => {
    const seen: Array<[string, string]> = []
    subscribeDrafts((chatId, draft) => seen.push([chatId, draft.text]))
    appendDraftText('a', 'page context')
    expect(getDraft('a').text).toBe('page context')
    expect(seen).toEqual([['a', 'page context']])
  })

  it('keeps existing text and attachments, separated by a blank line', () => {
    setDraft('a', { text: 'typed', attachments: [att('x')] })
    appendDraftText('a', 'page context')
    expect(getDraft('a')).toEqual({ text: 'typed\n\npage context', attachments: [att('x')] })
  })

  it('stops notifying after unsubscribe', () => {
    let calls = 0
    const off = subscribeDrafts(() => { calls += 1 })
    appendDraftText('a', 'one')
    off()
    appendDraftText('a', 'two')
    expect(calls).toBe(1)
  })

  it('does not notify on a plain setDraft write', () => {
    let calls = 0
    subscribeDrafts(() => { calls += 1 })
    setDraft('a', { text: 'typing', attachments: [] })
    expect(calls).toBe(0)
  })
})
