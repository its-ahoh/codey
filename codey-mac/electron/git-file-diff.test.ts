import { describe, it, expect } from 'vitest'
import { parseNumstat } from './git-file-diff'

describe('parseNumstat', () => {
  it('maps each path to its counts', () => {
    const out = parseNumstat('3\t1\tsrc/a.ts\0' + '10\t0\tdocs/b.md\0')
    expect(out.get('src/a.ts')).toEqual({ added: 3, removed: 1 })
    expect(out.get('docs/b.md')).toEqual({ added: 10, removed: 0 })
  })
  it('skips binary files and empty output', () => {
    expect(parseNumstat('-\t-\timg.png\0').size).toBe(0)
    expect(parseNumstat('').size).toBe(0)
  })
})
