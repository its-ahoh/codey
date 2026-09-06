/** Which URLs in a reply deserve a preview card.
 *
 *  Only links the user could plausibly want to open: real http(s) pages, not
 *  images the markdown already renders, not localhost/gateway plumbing, and
 *  never more than a couple so a link-heavy answer stays readable. */

const URL_RE = /https?:\/\/[^\s<>"'`)\]}]+/gi
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|ico|avif)(\?|#|$)/i
const FILE_EXT = /\.(zip|tar|gz|tgz|dmg|pkg|exe|mp[34]|mov|wav|pdf)(\?|#|$)/i

export const MAX_PREVIEW_CARDS = 3

/** Trailing punctuation belongs to the sentence, not the link — markdown and
 *  plain prose both leave it stuck to the end. */
const trimTail = (raw: string): string => {
  let url = raw
  for (;;) {
    const next = url.replace(/[.,;:!?'"“”’)\]}]+$/, '')
    if (next === url) break
    url = next
  }
  return url
}

const isLocal = (host: string): boolean =>
  host === 'localhost'
  || host === '127.0.0.1'
  || host === '::1'
  || host.endsWith('.local')
  || /^(10|127)\./.test(host)
  || /^192\.168\./.test(host)
  || /^172\.(1[6-9]|2\d|3[01])\./.test(host)

export function extractPreviewUrls(text: string, limit = MAX_PREVIEW_CARDS): string[] {
  if (!text) return []
  // Fenced code and inline code are quoted material, not links being shared.
  const prose = text.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`]*`/g, ' ')
  const seen = new Set<string>()
  const out: string[] = []
  for (const match of prose.match(URL_RE) || []) {
    const url = trimTail(match)
    let parsed: URL
    try { parsed = new URL(url) } catch { continue }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue
    if (isLocal(parsed.hostname)) continue
    if (IMAGE_EXT.test(parsed.pathname) || FILE_EXT.test(parsed.pathname)) continue
    const key = parsed.toString()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(key)
    if (out.length >= limit) break
  }
  return out
}
