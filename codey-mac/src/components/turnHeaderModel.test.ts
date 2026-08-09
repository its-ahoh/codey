import { describe, it, expect } from 'vitest'
import { turnHeaderMeta } from './turnHeaderModel'
import type { ChatMessage } from '../types'

const msg = (over: Partial<ChatMessage> = {}): ChatMessage => ({
  id: 'm1', role: 'assistant', content: 'hi', timestamp: 0, ...over,
})

describe('turnHeaderMeta', () => {
  it('joins agent and model as the identity', () => {
    expect(turnHeaderMeta(msg({ agent: 'claude-code', model: 'opus' })).identity)
      .toBe('claude-code · opus')
  })

  it('uses whichever of agent or model is present', () => {
    expect(turnHeaderMeta(msg({ model: 'opus' })).identity).toBe('opus')
    expect(turnHeaderMeta(msg({ agent: 'codex' })).identity).toBe('codex')
  })

  it('reports no identity when neither is known', () => {
    expect(turnHeaderMeta(msg()).identity).toBeNull()
  })

  it('orders stats as duration then tokens', () => {
    expect(turnHeaderMeta(msg({ durationSec: 12, tokens: 3400 })).stats)
      .toEqual(['12s', '3.4k tok'])
  })

  // The orphaned-separator bug: stats are returned as items, never as a
  // pre-joined string, so a missing field cannot leave a dangling '·'.
  it('omits absent stats without leaving a gap', () => {
    expect(turnHeaderMeta(msg({ durationSec: 12 })).stats).toEqual(['12s'])
    expect(turnHeaderMeta(msg({ tokens: 3400 })).stats).toEqual(['3.4k tok'])
    expect(turnHeaderMeta(msg()).stats).toEqual([])
  })

  it('drops a non-finite duration', () => {
    expect(turnHeaderMeta(msg({ durationSec: NaN })).stats).toEqual([])
    expect(turnHeaderMeta(msg({ durationSec: Infinity })).stats).toEqual([])
  })

  it('keeps a zero token count', () => {
    expect(turnHeaderMeta(msg({ tokens: 0 })).stats).toEqual(['0 tok'])
  })

  // formatTokens switches formatting at 10k. Pin both sides so the move out of
  // ChatTab cannot silently change how the count reads.
  it('formats token counts the way the footer did', () => {
    expect(turnHeaderMeta(msg({ tokens: 950 })).stats).toEqual(['950 tok'])
    expect(turnHeaderMeta(msg({ tokens: 3400 })).stats).toEqual(['3.4k tok'])
    expect(turnHeaderMeta(msg({ tokens: 45_000 })).stats).toEqual(['45k tok'])
  })

  it('passes the fallback through', () => {
    const f = { from: 'claude-code(opus)', to: 'codex(gpt-5)' }
    expect(turnHeaderMeta(msg({ fallback: f })).fallback).toEqual(f)
  })

  // Drives the spec's "empty case": nothing to show means the metadata row is
  // not rendered at all, leaving only the rule.
  it('is empty when the message carries no metadata', () => {
    expect(turnHeaderMeta(msg()).isEmpty).toBe(true)
    expect(turnHeaderMeta(msg({ model: 'opus' })).isEmpty).toBe(false)
  })
})
