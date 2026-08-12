import { describe, it, expect } from 'vitest'
import { deriveEntries, parseGitFileList, walkDirectory } from './workspace-files'

describe('parseGitFileList', () => {
  it('splits NUL-delimited output and drops empties', () => {
    expect(parseGitFileList('src/a.ts\0src/b.ts\0')).toEqual(['src/a.ts', 'src/b.ts'])
  })

  it('returns nothing for empty output', () => {
    expect(parseGitFileList('')).toEqual([])
  })
})

describe('deriveEntries', () => {
  it('adds a directory entry for every ancestor of a file', () => {
    const entries = deriveEntries(['src/components/ChatTab.tsx', 'README.md'])
    expect(entries.filter(e => e.isDir).map(e => e.path)).toEqual(['src', 'src/components'])
    expect(entries.filter(e => !e.isDir).map(e => e.path)).toEqual(['README.md', 'src/components/ChatTab.tsx'])
  })

  it('deduplicates shared ancestors', () => {
    const dirs = deriveEntries(['src/a.ts', 'src/b.ts']).filter(e => e.isDir)
    expect(dirs).toHaveLength(1)
  })

  it('strips a leading ./ from paths', () => {
    expect(deriveEntries(['./a.ts'])[0].path).toBe('a.ts')
  })

  it('sets name to the last path segment', () => {
    const entry = deriveEntries(['src/components/ChatTab.tsx']).find(e => !e.isDir)
    expect(entry?.name).toBe('ChatTab.tsx')
  })
})

describe('walkDirectory', () => {
  const dirent = (name: string, dir: boolean) => ({ name, isDirectory: () => dir, isFile: () => !dir })
  const fakeFs = (tree: Record<string, Array<{ name: string; dir: boolean }>>) => ({
    readdirSync: (p: string) => {
      const children = tree[p]
      if (!children) throw new Error(`ENOENT ${p}`)
      return children.map(c => dirent(c.name, c.dir))
    },
  })

  it('collects files recursively', () => {
    const fs = fakeFs({
      '/root': [{ name: 'src', dir: true }, { name: 'README.md', dir: false }],
      '/root/src': [{ name: 'a.ts', dir: false }],
    })
    expect(walkDirectory('/root', fs as never).sort()).toEqual(['README.md', 'src/a.ts'])
  })

  it('skips node_modules and other heavy directories', () => {
    const fs = fakeFs({
      '/root': [{ name: 'node_modules', dir: true }, { name: 'a.ts', dir: false }],
      '/root/node_modules': [{ name: 'junk.ts', dir: false }],
    })
    expect(walkDirectory('/root', fs as never)).toEqual(['a.ts'])
  })

  it('skips dotfiles but keeps .github', () => {
    const fs = fakeFs({
      '/root': [{ name: '.env', dir: false }, { name: '.github', dir: true }],
      '/root/.github': [{ name: 'ci.yml', dir: false }],
    })
    expect(walkDirectory('/root', fs as never)).toEqual(['.github/ci.yml'])
  })

  it('stops at the limit', () => {
    const fs = fakeFs({ '/root': [{ name: 'a', dir: false }, { name: 'b', dir: false }, { name: 'c', dir: false }] })
    expect(walkDirectory('/root', fs as never, 2)).toHaveLength(2)
  })

  it('ignores directories it cannot read', () => {
    const fs = fakeFs({ '/root': [{ name: 'locked', dir: true }, { name: 'a.ts', dir: false }] })
    expect(walkDirectory('/root', fs as never)).toEqual(['a.ts'])
  })
})
