import { describe, expect, it } from 'vitest'
import { splitWhiteboardMarkers } from './teamWhiteboardFormat'

describe('splitWhiteboardMarkers', () => {
  it('removes marker syntax from prose and returns structured entries', () => {
    const result = splitWhiteboardMarkers('Answer\n\n- [DECISION]: ship it\n[FACT]: tests pass\n[HANDOFF: reviewer]: verify UI\n[OPEN]: release date?')
    expect(result.stripped).toBe('Answer')
    expect(result.markers).toEqual([
      { kind: 'decision', text: 'ship it' },
      { kind: 'fact', text: 'tests pass' },
      { kind: 'handoff', to: 'reviewer', text: 'verify UI' },
      { kind: 'open', text: 'release date?' },
    ])
  })
})
