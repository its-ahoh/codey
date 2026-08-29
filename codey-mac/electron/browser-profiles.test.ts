import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { describe, expect, it } from 'vitest'
import {
  ACTIVE_PROFILE_FILE,
  assertProfileName,
  BrowserProfileStore,
  deriveProfileNameFromFile,
  parseProfileData,
  parseProfileJsonText,
  profileFileName,
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
      const written = store.write('work', {
        cookies: [{ name: 'sid', value: 'abc', domain: 'example.com', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'lax' }],
        origins: [],
      }, 'https://example.com/')
      expect(written.name).toBe('work')
      expect(written.avatar).toBeNull()
      expect(written.createdAt).toBeGreaterThanOrEqual(before)
      expect(written.sourceUrl).toBe('https://example.com/')

      const read = store.read('work')
      expect(read.cookies).toHaveLength(1)
      expect(read.cookies[0].value).toBe('abc')

      // Re-writing keeps the original createdAt and refreshes updatedAt.
      const again = store.write('work', { cookies: [], origins: [] }, null)
      expect(again.createdAt).toBe(written.createdAt)
      expect(again.updatedAt).toBeGreaterThanOrEqual(written.updatedAt)
      expect(again.sourceUrl).toBe('https://example.com/')

      store.write('zebra', { cookies: [], origins: [] }, null)
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

  it('tracks the active profile in a dot-file', () => {
    const { dir, store } = makeStore()
    try {
      expect(store.active()).toBeNull()
      store.setActive('work')
      expect(store.active()).toBe('work')
      expect(fs.readFileSync(path.join(dir, ACTIVE_PROFILE_FILE), 'utf8')).toBe('work')
      store.setActive(null)
      expect(store.active()).toBeNull()
      expect(fs.existsSync(path.join(dir, ACTIVE_PROFILE_FILE))).toBe(false)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('flags the active profile in list()', () => {
    const { store } = makeStore()
    try {
      store.write('a', { cookies: [], origins: [] }, null)
      store.write('b', { cookies: [], origins: [] }, null)
      store.setActive('b')
      const summaries = store.list()
      expect(summaries.find(profile => profile.name === 'b')?.active).toBe(true)
      expect(summaries.find(profile => profile.name === 'a')?.active).toBe(false)
    } finally {
      // store() dir cleanup handled by each test's own dir; nothing to do.
    }
  })

  it('treats a missing or corrupt profile as absent rather than crashing', () => {
    const { dir, store } = makeStore()
    try {
      expect(() => store.read('ghost')).toThrow(/missing or unreadable/)
      store.write('bad', { cookies: [], origins: [] }, null)
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
