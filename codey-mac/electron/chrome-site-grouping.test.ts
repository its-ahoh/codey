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
const siteOfHost = new Function(`${source}; return siteOfHost`)() as (host: string) => string

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
  })
})
