import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { describe, expect, it } from 'vitest'
import {
  ACTIVE_PROFILE_FILE,
  assertProfileName,
  BrowserProfileStore,
  availableProfileName,
  cookieMatchesUrl,
  siteCoversHost,
  summarizeProfileSites,
  deriveProfileNameFromFile,
  parseProfileData,
  parseProfileJsonText,
  profileFileName,
  profilePartition,
  readProfileJson,
} from './browser-profiles'

describe('assertProfileName / profileFileName', () => {
  it('accepts ordinary profile names', () => {
    for (const name of ['work', 'Work-1', 'personal.bak', 'a_b', 'x'.repeat(64)]) {
      expect(() => assertProfileName(name)).not.toThrow()
      expect(profileFileName(name)).toBe(`${name}.json`)
    }
  })

  it('rejects names that are not safe file names', () => {
    for (const name of ['', '../evil', 'a/b', 'a\\b', '.hidden', '.', '..', 'a b', 'a:b', 'x'.repeat(65)]) {
      expect(() => assertProfileName(name), name).toThrow(/Profile names/)
    }
  })
})

describe('deriveProfileNameFromFile', () => {
  it('turns a file name into a safe profile name', () => {
    expect(deriveProfileNameFromFile('/tmp/work.json')).toBe('work')
    expect(deriveProfileNameFromFile('C:\\Users\\me\\My Session.json')).toBe('My-Session')
    expect(deriveProfileNameFromFile('~/Downloads/gh-account (2).JSON')).toBe('gh-account-2')
  })

  it('falls back to imported for unusable names', () => {
    expect(deriveProfileNameFromFile('/tmp/.json')).toBe('imported')
    expect(deriveProfileNameFromFile('')).toBe('imported')
    expect(deriveProfileNameFromFile('/tmp/...')).toBe('imported')
  })
})

