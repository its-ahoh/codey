import { lookup } from 'node:dns/promises'
import { BlockList, isIP } from 'node:net'

/** Link preview cards.
 *
 *  A chat reply that cites a page gets a small card under it — thumbnail,
 *  title, blurb — so the user can tell what a bare URL points at without
 *  leaving the app. The fetch lives in main because the renderer has no
 *  network reach to arbitrary origins (and no cookie jar we'd want to send).
 *
 *  Preview fetching is a "visit whatever the model printed" operation, so it
 *  stays deliberately narrow: http(s) only, one short timeout, a byte cap on
 *  the body, and only the <head> metadata is ever surfaced. */

export interface LinkPreview {
  url: string
  title?: string
  description?: string
  image?: string
  siteName?: string
}

/** Pages routinely put the whole document in one response; we only need the
 *  head, so stop reading well before a large page can tie up memory. */
const MAX_BYTES = 512 * 1024
const TIMEOUT_MS = 8000
const CACHE_TTL_MS = 30 * 60 * 1000
const CACHE_MAX = 200
const MAX_REDIRECTS = 5

const blockedAddresses = new BlockList()
blockedAddresses.addSubnet('0.0.0.0', 8, 'ipv4')
blockedAddresses.addSubnet('10.0.0.0', 8, 'ipv4')
blockedAddresses.addSubnet('100.64.0.0', 10, 'ipv4')
blockedAddresses.addSubnet('127.0.0.0', 8, 'ipv4')
blockedAddresses.addSubnet('169.254.0.0', 16, 'ipv4')
blockedAddresses.addSubnet('172.16.0.0', 12, 'ipv4')
blockedAddresses.addSubnet('192.168.0.0', 16, 'ipv4')
blockedAddresses.addSubnet('224.0.0.0', 4, 'ipv4')
blockedAddresses.addAddress('::', 'ipv6')
blockedAddresses.addAddress('::1', 'ipv6')
blockedAddresses.addSubnet('::ffff:0:0', 96, 'ipv6')
blockedAddresses.addSubnet('fc00::', 7, 'ipv6')
blockedAddresses.addSubnet('fe80::', 10, 'ipv6')
blockedAddresses.addSubnet('ff00::', 8, 'ipv6')

const unsafeIp = (address: string): boolean => {
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, '')
  const family = isIP(normalized)
  if (!family) return true
  return blockedAddresses.check(normalized, family === 4 ? 'ipv4' : 'ipv6')
}

/** Main-process enforcement for the IPC boundary. Renderer filtering is only
 *  presentation logic and must not be the thing protecting local services. */
export async function isSafePreviewUrl(candidate: string): Promise<boolean> {
  let url: URL
  try { url = new URL(candidate) } catch { return false }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return false
  if (isIP(host)) return !unsafeIp(host)
  try {
    const addresses = await lookup(host, { all: true, verbatim: true })
    return addresses.length > 0 && addresses.every(({ address }) => !unsafeIp(address))
  } catch {
    return false
  }
}

const decodeEntities = (raw: string): string =>
  raw
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (whole, body: string) => {
      if (body.startsWith('#x') || body.startsWith('#X')) {
        const code = parseInt(body.slice(2), 16)
        return Number.isFinite(code) ? String.fromCodePoint(code) : whole
      }
      if (body.startsWith('#')) {
        const code = parseInt(body.slice(1), 10)
        return Number.isFinite(code) ? String.fromCodePoint(code) : whole
      }
      const named: Record<string, string> = {
        amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'",
      }
      return named[body.toLowerCase()] ?? whole
    })
    .trim()

/** Pull one attribute out of a raw tag, tolerating single, double or bare
 *  quoting — real-world markup uses all three. */
const attr = (tag: string, name: string): string | undefined => {
  const match = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i').exec(tag)
  if (!match) return undefined
  const value = match[2] ?? match[3] ?? match[4] ?? ''
  return value ? decodeEntities(value) : undefined
}

const absolute = (candidate: string | undefined, base: string): string | undefined => {
  if (!candidate) return undefined
  try {
    const resolved = new URL(candidate, base)
    return resolved.protocol === 'http:' || resolved.protocol === 'https:' ? resolved.toString() : undefined
  } catch {
    return undefined
  }
}

