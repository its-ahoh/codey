// Folding a cookie's host down to the site a user would recognise.
//
// A user picks "github.com" and means its api. and gist. cookies too, so the
// picker has to group hosts. Chrome exposes no public-suffix API to an
// extension and shipping the whole PSL for this would be absurd, so this uses
// the usual heuristic: two labels, or three when the last is a country code
// sitting behind one of the common second levels (co.uk, com.cn, com.au).
//
// It over-groups shared-suffix hosting (every user site under github.io reads
// as one site), which is why the picker shows cookie counts and the copy is
// confirmed - the user sees how much is going before it goes.
//
// Kept in its own file, free of Chrome APIs, so the service worker can
// `importScripts` it and the tests can evaluate it on its own.

const MULTI_LABEL_SUFFIXES = new Set(['co', 'com', 'net', 'org', 'gov', 'edu', 'ac'])

function siteOfHost(host) {
  const labels = String(host || '').replace(/^\./, '').toLowerCase().split('.').filter(Boolean)
  if (labels.length <= 2) return labels.join('.')
  const last = labels[labels.length - 1]
  const secondLast = labels[labels.length - 2]
  const take = last.length === 2 && MULTI_LABEL_SUFFIXES.has(secondLast) ? 3 : 2
  return labels.slice(-take).join('.')
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
