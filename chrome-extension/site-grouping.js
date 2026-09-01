// Folding a cookie's host down to the site a user would recognise.
//
// A user picks "github.com" and means its api. and gist. cookies too, so the
// picker has to group hosts. The grouping is the authorization boundary: on a
// shared-hosting suffix (github.io, appspot.com, pages.dev), two labels would
// merge every tenant into one "site", and ticking one tenant would quietly
// export a stranger's cookies too. So this uses the real Public Suffix List
// (tldts, vendored in vendor/tldts.min.js and loaded before this file), with
// its private section on - that is the part that knows github.io is a suffix.
//
// The two-label heuristic below survives only as a fallback for the test-less
// case where tldts failed to load; it must never be the primary answer.
//
// Kept in its own file, free of Chrome APIs, so the service worker can
// `importScripts` it and the tests can evaluate it on its own (with the real
// `tldts` package injected as the global).

const MULTI_LABEL_SUFFIXES = new Set(['co', 'com', 'net', 'org', 'gov', 'edu', 'ac'])

function fallbackSiteOfHost(labels) {
  if (labels.length <= 2) return labels.join('.')
  const last = labels[labels.length - 1]
  const secondLast = labels[labels.length - 2]
  const take = last.length === 2 && MULTI_LABEL_SUFFIXES.has(secondLast) ? 3 : 2
  return labels.slice(-take).join('.')
}

function siteOfHost(host) {
  const cleaned = String(host || '').replace(/^\./, '').toLowerCase()
  const labels = cleaned.split('.').filter(Boolean)
  if (labels.length === 0) return ''
  const psl = typeof tldts !== 'undefined' ? tldts : globalThis.tldts
  if (psl && typeof psl.getDomain === 'function') {
    const site = psl.getDomain(cleaned, { allowPrivateDomains: true })
    // null means an IP, localhost, or a bare public suffix - each of those is
    // its own "site" rather than something to fold further.
    return site || labels.join('.')
  }
  return fallbackSiteOfHost(labels)
}

// Opening at most this many pages for one copy. Each one is a real navigation
// in the user's Chrome, so the ceiling is low on purpose - and the command has
// to come back inside Codey's timeout.
const STORAGE_VISIT_LIMIT = 8

/**
 * Which picked sites still have no site storage, and the URL to open to get it.
 *
 * Cookies come out of the cookie store without anything being open, but
 * localStorage can only be read by running inside the page, so a site with no
 * tab open is copied by its cookies alone. When the user opts in, this decides
 * the shortest list of pages worth opening: sites already covered by an open
 * tab are skipped, and each remaining site is visited on the host that carries
 * the most of its cookies - `www.notion.so` rather than `notion.so`, because
 * the two are different origins and only one of them holds the login.
 *
 * Chrome-API-free so it can be tested without a browser.
 */
function storageVisitPlan(wantedSites, cookieHosts, capturedOrigins, limit = STORAGE_VISIT_LIMIT) {
  const covered = new Set()
  for (const origin of capturedOrigins || []) {
    try { covered.add(siteOfHost(new URL(origin).hostname)) } catch { /* not an origin we can place */ }
  }
  const hostsBySite = new Map()
  for (const raw of cookieHosts || []) {
    const host = String(raw || '').replace(/^\./, '').toLowerCase()
    const site = siteOfHost(host)
    if (!host || !site) continue
    const counts = hostsBySite.get(site) || new Map()
    counts.set(host, (counts.get(host) || 0) + 1)
    hostsBySite.set(site, counts)
  }
  const plan = []
  for (const site of wantedSites || []) {
    if (plan.length >= limit) break
    if (covered.has(site) || !hostsBySite.has(site)) continue
    let host = site
    let best = -1
    for (const [candidate, count] of hostsBySite.get(site)) {
      // Most cookies wins; the shorter host breaks a tie, being the more
      // canonical of two hosts that look equally used.
      if (count > best || (count === best && candidate.length < host.length)) {
        host = candidate
        best = count
      }
    }
    plan.push({ site, url: `https://${host}/` })
  }
  return plan
}
