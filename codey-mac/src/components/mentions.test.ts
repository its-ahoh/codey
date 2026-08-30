import { describe, it, expect } from 'vitest'
import {
  appendMentionContext, applyMention, filterEntries, findActiveMention, findResourceMentions,
  mentionKindOf, resourceEntry, scoreEntry, splitMentionSegments,
} from './mentions'

/** Mirror of the main-process index shape: files plus their ancestor dirs. */
const toEntries = (paths: string[]) => {
  const dirs = new Set<string>()
  for (const p of paths) {
    const segs = p.split('/')
    for (let i = 1; i < segs.length; i++) dirs.add(segs.slice(0, i).join('/'))
  }
  return [
    ...[...dirs].map(path => ({ path, name: path.split('/').pop() as string, isDir: true })),
    ...paths.map(path => ({ path, name: path.split('/').pop() as string, isDir: false })),
  ]
}

describe('findActiveMention', () => {
  it('finds a mention being typed at the start of the input', () => {
    expect(findActiveMention('@src', 4)).toEqual({ start: 0, end: 4, query: 'src' })
  })

  it('finds a mention after a space', () => {
    expect(findActiveMention('look at @src/app', 16)).toEqual({ start: 8, end: 16, query: 'src/app' })
  })

  it('finds a mention at the start of a later line', () => {
    expect(findActiveMention('one\n@two', 8)).toEqual({ start: 4, end: 8, query: 'two' })
  })

  it('matches a bare @ with an empty query', () => {
    expect(findActiveMention('@', 1)).toEqual({ start: 0, end: 1, query: '' })
  })

  it('ignores an @ glued to preceding text, like an email', () => {
    expect(findActiveMention('me@example.com', 14)).toBeNull()
  })

  it('returns null once the token contains whitespace', () => {
    expect(findActiveMention('@src file', 9)).toBeNull()
  })

  it('returns null when the caret sits before the @', () => {
    expect(findActiveMention('@src', 0)).toBeNull()
  })

  it('stops the token at the caret so trailing text is untouched', () => {
    expect(findActiveMention('@srcXY', 4)).toEqual({ start: 0, end: 4, query: 'src' })
  })

  it('returns null when there is no @ at all', () => {
    expect(findActiveMention('plain text', 10)).toBeNull()
  })
})

describe('applyMention', () => {
  it('replaces the active token and appends a trailing space', () => {
    const mention = { start: 0, end: 4, query: 'src' }
    expect(applyMention('@src', mention, 'src/app.ts')).toEqual({ text: '@src/app.ts ', caret: 12 })
  })

  it('appends a trailing slash instead of a space for a directory', () => {
    const mention = { start: 0, end: 4, query: 'src' }
    expect(applyMention('@src', mention, 'src/components', true)).toEqual({ text: '@src/components/', caret: 16 })
  })

  it('keeps text on both sides of the token intact', () => {
    const mention = { start: 5, end: 9, query: 'app' }
    const result = applyMention('read @app now', mention, 'src/app.ts')
    expect(result.text).toBe('read @src/app.ts  now')
    expect(result.caret).toBe(17)
  })

  it('quotes a path containing a space so the token stays one unit', () => {
    const mention = { start: 0, end: 3, query: 'my' }
    expect(applyMention('@my', mention, 'my docs/a.ts').text).toBe('@"my docs/a.ts" ')
  })
})

describe('splitMentionSegments', () => {
  const known = (p: string) => ['src/app.ts', 'src/components'].includes(p)

  it('marks a known path as a mention', () => {
    expect(splitMentionSegments('see @src/app.ts here', known)).toEqual([
      { text: 'see ', isMention: false },
      { text: '@src/app.ts', isMention: true },
      { text: ' here', isMention: false },
    ])
  })

  it('leaves an unknown path as plain text', () => {
    expect(splitMentionSegments('see @nope.ts', known)).toEqual([{ text: 'see @nope.ts', isMention: false }])
  })

  it('recognises a directory mention with a trailing slash', () => {
    expect(splitMentionSegments('@src/components/', known)).toEqual([
      { text: '@src/components/', isMention: true },
    ])
  })

  it('recognises a quoted path with a space', () => {
    const withSpace = (p: string) => p === 'my docs/a.ts'
    expect(splitMentionSegments('@"my docs/a.ts" ok', withSpace)).toEqual([
      { text: '@"my docs/a.ts"', isMention: true },
      { text: ' ok', isMention: false },
    ])
  })

  it('does not treat an email address as a mention', () => {
    const anything = () => true
    expect(splitMentionSegments('me@example.com', anything)).toEqual([
      { text: 'me@example.com', isMention: false },
    ])
  })

  it('marks several mentions in one line', () => {
    const segments = splitMentionSegments('@src/app.ts and @src/components', known)
    expect(segments.filter(s => s.isMention).map(s => s.text)).toEqual(['@src/app.ts', '@src/components'])
  })

  it('returns a single plain segment for text without mentions', () => {
    expect(splitMentionSegments('hello', known)).toEqual([{ text: 'hello', isMention: false }])
  })

  it('returns nothing for empty text', () => {
    expect(splitMentionSegments('', known)).toEqual([])
  })
})

