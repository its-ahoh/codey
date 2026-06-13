import { describe, it, expect } from 'vitest'
import { applyEvent, clearAttention, summarize } from './tray-state'

const ev = (type: string, chatId: string, extra: Record<string, unknown> = {}) => ({ type, chatId, ...extra })

describe('applyEvent', () => {
  it('non-terminal event marks the chat in-flight', () => {
    const s = applyEvent({}, ev('stream', 'c1'))
    expect(s.c1).toEqual({ inFlight: true, needsAttention: false })
  })

  it('plain done clears in-flight without attention', () => {
    let s = applyEvent({}, ev('tool_start', 'c1'))
    s = applyEvent(s, ev('done', 'c1', { response: 'ok' }))
    expect(s.c1).toEqual({ inFlight: false, needsAttention: false })
  })

  it('done with userQuestion raises needsAttention', () => {
    let s = applyEvent({}, ev('thinking', 'c1'))
    s = applyEvent(s, ev('done', 'c1', { userQuestion: { question: 'q', options: [] } }))
    expect(s.c1).toEqual({ inFlight: false, needsAttention: true })
  })

  it('error raises needsAttention', () => {
    const s = applyEvent({}, ev('error', 'c1', { message: 'boom' }))
    expect(s.c1).toEqual({ inFlight: false, needsAttention: true })
  })

  it('stopped clears in-flight without attention', () => {
    let s = applyEvent({}, ev('stream', 'c1'))
    s = applyEvent(s, ev('stopped', 'c1'))
    expect(s.c1).toEqual({ inFlight: false, needsAttention: false })
  })

  it('a new turn clears prior needsAttention', () => {
    let s = applyEvent({}, ev('error', 'c1'))
    expect(s.c1.needsAttention).toBe(true)
    s = applyEvent(s, ev('queued', 'c1', { position: 1 }))
    expect(s.c1).toEqual({ inFlight: true, needsAttention: false })
  })

  it('is immutable — does not mutate the input map', () => {
    const before = {}
    applyEvent(before, ev('stream', 'c1'))
    expect(before).toEqual({})
  })

  it('ignores events without a string chatId', () => {
    expect(applyEvent({}, { type: 'stream' } as any)).toEqual({})
  })
})

describe('clearAttention', () => {
  it('clears the flag for one chat, leaves others', () => {
    let s = applyEvent({}, ev('error', 'c1'))
    s = applyEvent(s, ev('error', 'c2'))
    s = clearAttention(s, 'c1')
    expect(s.c1.needsAttention).toBe(false)
    expect(s.c2.needsAttention).toBe(true)
  })

  it('no-ops on unknown chat', () => {
    expect(clearAttention({}, 'ghost')).toEqual({})
  })
})

describe('summarize', () => {
  it('Idle when nothing is happening', () => {
    expect(summarize({}).header).toBe('Idle')
    expect(summarize({ c1: { inFlight: false, needsAttention: false } }).header).toBe('Idle')
  })

  it('counts running only', () => {
    const s = { a: { inFlight: true, needsAttention: false }, b: { inFlight: true, needsAttention: false } }
    expect(summarize(s)).toEqual({ header: '2 running', needsAttention: [], running: ['a', 'b'] })
  })

  it('counts attention only', () => {
    const s = { a: { inFlight: false, needsAttention: true } }
    expect(summarize(s)).toEqual({ header: '1 needs attention', needsAttention: ['a'], running: [] })
  })

  it('combines, attention first, no chat double-listed', () => {
    const s = {
      a: { inFlight: false, needsAttention: true },
      b: { inFlight: true, needsAttention: false },
    }
    expect(summarize(s)).toEqual({
      header: '1 needs attention · 1 running',
      needsAttention: ['a'],
      running: ['b'],
    })
  })
})