const clamp = (text: string | undefined, max: number): string | undefined => {
  if (!text) return undefined
  const flat = text.replace(/\s+/g, ' ').trim()
  if (!flat) return undefined
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat
}

/** Read Open Graph / Twitter / plain-HTML metadata out of a page.
 *  Later sources never overwrite an earlier, more specific one, so og:*
 *  wins over twitter:* which wins over <title>/<meta name="description">. */
export function parseLinkPreview(html: string, url: string): LinkPreview {
  const head = html.slice(0, MAX_BYTES)
  const meta: Record<string, string> = {}
  for (const match of head.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = match[0]
    const key = (attr(tag, 'property') || attr(tag, 'name'))?.toLowerCase()
    const content = attr(tag, 'content')
    if (key && content && !meta[key]) meta[key] = content
  }

  const pick = (...keys: string[]): string | undefined => {
    for (const key of keys) if (meta[key]) return meta[key]
    return undefined
  }

  const docTitle = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1]
  let icon: string | undefined
  for (const match of head.matchAll(/<link\b[^>]*>/gi)) {
    const rel = attr(match[0], 'rel')?.toLowerCase() || ''
    if (/\b(apple-touch-icon|icon|shortcut)\b/.test(rel)) {
      icon = attr(match[0], 'href')
      if (rel.includes('apple-touch-icon')) break
    }
  }

  let siteName = pick('og:site_name', 'twitter:site', 'application-name')
  if (!siteName) {
    try { siteName = new URL(url).hostname.replace(/^www\./, '') } catch { /* keep it unset */ }
  }

  return {
    url,
    title: clamp(pick('og:title', 'twitter:title') || (docTitle ? decodeEntities(docTitle) : undefined), 120),
    description: clamp(pick('og:description', 'twitter:description', 'description'), 220),
    image: absolute(pick('og:image:secure_url', 'og:image', 'twitter:image', 'twitter:image:src') || icon, url),
    siteName: clamp(siteName, 60),
  }
}

interface CacheEntry { at: number; preview: LinkPreview | null }
const cache = new Map<string, CacheEntry>()

/** Read the body but give up once past the cap — a streaming read keeps a
 *  huge or endless response from filling memory while we wait for the head. */
async function readCapped(response: Response): Promise<string> {
  const body = response.body
  if (!body) return await response.text()
  const reader = body.getReader()
  const decoder = new TextDecoder('utf-8')
  let out = ''
  let seen = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      seen += value.byteLength
      out += decoder.decode(value, { stream: true })
      // The head is all we parse; once it has closed, nothing below matters.
      if (seen >= MAX_BYTES || /<\/head>/i.test(out)) break
    }
  } finally {
    try { await reader.cancel() } catch { /* the socket is already going away */ }
  }
  return out
}

export async function fetchLinkPreview(url: string): Promise<LinkPreview | null> {
  let parsed: URL
  try { parsed = new URL(url) } catch { return null }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null

  const key = parsed.toString()
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.preview

  let preview: LinkPreview | null = null
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), TIMEOUT_MS)
  try {
    let current = key
    let response: Response | null = null
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
      if (!(await isSafePreviewUrl(current))) break
      response = await fetch(current, {
        signal: abort.signal,
        redirect: 'manual',
        headers: {
          // Some sites serve a JS shell to unknown clients; a normal browser
          // Accept header gets us the server-rendered head with the og: tags.
          Accept: 'text/html,application/xhtml+xml',
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 Codey/1.0',
        },
      })
      if (![301, 302, 303, 307, 308].includes(response.status)) break
      const location = response.headers.get('location')
      if (!location || redirects === MAX_REDIRECTS) { response = null; break }
      current = new URL(location, current).toString()
      response = null
    }
    if (response?.ok && /text\/html|application\/xhtml/i.test(response.headers.get('content-type') || '')) {
      preview = parseLinkPreview(await readCapped(response), response.url || current)
    }
  } catch {
    preview = null
  } finally {
    clearTimeout(timer)
  }

  // A failed fetch is cached too: a dead link should not be retried on every
  // re-render of the same message.
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string)
  cache.set(key, { at: Date.now(), preview })
  return preview
}

export function clearLinkPreviewCache(): void {
  cache.clear()
}
