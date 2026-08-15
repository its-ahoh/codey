import { describe, it, expect } from 'vitest'
import { deriveEntries, parseGitFileList, walkDirectory, MAX_ENTRIES } from './workspace-files'

describe('parseGitFileList', () => {
  it('splits NUL-delimited output and drops empties', () => {
    expect(parseGitFileList('src/a.ts\0src/b.ts\0')).toEqual(['src/a.ts', 'src/b.ts'])
  })

  it('returns nothing for empty output', () => {
    expect(parseGitFileList('')).toEqual([])
  })

  it('keeps gitignored paths but drops heavy directories', () => {
    expect(parseGitFileList('.env\0node_modules/foo/index.js\0dist/app.js\0src/a.ts\0'))
      .toEqual(['.env', 'src/a.ts'])
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

  it('drops the deepest paths when over the cap, not the alphabetical tail', () => {
    // One shallow file per top-level dir, plus enough deep junk to blow the cap.
    const shallow = ['a.ts', 'zzz.ts']
    const deep: string[] = []
    for (let i = 0; i < MAX_ENTRIES + 10; i++) deep.push(`deep/l1/l2/l3/f${i}.ts`)
    const entries = deriveEntries([...shallow, ...deep])

    expect(entries).toHaveLength(MAX_ENTRIES)
    // Both shallow files survive — including "zzz.ts", which an alphabetical
    // slice would have been the first to discard.
    expect(entries.map(e => e.path)).toEqual(expect.arrayContaining(['a.ts', 'zzz.ts']))
    expect(entries.map(e => e.path)).toEqual([...entries.map(e => e.path)].sort((x, y) => x.localeCompare(y)))
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

  it('keeps dotfiles but still skips .git', () => {
    const fs = fakeFs({
      '/root': [{ name: '.env', dir: false }, { name: '.github', dir: true }, { name: '.git', dir: true }],
      '/root/.github': [{ name: 'ci.yml', dir: false }],
      '/root/.git': [{ name: 'HEAD', dir: false }],
    })
    expect(walkDirectory('/root', fs as never).sort()).toEqual(['.env', '.github/ci.yml'])
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
