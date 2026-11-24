import { describe, expect, it, vi } from 'vitest'
import { applyBrowserIdentity, browserUserAgent, firefoxMajorVersion, withoutClientHints } from './browser-user-agent'

describe('browser identity', () => {
  it('tracks the current Firefox major on the four-week cadence', () => {
    expect(firefoxMajorVersion(Date.UTC(2025, 10, 11))).toBe(145)
    expect(firefoxMajorVersion(Date.UTC(2025, 11, 9))).toBe(146)
    expect(firefoxMajorVersion(Date.UTC(2020, 0, 1))).toBe(145)
  })

  it('presents as Firefox with no Electron or app token', () => {
    const ua = browserUserAgent(Date.UTC(2025, 10, 11))
    expect(ua).toBe('Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:145.0) Gecko/20100101 Firefox/145.0')
    expect(ua).not.toMatch(/Electron|Codey|Chrome/)
  })

  it('strips Chromium client hints and keeps the rest', () => {
    expect(withoutClientHints({
      'Sec-CH-UA': '"Chromium";v="146"',
      'sec-ch-ua-mobile': '?0',
      'Sec-CH-UA-Platform': '"macOS"',
      Accept: 'text/html',
      'Sec-Fetch-Mode': 'navigate',
    })).toEqual({ Accept: 'text/html', 'Sec-Fetch-Mode': 'navigate' })
  })

  it('sets the session user agent and rewrites outgoing headers', () => {
    let listener: ((details: { requestHeaders: Record<string, string> }, cb: (r: unknown) => void) => void) | undefined
    const target = {
      setUserAgent: vi.fn(),
      webRequest: { onBeforeSendHeaders: vi.fn(fn => { listener = fn }) },
    }
    applyBrowserIdentity(target as never, Date.UTC(2025, 10, 11))
    const ua = browserUserAgent(Date.UTC(2025, 10, 11))
    expect(target.setUserAgent).toHaveBeenCalledWith(ua)

    const callback = vi.fn()
    listener!({ requestHeaders: { 'User-Agent': 'Electron', 'sec-ch-ua': 'x', Cookie: 'a=1' } }, callback)
    expect(callback).toHaveBeenCalledWith({ requestHeaders: { 'User-Agent': ua, Cookie: 'a=1' } })
  })
})
