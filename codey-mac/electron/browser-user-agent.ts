import type { Session } from 'electron'

/**
 * Google refuses to sign in inside embedded browsers ("Couldn't sign you in —
 * this browser doesn't support JavaScript"). Two things that look obvious do
 * not work, both checked against the live sign-in page:
 * - the default Electron user agent is flagged as an embedded browser;
 * - a plain Chrome user agent is worse: the page sees Chrome's name without
 *   Chrome's full feature set and answers "This browser or app may not be
 *   secure".
 * What passes is presenting as Firefox, consistently: the user agent for the
 * whole session (pages, workers, popups) plus no `Sec-CH-UA*` client hints,
 * which Firefox never sends.
 */

/** Firefox 145 shipped 2025-11-11; a new major lands every four weeks. */
const FIREFOX_BASE_VERSION = 145
const FIREFOX_BASE_RELEASE = Date.UTC(2025, 10, 11)
const FIREFOX_RELEASE_INTERVAL_MS = 28 * 24 * 60 * 60 * 1000

/** Current Firefox major, so sign-in pages never see a stale browser. */
export function firefoxMajorVersion(now: number = Date.now()): number {
  const releases = Math.floor((now - FIREFOX_BASE_RELEASE) / FIREFOX_RELEASE_INTERVAL_MS)
  return FIREFOX_BASE_VERSION + Math.max(0, releases)
}

export function browserUserAgent(now: number = Date.now()): string {
  const version = firefoxMajorVersion(now)
  return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:${version}.0) Gecko/20100101 Firefox/${version}.0`
}

/** Drops the Chromium client hints, keeping every other header. */
export function withoutClientHints(headers: Record<string, string>): Record<string, string> {
  const kept: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers)) {
    if (!/^sec-ch-ua/i.test(name)) kept[name] = value
  }
  return kept
}

/** Applies the Firefox identity to a Codey Browser session. Electron keeps
 *  one `onBeforeSendHeaders` listener per session, so calling this again
 *  just replaces it. Only for the in-app browser, never the app's own UI. */
export function applyBrowserIdentity(target: Session, now: number = Date.now()): void {
  const userAgent = browserUserAgent(now)
  target.setUserAgent(userAgent)
  target.webRequest.onBeforeSendHeaders((details, callback) => {
    const requestHeaders = withoutClientHints(details.requestHeaders)
    requestHeaders['User-Agent'] = userAgent
    callback({ requestHeaders })
  })
}
