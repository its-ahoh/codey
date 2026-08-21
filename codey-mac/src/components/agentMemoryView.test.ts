import { describe, expect, it } from 'vitest'
import { formatBytes, memoryPreview, summarizeMemory } from './agentMemoryView'
import type { MemoryEntry } from '../codey-api'

const entry = (over: Partial<MemoryEntry>): MemoryEntry => ({
  scope: 'user', path: '/tmp/CLAUDE.md', label: 'CLAUDE.md',
  bytes: 100, mtimeMs: 0, content: '', truncated: false, ...over,
})

describe('formatBytes', () => {
  it('keeps small files in bytes and drops decimals on bigger ones', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(1023)).toBe('1023 B')
    expect(formatBytes(2048)).toBe('2.0 KB')
    expect(formatBytes(40 * 1024)).toBe('40 KB')
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB')
  })
})

describe('summarizeMemory', () => {
  it('says so when an agent has no memory', () => {
    expect(summarizeMemory([])).toBe('No memory files yet')
  })

  it('spells out the split only when both scopes are present', () => {
    expect(summarizeMemory([
      entry({ scope: 'user', bytes: 500 }),
      entry({ scope: 'user', bytes: 500 }),
      entry({ scope: 'project', bytes: 24 }),
    ])).toBe('3 files · 2 user + 1 project · 1.0 KB')
  })

  it('leaves the split out for a single-scope list', () => {
    expect(summarizeMemory([
      entry({ scope: 'project', bytes: 500 }),
      entry({ scope: 'project', bytes: 524 }),
    ])).toBe('2 files · 1.0 KB')
  })

  it('uses the singular for one file', () => {
    expect(summarizeMemory([entry({ scope: 'project', bytes: 10 })])).toBe('1 file · 10 B')
  })
})

describe('memoryPreview', () => {
  it('skips frontmatter and heading markers', () => {
    expect(memoryPreview('---\nname: node\n---\n\n# Node version\nuse v22\n')).toBe('Node version')
  })

  it('strips a bullet marker', () => {
    expect(memoryPreview('- [Title](file.md) — hook')).toBe('[Title](file.md) — hook')
  })

  it('truncates a long line', () => {
    expect(memoryPreview('x'.repeat(200), 10)).toBe('xxxxxxxxx…')
  })

  it('returns an empty string for an empty file', () => {
    expect(memoryPreview('')).toBe('')
  })
})