describe('scoreEntry', () => {
  const entry = (path: string, isDir = false) => ({ path, name: path.split('/').pop() as string, isDir })

  it('returns null when the query does not match at all', () => {
    expect(scoreEntry(entry('src/a.ts'), 'zzz')).toBeNull()
  })

  it('ranks an exact filename above a weaker match on the same query', () => {
    const exact = scoreEntry(entry('src/tab.ts'), 'tab.ts') as number
    const scattered = scoreEntry(entry('src/tab-extra.ts'), 'tab.ts') as number
    expect(exact).toBeGreaterThan(scattered)
  })

  it('ranks a name prefix above a name substring', () => {
    const prefix = scoreEntry(entry('src/chatty.ts'), 'chat') as number
    const substring = scoreEntry(entry('src/mychat.ts'), 'chat') as number
    expect(prefix).toBeGreaterThan(substring)
  })

  it('ranks a name match above a directory-only path match', () => {
    const nameHit = scoreEntry(entry('lib/chat.ts'), 'chat') as number
    const pathHit = scoreEntry(entry('chat/index.ts'), 'chat') as number
    expect(nameHit).toBeGreaterThan(pathHit)
  })

  it('prefers shallower paths at the same match quality', () => {
    const shallow = scoreEntry(entry('a.ts'), 'a.ts') as number
    const deep = scoreEntry(entry('x/y/z/a.ts'), 'a.ts') as number
    expect(shallow).toBeGreaterThan(deep)
  })

  it('matches a scattered subsequence as a last resort', () => {
    expect(scoreEntry(entry('src/components/ChatTab.tsx'), 'sccht')).not.toBeNull()
  })

  it('is case-insensitive', () => {
    expect(scoreEntry(entry('src/ChatTab.tsx'), 'chattab')).not.toBeNull()
  })

  it('scores every entry as equal for an empty query', () => {
    expect(scoreEntry(entry('anything.ts'), '')).toBe(0)
  })
})

describe('filterEntries', () => {
  const entries = toEntries([
    'src/components/ChatTab.tsx',
    'src/components/ChatListPanel.tsx',
    'src/gateway.ts',
    'README.md',
  ])

  it('puts the closest filename match first', () => {
    expect(filterEntries(entries, 'chattab')[0].path).toBe('src/components/ChatTab.tsx')
  })

  it('honours the result limit', () => {
    expect(filterEntries(entries, '', 2)).toHaveLength(2)
  })

  it('matches directories as well as files', () => {
    expect(filterEntries(entries, 'components').some(e => e.isDir && e.path === 'src/components')).toBe(true)
  })

  it('returns nothing when no entry matches', () => {
    expect(filterEntries(entries, 'nonexistentthing')).toEqual([])
  })

  it('supports a path fragment containing a slash', () => {
    expect(filterEntries(entries, 'components/chatl')[0].path).toBe('src/components/ChatListPanel.tsx')
  })
})

describe('resource mentions', () => {
  const skill = resourceEntry('skill', 'browser', 'Use when a task needs the live web')
  const plugin = resourceEntry('plugin', 'chrome-companion', 'Drive the real Chrome')
  const mcp = resourceEntry('mcp', 'figma', 'remote')
  const resources = [skill, plugin, mcp]

  it('namespaces the token so it cannot collide with a path', () => {
    expect(skill.path).toBe('skill:browser')
    expect(mentionKindOf('skill:browser')).toBe('skill')
    expect(mentionKindOf('src/app.ts')).toBe('file')
  })

  it('ranks a resource by its bare name', () => {
    expect(filterEntries(resources, 'browser')[0]).toBe(skill)
  })

  it('lists every resource of a kind when the prefix is typed', () => {
    const files = toEntries(['src/skillet.ts'])
    const matches = filterEntries([...files, ...resources], 'skill:')
    expect(matches[0]).toBe(skill)
  })

  it('inserts a resource token with a trailing space', () => {
    const mention = { start: 0, end: 4, query: 'bro' }
    expect(applyMention('@bro', mention, skill.path)).toEqual({ text: '@skill:browser ', caret: 15 })
  })

  it('highlights a resolved resource token', () => {
    const known = new Set(resources.map(r => r.path))
    expect(splitMentionSegments('use @skill:browser now', p => known.has(p))).toEqual([
      { text: 'use ', isMention: false },
      { text: '@skill:browser', isMention: true },
      { text: ' now', isMention: false },
    ])
  })

  it('collects resource mentions in order, deduped, ignoring files', () => {
    const byPath = new Map(resources.map(r => [r.path, r]))
    byPath.set('src/app.ts', { path: 'src/app.ts', name: 'app.ts', isDir: false })
    const found = findResourceMentions('@skill:browser @src/app.ts @mcp:figma @skill:browser', p => byPath.get(p))
    expect(found.map(f => f.path)).toEqual(['skill:browser', 'mcp:figma'])
  })

  it('appends a hint block naming the referenced capabilities', () => {
    expect(appendMentionContext('do the thing @skill:browser', [skill])).toBe(
      'do the thing @skill:browser\n\n[Referenced by the user — use these if they fit the task]\n'
      + '- skill "browser": Use when a task needs the live web',
    )
  })

  it('labels an MCP server readably and leaves plain text untouched', () => {
    expect(appendMentionContext('hi', [mcp])).toContain('- MCP server "figma": remote')
    expect(appendMentionContext('hi', [])).toBe('hi')
  })
})
