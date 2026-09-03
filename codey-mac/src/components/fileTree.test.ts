import { describe, it, expect } from 'vitest'
import { buildFileTree, countChangedLines, relativeTo, type FileTouch } from './fileTree'

const WD = '/repo'

describe('countChangedLines', () => {
  it('counts added and removed lines across hunks', () => {
    const out = countChangedLines([
      { oldText: 'a\nb', newText: 'a\nc\nd' },
      { oldText: '', newText: 'x' },
    ])
    expect(out).toEqual({ added: 3, removed: 1 })
  })

  it('reports zero for an identical hunk', () => {
    expect(countChangedLines([{ oldText: 'same', newText: 'same' }])).toEqual({ added: 0, removed: 0 })
  })
})

describe('relativeTo', () => {
  it('strips the working dir', () => {
    expect(relativeTo('/repo/src/a.ts', WD)).toBe('src/a.ts')
    expect(relativeTo('/repo/src/a.ts', '/repo/')).toBe('src/a.ts')
  })
  it('rejects paths outside, including sibling prefixes', () => {
    expect(relativeTo('/other/a.ts', WD)).toBeNull()
    expect(relativeTo('/repo2/a.ts', WD)).toBeNull()
    expect(relativeTo('/repo/a.ts', undefined)).toBeNull()
  })
})

describe('buildFileTree', () => {
  const entries = [
    { path: 'src', isDir: true },
    { path: 'src/a.ts', isDir: false },
    { path: 'src/b.ts', isDir: false },
    { path: 'docs', isDir: true },
    { path: 'docs/readme.md', isDir: false },
    { path: 'package.json', isDir: false },
  ]

  it('nests files under folders, folders first, alphabetical', () => {
    const { root } = buildFileTree({ workingDir: WD, entries, touches: new Map() })
    expect(root.map(n => n.name)).toEqual(['docs', 'src', 'package.json'])
    expect(root[1].children.map(n => n.name)).toEqual(['a.ts', 'b.ts'])
    expect(root[1].children[0].path).toBe('/repo/src/a.ts')
  })

  it('marks changed files and rolls counts up to every ancestor', () => {
    const touches = new Map<string, FileTouch>([
      ['/repo/src/a.ts', { kind: 'edit', added: 3, removed: 1, edits: 2 }],
    ])
    const { root } = buildFileTree({ workingDir: WD, entries, touches })
    const src = root.find(n => n.name === 'src')!
    expect(src.changed).toBe(true)
    expect(src.added).toBe(3)
    expect(src.removed).toBe(1)
    expect(src.children[0].changed).toBe(true)
    expect(src.children[1].changed).toBe(false)
    expect(root.find(n => n.name === 'docs')!.changed).toBe(false)
  })

  it('adds touched files the index does not know about yet', () => {
    const touches = new Map<string, FileTouch>([
      ['/repo/src/new/c.ts', { kind: 'edit', added: 5, removed: 0, edits: 1 }],
    ])
    const { root } = buildFileTree({ workingDir: WD, entries, touches })
    const src = root.find(n => n.name === 'src')!
    expect(src.children.map(n => n.name)).toEqual(['new', 'a.ts', 'b.ts'])
    expect(src.children[0].children[0].path).toBe('/repo/src/new/c.ts')
    expect(src.added).toBe(5)
  })

  it('puts files outside the working dir in a separate list', () => {
    const touches = new Map<string, FileTouch>([
      ['/etc/hosts', { kind: 'change', added: 2, removed: 1 }],
    ])
    const { root, outside } = buildFileTree({ workingDir: WD, entries, touches })
    expect(root.some(n => n.name === 'etc')).toBe(false)
    expect(outside.map(n => n.path)).toEqual(['/etc/hosts'])
    expect(outside[0].changed).toBe(true)
    expect(outside[0].added).toBe(2)
    expect(outside[0].removed).toBe(1)
  })

  it('flags reads without counting them as changes', () => {
    const touches = new Map<string, FileTouch>([
      ['/repo/docs/readme.md', { kind: 'read' }],
    ])
    const { root } = buildFileTree({ workingDir: WD, entries, touches })
    const docs = root.find(n => n.name === 'docs')!
    expect(docs.changed).toBe(false)
    expect(docs.read).toBe(true)
    expect(docs.children[0].touch).toEqual({ kind: 'read' })
  })

  it('lists everything as outside when there is no working dir', () => {
    const touches = new Map<string, FileTouch>([
      ['/x/y.ts', { kind: 'edit', added: 1, removed: 0, edits: 1 }],
    ])
    const { root, outside } = buildFileTree({ workingDir: undefined, entries: [], touches })
    expect(root).toEqual([])
    expect(outside).toHaveLength(1)
  })
})
