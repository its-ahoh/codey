import { describe, expect, it, vi } from 'vitest'
import {
  availability,
  compareVersions,
  createLatestVersionsCache,
  fetchAllLatestVersions,
  fetchLatestVersion,
  parseVersion,
} from './agent-latest'

describe('parseVersion', () => {
  it('finds the version inside what each CLI actually prints', () => {
    expect(parseVersion('2.1.238 (Claude Code)')).toBe('2.1.238')
    expect(parseVersion('codex-cli 0.148.0')).toBe('0.148.0')
    expect(parseVersion('1.14.18')).toBe('1.14.18')
    expect(parseVersion('v0.84.2')).toBe('0.84.2')
    expect(parseVersion('1.2.3-beta.4')).toBe('1.2.3-beta.4')
  })

  it('is null when there is no version in there', () => {
    expect(parseVersion('command not found')).toBeNull()
    expect(parseVersion('')).toBeNull()
    expect(parseVersion(undefined)).toBeNull()
  })
})

describe('compareVersions', () => {
  it('orders by each number, not by text', () => {
    expect(compareVersions('1.14.18', '1.9.0')).toBeGreaterThan(0)
    expect(compareVersions('0.148.0', '0.149.1')).toBeLessThan(0)
    expect(compareVersions('2.1.238', '2.1.238')).toBe(0)
  })

  it('puts a prerelease before the release it leads to', () => {
    expect(compareVersions('1.2.3-beta.1', '1.2.3')).toBeLessThan(0)
    expect(compareVersions('1.2.3', '1.2.3-beta.1')).toBeGreaterThan(0)
  })

  it('treats a missing segment as zero', () => {
    expect(compareVersions('1.2', '1.2.0')).toBe(0)
    expect(compareVersions('1.2', '1.2.1')).toBeLessThan(0)
  })
})

describe('availability', () => {
  it('offers an update only when the published one is genuinely newer', () => {
    expect(availability('1.14.18', '1.18.23')).toMatchObject({ updateAvailable: true, unknown: false })
    expect(availability('1.18.23', '1.18.23')).toMatchObject({ updateAvailable: false, unknown: false })
    // Homebrew can lag the registry; a local build can also run ahead of it.
    expect(availability('2.0.0', '1.9.9')).toMatchObject({ updateAvailable: false, unknown: false })
  })

  it('says unknown — never "up to date" — when either side is missing', () => {
    expect(availability('1.0.0', null)).toMatchObject({ updateAvailable: false, unknown: true })
    expect(availability(undefined, '1.0.0')).toMatchObject({ updateAvailable: false, unknown: true })
  })
})

describe('fetchLatestVersion', () => {
  it('reads the version off the registry document', async () => {
    const urls: string[] = []
    const fetchImpl = (async (url: string) => {
      urls.push(url)
      return { ok: true, json: async () => ({ version: '1.18.23' }) }
    }) as any
    expect(await fetchLatestVersion('opencode-ai', fetchImpl)).toBe('1.18.23')
    expect(urls[0]).toBe('https://registry.npmjs.org/opencode-ai/latest')
  })

  it('is null on a bad response, a broken body, or a thrown request', async () => {
    const notOk = (async () => ({ ok: false, json: async () => ({}) })) as any
    expect(await fetchLatestVersion('x', notOk)).toBeNull()
    const noVersion = (async () => ({ ok: true, json: async () => ({}) })) as any
    expect(await fetchLatestVersion('x', noVersion)).toBeNull()
    const throws = (async () => { throw new Error('offline') }) as any
    expect(await fetchLatestVersion('x', throws)).toBeNull()
  })
})

describe('fetchAllLatestVersions', () => {
  it('looks every agent up, keeping the ones that failed as null', async () => {
    const fetchImpl = (async (url: string) => ({
      ok: !url.includes('codex'),
      json: async () => ({ version: '9.9.9' }),
    })) as any
    const r = await fetchAllLatestVersions(fetchImpl, { 'codex': '@openai/codex', 'pi': 'pi-pkg' })
    expect(r).toEqual({ codex: null, pi: '9.9.9' })
  })
})

describe('createLatestVersionsCache', () => {
  it('serves the cached answer until the TTL runs out', async () => {
    const fetchAll = vi.fn(async () => ({ pi: '1.0.0' }))
    let t = 0
    const get = createLatestVersionsCache(fetchAll, { ttlMs: 100, now: () => t })
    await get()
    await get()
    expect(fetchAll).toHaveBeenCalledTimes(1)
    t = 101
    await get()
    expect(fetchAll).toHaveBeenCalledTimes(2)
  })

  it('re-looks-up on force', async () => {
    const fetchAll = vi.fn(async () => ({ pi: '1.0.0' }))
    const get = createLatestVersionsCache(fetchAll, { now: () => 0 })
    await get()
    await get(true)
    expect(fetchAll).toHaveBeenCalledTimes(2)
  })

  it('does not cache a round where every lookup failed', async () => {
    const fetchAll = vi.fn(async () => ({ pi: null }))
    const get = createLatestVersionsCache(fetchAll, { now: () => 0 })
    await get()
    await get()
    expect(fetchAll).toHaveBeenCalledTimes(2)
  })
})
