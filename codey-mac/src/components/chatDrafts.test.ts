import { describe, it, expect, beforeEach } from 'vitest'
import { getDraft, setDraft, clearDraft, __resetDrafts } from './chatDrafts'
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

  it('clearDraft removes a chat draft', () => {
    setDraft('a', { text: 'hi', attachments: [att('x')] })
    clearDraft('a')
    expect(getDraft('a')).toEqual({ text: '', attachments: [] })
  })
})