describe('parseProfileData', () => {
  it('parses a full saved profile with metadata', () => {
    const data = parseProfileData({
      name: 'work',
      createdAt: 1,
      updatedAt: 2,
      sourceUrl: 'https://example.com/',
      cookies: [
        { name: 'sid', value: 'abc', domain: 'example.com', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'lax', hostOnly: true },
      ],
      origins: [{ origin: 'https://example.com', localStorage: [{ name: 'token', value: 't' }] }],
    })
    expect(data.cookies).toEqual([expect.objectContaining({ name: 'sid', domain: 'example.com', expires: -1, httpOnly: true, hostOnly: true })])
    expect(data.origins).toEqual([{ origin: 'https://example.com', localStorage: [{ name: 'token', value: 't' }] }])
  })

  it('parses a bare Playwright storageState and normalizes its vocabulary', () => {
    const data = parseProfileData({
      cookies: [
        { name: 'a', value: '1', domain: '.github.com', path: '/', expires: 1234, httpOnly: false, secure: false, sameSite: 'Strict' },
        { name: 'b', value: '2', domain: 'example.com', sameSite: 'None' },
      ],
      origins: [{ origin: 'https://github.com', localStorage: [{ name: 'gh', value: 'tok' }] }],
    })
    expect(data.cookies[0]).toMatchObject({ domain: 'github.com', path: '/', expires: 1234, sameSite: 'strict' })
    expect(data.cookies[1]).toMatchObject({ domain: 'example.com', path: '/', expires: -1, sameSite: 'no_restriction' })
    expect(data.origins[0]).toEqual({ origin: 'https://github.com', localStorage: [{ name: 'gh', value: 'tok' }] })
  })

  it('accepts missing cookies or origins as empty lists', () => {
    expect(parseProfileData({})).toEqual({ cookies: [], origins: [] })
  })

  it('rejects malformed input', () => {
    expect(() => parseProfileData(null)).toThrow()
    expect(() => parseProfileData('nope')).toThrow()
    expect(() => parseProfileData([])).toThrow()
    expect(() => parseProfileData({ cookies: [{ name: 'x', value: 'y' }] })).toThrow(/domain/)
    expect(() => parseProfileData({ origins: [{ origin: 'ftp://nope', localStorage: [] }] })).toThrow(/origin/)
  })

  it('parseProfileJsonText surfaces JSON errors', () => {
    expect(parseProfileJsonText('{"cookies":[]}')).toEqual({ cookies: [], origins: [] })
    expect(() => parseProfileJsonText('not json')).toThrow(/Invalid profile JSON/)
  })

  it('readProfileJson reads a file and rejects bad files', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-profile-read-'))
    try {
      const file = path.join(dir, 'p.json')
      fs.writeFileSync(file, JSON.stringify({ cookies: [{ name: 'a', value: '1', domain: 'example.com' }] }))
      expect(readProfileJson(file).cookies[0].name).toBe('a')
      expect(() => readProfileJson(path.join(dir, 'missing.json'))).toThrow(/Cannot read profile file/)
      fs.writeFileSync(file, '{broken')
      expect(() => readProfileJson(file)).toThrow(/Invalid profile file/)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('BrowserProfileStore', () => {
  function makeStore(): { dir: string; store: BrowserProfileStore } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-profiles-store-'))
    return { dir, store: new BrowserProfileStore(dir) }
  }

  it('writes, reads, lists and removes profiles', () => {
    const { dir, store } = makeStore()
    try {
      expect(store.list()).toEqual([])
      const before = Date.now()
      const written = store.writeMeta('work', 'https://example.com/')
      expect(written.name).toBe('work')
      expect(written.avatar).toBeNull()
      expect(written.excludedSites).toEqual([])
      expect(written.createdAt).toBeGreaterThanOrEqual(before)
      expect(written.sourceUrl).toBe('https://example.com/')

      const read = store.read('work')
      expect(read.name).toBe('work')

      // Re-writing keeps the original createdAt and refreshes updatedAt.
      const again = store.writeMeta('work', null)
      expect(again.createdAt).toBe(written.createdAt)
      expect(again.updatedAt).toBeGreaterThanOrEqual(written.updatedAt)
      expect(again.sourceUrl).toBe('https://example.com/')

      store.writeMeta('zebra', null)
      const summaries = store.list()
      expect(summaries.map(profile => profile.name)).toEqual(['work', 'zebra'])
      expect(summaries[0]).toMatchObject({ name: 'work', cookieCount: 0, originCount: 0, active: false })

      const customized = store.setAvatar('work', '💼')
      expect(customized.avatar).toBe('💼')
      expect(store.read('work').avatar).toBe('💼')
      expect(() => store.setAvatar('work', 'not-an-avatar')).toThrow(/available profile avatars/)

      store.remove('work')
      expect(store.list().map(profile => profile.name)).toEqual(['zebra'])
      expect(() => store.remove('work')).toThrow(/does not exist/)
      expect(fs.existsSync(dir)).toBe(true)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('keeps the per-profile auto-sync switch across re-saves', () => {
    const { dir, store } = makeStore()
    try {
      store.writeMeta('work', null)
      expect(store.list()[0].autoSync).toBe(false)

      expect(store.setAutoSync('work', true).autoSync).toBe(true)
      // A refresh rewrites the profile's metadata; the switch must survive it,
      // or auto-sync would turn itself off on its own first run.
      store.writeMeta('work', null)
      expect(store.read('work').autoSync).toBe(true)

      expect(store.setAutoSync('work', false).autoSync).toBe(false)
      expect(store.read('work').autoSync).toBe(false)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('normalizes and preserves per-profile Chrome exclusions', () => {
    const { dir, store } = makeStore()
    try {
      store.writeMeta('work', null)
      const updated = store.setExcludedSites('work', [
        ' GitHub.COM ', '.google.com', '..GITHUB.com', '', '   ', '.Google.COM',
      ])
      expect(updated.excludedSites).toEqual(['github.com', 'google.com'])

      // Every metadata-only rewrite must keep the exclusion list.
      store.writeMeta('work', 'https://github.com/')
      store.setAvatar('work', '💼')
      store.setAutoSync('work', true)
      store.touch('work')
      expect(store.read('work').excludedSites).toEqual(['github.com', 'google.com'])
      expect(store.list()[0].excludedSites).toEqual(['github.com', 'google.com'])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('keeps Chrome bindings one-to-one and preserves them across metadata writes', () => {
    const { dir, store } = makeStore()
    try {
      store.writeMeta('work', null)
      store.writeMeta('personal', null)
      expect(store.setChromeBinding('work', 'chrome-a', 'Work Chrome')).toMatchObject({
        chromeProfileId: 'chrome-a', chromeProfileLabel: 'Work Chrome',
      })
      store.writeMeta('work', null)
      expect(store.read('work')).toMatchObject({ chromeProfileId: 'chrome-a', chromeProfileLabel: 'Work Chrome' })

      store.setChromeBinding('personal', 'chrome-a', 'Renamed Chrome')
      expect(store.read('work')).toMatchObject({ chromeProfileId: null, chromeProfileLabel: null })
      expect(store.profileForChrome('chrome-a')?.name).toBe('personal')

      store.setChromeBinding('personal', null, null)
      expect(store.profileForChrome('chrome-a')).toBeNull()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('safely normalizes exclusions read from existing schema-2 metadata', () => {
    const { dir, store } = makeStore()
    try {
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'work.json'), JSON.stringify({
        schema: 2,
        name: 'work',
        excludedSites: [' Example.COM ', '.example.com', 42, null, '', '...GitHub.COM'],
        createdAt: 1,
        updatedAt: 2,
        sourceUrl: null,
      }))
      expect(store.read('work').excludedSites).toEqual(['example.com', 'github.com'])
      expect(store.pendingMigrations()).toEqual([])

      fs.writeFileSync(path.join(dir, 'work.json'), JSON.stringify({
        schema: 2,
        name: 'work',
        excludedSites: 'example.com',
      }))
      expect(store.read('work').excludedSites).toEqual([])
      expect(store.pendingMigrations()).toEqual([])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('normalizes and preserves the localStorage origin index', () => {
    const { dir, store } = makeStore()
    try {
      store.writeMeta('work', null)
      store.rememberOrigins('work', [
        'https://app.example.com/path',
        'https://app.example.com/other',
        'http://localhost:3000/login',
        'file:///tmp/not-web',
        'not a url',
      ])
      expect(store.read('work').knownOrigins).toEqual([
        'https://app.example.com',
        'http://localhost:3000',
      ])

      // Metadata-only edits must not drop the index used by closed-tab export.
      store.setAvatar('work', '💼')
      store.setAutoSync('work', true)
      store.setExcludedSites('work', ['example.com'])
      store.touch('work')
      store.writeMeta('work', null)
      expect(store.read('work').knownOrigins).toEqual([
        'https://app.example.com',
        'http://localhost:3000',
      ])

      store.replaceKnownOrigins('work', ['https://replacement.example/path'])
      expect(store.read('work').knownOrigins).toEqual(['https://replacement.example'])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('tracks the enabled profiles in a dot-file, one per line', () => {
    const { dir, store } = makeStore()
    try {
      expect(store.activeNames()).toEqual([])
      expect(store.active()).toBeNull()
      store.setActive('work')
      expect(store.activeNames()).toEqual(['work'])
      expect(store.active()).toBe('work')
      expect(fs.readFileSync(path.join(dir, ACTIVE_PROFILE_FILE), 'utf8')).toBe('work\n')

      // Setting another name replaces the default; only ever one at a time.
      store.setActive('personal')
      expect(store.activeNames()).toEqual(['personal'])
      expect(store.active()).toBe('personal')

      store.setActive(null)
      expect(store.activeNames()).toEqual([])
      expect(fs.existsSync(path.join(dir, ACTIVE_PROFILE_FILE))).toBe(false)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reads a pre-upgrade single-name file as one enabled profile', () => {
    const { dir, store } = makeStore()
    try {
      // The old format had no trailing newline; an install must not come back
      // signed out just because the file grew a list.
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, ACTIVE_PROFILE_FILE), 'work')
      expect(store.activeNames()).toEqual(['work'])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('ignores blank, duplicate and unusable names in the dot-file', () => {
    const { dir, store } = makeStore()
    try {
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, ACTIVE_PROFILE_FILE), 'work\n\nwork\n../escape\npersonal\n')
      expect(store.activeNames()).toEqual(['work', 'personal'])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('flags the active profile in list()', () => {
    const { store } = makeStore()
    try {
      store.writeMeta('a', null)
      store.writeMeta('b', null)
      store.setActive('b')
      const summaries = store.list()
      expect(summaries.find(profile => profile.name === 'b')?.active).toBe(true)
      expect(summaries.find(profile => profile.name === 'a')?.active).toBe(false)

      // Only one default at a time.
      store.setActive('a')
      expect(store.list().filter(profile => profile.active).map(profile => profile.name)).toEqual(['a'])
    } finally {
      // store() dir cleanup handled by each test's own dir; nothing to do.
    }
  })

  it('treats a missing or corrupt profile as absent rather than crashing', () => {
    const { dir, store } = makeStore()
    try {
      expect(() => store.read('ghost')).toThrow(/missing or unreadable/)
      store.writeMeta('bad', null)
      fs.writeFileSync(path.join(dir, 'bad.json'), '{corrupt')
      expect(() => store.read('bad')).toThrow(/missing or unreadable|corrupt/)
      // list() still returns a zeroed summary for the corrupt file.
      const summary = store.list().find(profile => profile.name === 'bad')
      expect(summary).toMatchObject({ cookieCount: 0, originCount: 0 })
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('availableProfileName', () => {
  it('names a handoff after the site, without the www', () => {
    expect(availableProfileName('www.github.com', [])).toBe('github.com')
    expect(availableProfileName('mail.google.com', [])).toBe('mail.google.com')
  })

  it('takes the next free suffix instead of failing on a collision', () => {
    expect(availableProfileName('github.com', ['github.com'])).toBe('github.com-2')
    expect(availableProfileName('github.com', ['github.com', 'github.com-2'])).toBe('github.com-3')
  })

  it('always returns a name the profile store will accept', () => {
    for (const host of ['', '...', 'exa mple.com', '-weird-', 'a'.repeat(200)]) {
      const name = availableProfileName(host, [])
      expect(() => assertProfileName(name)).not.toThrow()
    }
  })
})

const cookie = (over: Partial<Parameters<typeof cookieMatchesUrl>[0]> = {}) => ({
  name: 'session',
  value: 'abc',
  domain: 'example.com',
  path: '/',
  expires: -1,
  httpOnly: true,
  secure: true,
  sameSite: 'lax' as const,
  ...over,
})

describe('cookieMatchesUrl', () => {
  it('matches a domain cookie on its subdomains but not a host-only one', () => {
    const url = new URL('https://app.example.com/')
    expect(cookieMatchesUrl(cookie(), url)).toBe(true)
    expect(cookieMatchesUrl(cookie({ hostOnly: true }), url)).toBe(false)
    expect(cookieMatchesUrl(cookie({ hostOnly: true, domain: 'app.example.com' }), url)).toBe(true)
  })

  it('does not match a lookalike host that merely ends the same way', () => {
    expect(cookieMatchesUrl(cookie(), new URL('https://notexample.com/'))).toBe(false)
  })

  it('respects the secure flag and path scope', () => {
    expect(cookieMatchesUrl(cookie(), new URL('http://example.com/'))).toBe(false)
    expect(cookieMatchesUrl(cookie({ secure: false }), new URL('http://example.com/'))).toBe(true)
    const scoped = cookie({ path: '/app' })
    expect(cookieMatchesUrl(scoped, new URL('https://example.com/app/inbox'))).toBe(true)
    expect(cookieMatchesUrl(scoped, new URL('https://example.com/apple'))).toBe(false)
  })
})

describe('siteCoversHost', () => {
  it('covers a site and its subdomains, and nothing that merely ends alike', () => {
    expect(siteCoversHost('github.com', 'github.com')).toBe(true)
    expect(siteCoversHost('github.com', 'api.github.com')).toBe(true)
    expect(siteCoversHost('github.com', '.github.com')).toBe(true)
    expect(siteCoversHost('github.com', 'notgithub.com')).toBe(false)
    expect(siteCoversHost('', 'github.com')).toBe(false)
  })

})

describe('summarizeProfileSites', () => {
  const data = {
    cookies: [
      { name: 'session', value: 'SECRET-A', domain: 'github.com', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'lax' as const },
      { name: 'csrf', value: 'SECRET-B', domain: '.github.com', path: '/', expires: -1, httpOnly: false, secure: true, sameSite: 'lax' as const },
      { name: 'sid', value: 'SECRET-C', domain: 'jira.example.com', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'lax' as const },
    ],
    origins: [
      { origin: 'https://github.com', localStorage: [{ name: 'token', value: 'SECRET-D' }, { name: 'theme', value: 'dark' }] },
    ],
  }

  it('groups by domain, most cookies first, folding the leading dot away', () => {
    const sites = summarizeProfileSites(data)
    expect(sites.map(site => [site.domain, site.cookieCount])).toEqual([
      ['github.com', 2],
      ['jira.example.com', 1],
    ])
    expect(sites[0].cookieNames).toEqual(['session', 'csrf'])
    expect(sites[0].storage).toEqual([{ origin: 'https://github.com', keys: 2 }])
  })

  it('never carries a single value out of the profile', () => {
    // This is the whole point of the summary: it says which logins are in
    // there, never what they are. A regression here leaks credentials into a
    // window that has no use for them.
    const serialized = JSON.stringify(summarizeProfileSites(data))
    for (const secret of ['SECRET-A', 'SECRET-B', 'SECRET-C', 'SECRET-D', 'dark']) {
      expect(serialized).not.toContain(secret)
    }
  })

  it('lists an origin that has storage but no cookies', () => {
    const sites = summarizeProfileSites({
      cookies: [],
      origins: [{ origin: 'https://app.example.com', localStorage: [{ name: 'token', value: 'x' }] }],
    })
    expect(sites).toEqual([
      { domain: 'app.example.com', cookieCount: 0, cookieNames: [], storage: [{ origin: 'https://app.example.com', keys: 1 }] },
    ])
  })
})

describe('profilePartition', () => {
  it('gives each profile its own partition and the default jar to none', () => {
    expect(profilePartition(null)).toBe('persist:codey-browser')
    expect(profilePartition('work')).toBe('persist:codey-profile-work')
    expect(profilePartition('personal')).toBe('persist:codey-profile-personal')
  })

  it('never collides two profiles onto one partition', () => {
    expect(profilePartition('work')).not.toBe(profilePartition('work2'))
  })

  it('refuses a name that is not a valid profile name', () => {
    expect(() => profilePartition('../escape')).toThrow(/Profile names must be/)
  })
})

describe('BrowserProfileStore metadata records', () => {
  it('writes metadata without cookies and marks the schema', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-store-meta-'))
    try {
      const store = new BrowserProfileStore(dir)
      store.writeMeta('work', 'https://github.com/')
      const raw = JSON.parse(fs.readFileSync(path.join(dir, 'work.json'), 'utf8'))
      expect(raw.schema).toBe(2)
      expect(raw.cookies).toBeUndefined()
      expect(raw.origins).toBeUndefined()
      expect(raw.sourceUrl).toBe('https://github.com/')
      expect(raw.excludedSites).toEqual([])
      expect(store.read('work').name).toBe('work')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reports a pre-upgrade file as needing migration, once', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-store-migrate-'))
    try {
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'work.json'), JSON.stringify({
        name: 'work',
        cookies: [{
          name: 'sid', value: 'w', domain: 'github.com', path: '/', expires: -1,
          httpOnly: true, secure: true, sameSite: 'lax',
        }],
        origins: [],
        createdAt: 1,
        updatedAt: 2,
        sourceUrl: null,
      }))
      const store = new BrowserProfileStore(dir)
      const pending = store.pendingMigrations()
      expect(pending.map(entry => entry.name)).toEqual(['work'])
      expect(pending[0].data.cookies.map(cookie => cookie.value)).toEqual(['w'])

      store.markMigrated('work')
      expect(store.pendingMigrations()).toEqual([])
      const raw = JSON.parse(fs.readFileSync(path.join(dir, 'work.json'), 'utf8'))
      expect(raw.cookies).toBeUndefined()
      expect(raw.createdAt).toBe(1)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('keeps the touch timestamp moving without touching other metadata', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-store-touch-'))
    try {
      const store = new BrowserProfileStore(dir)
      store.writeMeta('work', null)
      store.setAutoSync('work', true)
      store.setExcludedSites('work', ['GitHub.com'])
      const before = store.read('work').updatedAt
      store.touch('work', before + 1000)
      const after = store.read('work')
      expect(after.updatedAt).toBe(before + 1000)
      expect(after.autoSync).toBe(true)
      expect(after.excludedSites).toEqual(['github.com'])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
