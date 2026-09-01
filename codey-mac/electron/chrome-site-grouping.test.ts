import * as fs from 'fs'
import * as path from 'path'
import { describe, expect, it } from 'vitest'

/**
 * `siteOfHost` decides which cookies a ticked site takes with it, so getting it
 * wrong means copying a login the user did not pick. It ships as plain worker
 * script (Chrome loads it with `importScripts`, which rules out ES exports), so
 * the test evaluates the file itself rather than a second copy that could drift.
 */
const source = fs.readFileSync(
  path.join(__dirname, '..', '..', 'chrome-extension', 'site-grouping.js'),
  'utf8',
)
// In Chrome the service worker importScripts the vendored tldts bundle before
// this file; the test injects the same package as the same global.
;(globalThis as any).tldts = require('tldts')
const siteOfHost = new Function(`${source}; return siteOfHost`)() as (host: string) => string
type VisitPlan = Array<{ site: string; url: string }>
const storageVisitPlan = new Function(`${source}; return storageVisitPlan`)() as (
  wanted: string[],
  cookieHosts: string[],
  capturedOrigins: string[],
  limit?: number,
) => VisitPlan

describe('siteOfHost', () => {
  it('folds subdomains into the site a user would recognise', () => {
    expect(siteOfHost('api.github.com')).toBe('github.com')
    expect(siteOfHost('gist.github.com')).toBe('github.com')
    expect(siteOfHost('github.com')).toBe('github.com')
  })

  it('strips the leading dot of a domain cookie and lowercases', () => {
    expect(siteOfHost('.GitHub.com')).toBe('github.com')
  })

  it('keeps three labels behind a country-code second level', () => {
    expect(siteOfHost('www.bbc.co.uk')).toBe('bbc.co.uk')
    expect(siteOfHost('shop.example.com.au')).toBe('example.com.au')
    // Without this, ticking one .co.uk site would drag in every other one.
    expect(siteOfHost('a.co.uk')).not.toBe(siteOfHost('b.co.uk'))
  })

  it('does not mistake a long second level for a country code', () => {
    expect(siteOfHost('mail.example.info')).toBe('example.info')
    expect(siteOfHost('a.b.corp.example.io')).toBe('example.io')
  })

  it('returns something harmless for input that is not a host', () => {
    for (const input of ['', '.', 'localhost']) {
      expect(typeof siteOfHost(input)).toBe('string')
    }
    expect(siteOfHost('localhost')).toBe('localhost')
    expect(siteOfHost('127.0.0.1')).toBe('127.0.0.1')
  })

  it('keeps tenants on shared-hosting suffixes apart', () => {
    // Ticking one tenant must not drag a stranger's cookies along: on these
    // suffixes each subdomain is a different owner, and the real PSL (private
    // section included) is what knows that.
    expect(siteOfHost('alice.github.io')).toBe('alice.github.io')
    expect(siteOfHost('alice.github.io')).not.toBe(siteOfHost('bob.github.io'))
    expect(siteOfHost('tenant-a.appspot.com')).not.toBe(siteOfHost('tenant-b.appspot.com'))
    expect(siteOfHost('mine.pages.dev')).not.toBe(siteOfHost('theirs.pages.dev'))
  })
})

/**
 * `storageVisitPlan` decides which pages Chrome opens for real when the user
 * opts in to copying site storage, so an over-eager plan means tabs the user
 * did not ask for and a wrong host means reading the storage of an origin that
 * does not hold the login.
 */
describe('storageVisitPlan', () => {
  it('skips a site whose storage an open tab already covered', () => {
    const plan = storageVisitPlan(
      ['github.com', 'notion.so'],
      ['.github.com', '.notion.so'],
      ['https://github.com'],
    )
    expect(plan.map(entry => entry.site)).toEqual(['notion.so'])
  })

  it('visits the host carrying the most of a site\u2019s cookies', () => {
    const plan = storageVisitPlan(
      ['notion.so'],
      ['www.notion.so', 'www.notion.so', 'www.notion.so', '.notion.so'],
      [],
    )
    expect(plan).toEqual([{ site: 'notion.so', url: 'https://www.notion.so/' }])
  })

  it('prefers the shorter host when two are equally used', () => {
    const plan = storageVisitPlan(['notion.so'], ['notion.so', 'www.notion.so'], [])
    expect(plan).toEqual([{ site: 'notion.so', url: 'https://notion.so/' }])
  })

  it('has nothing to open for a site with no cookies at all', () => {
    expect(storageVisitPlan(['ghost.example'], ['.github.com'], [])).toEqual([])
  })

  it('never plans more pages than the cap allows', () => {
    const sites = Array.from({ length: 12 }, (_, index) => `site${index}.com`)
    expect(storageVisitPlan(sites, sites, [], 8)).toHaveLength(8)
  })

  it('treats an unparseable captured origin as covering nothing', () => {
    const plan = storageVisitPlan(['github.com'], ['.github.com'], ['not a url'])
    expect(plan).toEqual([{ site: 'github.com', url: 'https://github.com/' }])
  })
})
