import { describe, expect, it } from 'vitest'
import {
  MAX_ENTRY_CHARS,
  MEMORY_TYPES,
  isMemoryType,
  labelFor,
  sortItems,
  toCoMemoItem,
  validateContent,
} from './codey-memory'
import type { CodeyMemoryItem } from './codey-memory'

const item = (over: Partial<CodeyMemoryItem>): CodeyMemoryItem => ({
  id: 'mem-1', type: 'note', content: 'x', label: 'x',
  createdAt: 0, updatedAt: 0, accessCount: 0, tags: [], source: 'user', ...over,
})

describe('memory types', () => {
  it('accepts only the store types', () => {
    expect(MEMORY_TYPES).toEqual(['note', 'preference', 'decision', 'constraint', 'lesson'])
    expect(isMemoryType('lesson')).toBe(true)
    expect(isMemoryType('note')).toBe(true)
    expect(isMemoryType(7)).toBe(false)
  })
})

describe('toCoMemoItem', () => {
  it('preserves the Co-memo version used for optimistic edits', () => {
    expect(toCoMemoItem({ id: 'shared', version: 7, scope: 'user', projectId: null,
      content: 'Concise reviews', deleted: false, createdAt: 1, updatedAt: 2, origin: 'mcp',
      metadata: { kind: 'preference' },
    })).toMatchObject({ id: 'shared', version: 7, source: 'co-memo', type: 'preference', tags: ['user'] })
  })

})

describe('sortItems', () => {
  it('puts the most recently changed first and does not mutate the input', () => {
    const input = [item({ id: 'a', updatedAt: 1 }), item({ id: 'b', updatedAt: 5 })]
    expect(sortItems(input).map(i => i.id)).toEqual(['b', 'a'])
    expect(input.map(i => i.id)).toEqual(['a', 'b'])
  })
})

describe('labelFor', () => {
  it('uses the first real line, without markdown markers', () => {
    expect(labelFor('\n\n## Node version\nuse v22')).toBe('Node version')
    expect(labelFor('- prefers short commits')).toBe('prefers short commits')
  })

  it('truncates a long first line', () => {
    expect(labelFor('y'.repeat(90), 10)).toBe('yyyyyyyyy…')
  })

  it('is empty for empty content', () => {
    expect(labelFor('   \n  ')).toBe('')
  })
})

describe('validateContent', () => {
  it('trims and returns valid content', () => {
    expect(validateContent('  remember this  ')).toBe('remember this')
  })

  it('rejects empty, non-text and oversized content', () => {
    expect(() => validateContent('   ')).toThrow(/cannot be empty/)
    expect(() => validateContent(42)).toThrow(/must be text/)
    expect(() => validateContent('z'.repeat(MAX_ENTRY_CHARS + 1))).toThrow(/too long/)
  })
})
