import * as fs from 'fs'
import * as path from 'path'

/**
 * Browser profiles: named, portable snapshots of the Codey Browser's session
 * state. A profile holds the cookies plus the per-origin localStorage of the
 * partition the browser uses, so it captures everything that keeps a site
 * signed in — and activating one switches the live session to that identity.
 *
 * The on-disk shape is deliberately compatible with Playwright's
 * `storageState` (\`{ cookies, origins: [{ origin, localStorage }] }\`), so a
 * session exported from Playwright (or from another Codey install) imports
 * as-is. Profile files live one-per-name under a store directory and the
 * active profile is recorded in a dot-file next to them.
 */

/** A cookie as stored in a profile: Playwright's storageState cookie shape,
 *  plus Electron's sameSite vocabulary and a hostOnly flag for fidelity. */
export interface BrowserProfileCookie {
  name: string
  value: string
  /** Host without a leading dot; host-only vs domain cookies are told apart
   *  by `hostOnly`. */
  domain: string
  path: string
  /** Seconds since the epoch; -1 means a session cookie (Playwright's
   *  convention for "expires with the session"). */
  expires: number
  httpOnly: boolean
  secure: boolean
  sameSite: 'unspecified' | 'no_restriction' | 'lax' | 'strict'
  hostOnly?: boolean
}

export interface BrowserProfileStorageOrigin {
  origin: string
  localStorage: Array<{ name: string; value: string }>
}

export interface BrowserProfileData {
  cookies: BrowserProfileCookie[]
  origins: BrowserProfileStorageOrigin[]
}

export interface BrowserProfile extends BrowserProfileData {
  name: string
  /** User-selected visual marker shown in the browser profile switcher. */
  avatar?: string | null
  createdAt: number
  updatedAt: number
  /** The page that was showing when the profile was saved; null for imports. */
  sourceUrl: string | null
}

export interface BrowserProfileSummary {
  name: string
  avatar?: string | null
  createdAt: number
  updatedAt: number
  cookieCount: number
  originCount: number
  active: boolean
  sourceUrl: string | null
}

/** The dot-file that records which profiles are enabled, one name per line.
 *  It used to hold a single name; that reads back as a one-profile set, so an
 *  existing install keeps its browser signed in across the upgrade. */
export const ACTIVE_PROFILE_FILE = '.active'

export const BROWSER_PROFILE_AVATARS = [
  '👤', '💼', '🏠', '🚀', '🧑‍💻', '🎨', '🌟', '🦊',
  '🐱', '🐶', '🐼', '🐸', '🦁', '🐯', '🐵', '🐧',
  '🌈', '🔥', '⚡️', '💎', '🎯', '🧠', '🤖', '👻',
  '☕️', '📚', '🎮', '🎵', '📷', '✈️', '🌍', '🍀',
] as const

export function assertProfileAvatar(avatar: unknown): asserts avatar is string {
  if (typeof avatar !== 'string' || !(BROWSER_PROFILE_AVATARS as readonly string[]).includes(avatar)) {
    throw new Error('Choose one of the available profile avatars')
  }
}

/** Profile names are file names inside the store directory, so they must be
 *  safe on every platform: no separators, no leading dot (hidden files), and
 *  a sane length. */
export function assertProfileName(name: unknown): asserts name is string {
  if (
    typeof name !== 'string'
    || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(name)
    || name === '.'
    || name === '..'
  ) {
    throw new Error('Profile names must be 1-64 characters of letters, digits, dots, dashes or underscores, and must not start with a dot')
  }
}

/** Derive a safe profile name from an import file's name, so importing
 *  "my session backup.json" just works without asking for a name. Falls back
 *  to `imported` when nothing usable remains. */
export function deriveProfileNameFromFile(filePath: string): string {
  const base = String(filePath || '').replace(/\\/g, '/').split('/').pop() || ''
  const name = base
    .replace(/\.json$/i, '')
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .replace(/^[.\-]+|[.\-]+$/g, '')
    .replace(/-+/g, '-')
    .slice(0, 64)
  if (!name) return 'imported'
  try {
    assertProfileName(name)
    return name
  } catch {
    return 'imported'
  }
}

/** Pick a profile name for a one-click handoff of `hostname`'s session. The
 *  user never typed this name, so a collision must not be an error - the next
 *  free suffix is taken instead. */
export function availableProfileName(hostname: string, taken: readonly string[]): string {
  const base = String(hostname || '')
    .replace(/^www\./i, '')
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .replace(/^[.\-]+|[.\-]+$/g, '')
    .replace(/-+/g, '-')
    .slice(0, 56) || 'chrome'
  const used = new Set(taken)
  if (!used.has(base)) return base
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const candidate = `${base}-${suffix}`
    if (!used.has(candidate)) return candidate
  }
  throw new Error(`Too many saved profiles for ${base} - delete some in Codey Browser settings`)
}

export function profileFileName(name: string): string {
  assertProfileName(name)
  return `${name}.json`
}

const SAMESITE_ALIASES: Record<string, BrowserProfileCookie['sameSite']> = {
  strict: 'strict',
  lax: 'lax',
  none: 'no_restriction',
  no_restriction: 'no_restriction',
  unspecified: 'unspecified',
}

function normalizeCookie(value: unknown): BrowserProfileCookie {
  if (typeof value !== 'object' || value === null) throw new Error('profile cookies must be objects')
  const cookie = value as Record<string, unknown>
  const name = typeof cookie.name === 'string' && cookie.name ? cookie.name : null
  const domain = typeof cookie.domain === 'string' && cookie.domain.trim() ? cookie.domain.trim().replace(/^\./, '') : null
  if (!name || !domain) throw new Error('each profile cookie needs a name and a domain')
  const rawPath = typeof cookie.path === 'string' && cookie.path ? cookie.path : '/'
  const sameSiteRaw = typeof cookie.sameSite === 'string' ? cookie.sameSite.toLowerCase() : 'lax'
  return {
    name,
    value: typeof cookie.value === 'string' ? cookie.value : String(cookie.value ?? ''),
    domain,
    path: rawPath.startsWith('/') ? rawPath : `/${rawPath}`,
    expires: typeof cookie.expires === 'number' && Number.isFinite(cookie.expires) ? cookie.expires : -1,
    httpOnly: cookie.httpOnly === true,
    secure: cookie.secure === true,
    sameSite: SAMESITE_ALIASES[sameSiteRaw] ?? 'lax',
    ...(cookie.hostOnly === true ? { hostOnly: true } : {}),
  }
}

function normalizeOrigin(value: unknown): BrowserProfileStorageOrigin {
  if (typeof value !== 'object' || value === null) throw new Error('profile origins must be objects')
  const record = value as Record<string, unknown>
  const rawOrigin = typeof record.origin === 'string' && record.origin.trim() ? record.origin.trim() : null
  let origin: string
  try {
    const parsed = new URL(rawOrigin ?? '')
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('not http(s)')
    origin = parsed.origin
  } catch {
    throw new Error(`invalid profile origin: ${rawOrigin ?? ''}`)
  }
  const items = Array.isArray(record.localStorage) ? record.localStorage : []
  const localStorage = items.map(item => {
    if (typeof item !== 'object' || item === null) throw new Error('localStorage entries must be objects')
    const entry = item as Record<string, unknown>
    const name = typeof entry.name === 'string' && entry.name ? entry.name : null
    if (!name) throw new Error('localStorage entries need a name')
    return { name, value: typeof entry.value === 'string' ? entry.value : String(entry.value ?? '') }
  })
  return { origin, localStorage }
}

/** Parse a profile file's JSON payload: a full profile (with metadata) or bare
 *  data (a Playwright storageState). Throws on malformed input. */
export function parseProfileData(input: unknown): BrowserProfileData {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('profile must be a JSON object')
  }
  const value = input as Record<string, unknown>
  const cookies = Array.isArray(value.cookies) ? value.cookies.map(normalizeCookie) : []
  const origins = Array.isArray(value.origins) ? value.origins.map(normalizeOrigin) : []
  return { cookies, origins }
}

/** Parse a profile's JSON text (an inline import source). */
export function parseProfileJsonText(text: string): BrowserProfileData {
  try {
    return parseProfileData(JSON.parse(text))
  } catch (error) {
    throw new Error(`Invalid profile JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** Read and parse a profile file from disk (an import source). */
export function readProfileJson(filePath: string): BrowserProfileData {
  let text: string
  try {
    text = fs.readFileSync(path.resolve(String(filePath)), 'utf8')
  } catch (error) {
    throw new Error(`Cannot read profile file: ${error instanceof Error ? error.message : String(error)}`)
  }
  try {
    return parseProfileData(JSON.parse(text))
  } catch (error) {
    throw new Error(`Invalid profile file ${filePath}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** Does `cookie` apply to `url`? This mirrors the scope Chrome answers
 *  `cookies.getAll({ url })` with, so a profile we already hold can be asked
 *  which of its cookies a fresh export of that URL would have spoken for. */
export function cookieMatchesUrl(cookie: BrowserProfileCookie, url: URL): boolean {
  const host = url.hostname.toLowerCase()
  const domain = cookie.domain.toLowerCase()
  const domainMatches = cookie.hostOnly ? host === domain : host === domain || host.endsWith(`.${domain}`)
  if (!domainMatches) return false
  if (cookie.secure && url.protocol !== 'https:') return false
  const cookiePath = cookie.path || '/'
  if (cookiePath === '/') return true
  const requestPath = url.pathname || '/'
  if (!requestPath.startsWith(cookiePath)) return false
  return requestPath.length === cookiePath.length
    || cookiePath.endsWith('/')
    || requestPath[cookiePath.length] === '/'
}

/** Fold a freshly exported session for one URL into a profile that already
 *  exists. Only what that export can speak for is replaced - cookies in the
 *  URL's scope, and the localStorage of the origins the export actually
 *  carried - so a profile holding several sites keeps the others intact.
 *  Replacing rather than layering also means a cookie the site has since
 *  dropped disappears here instead of lingering as a stale credential. */
export function mergeProfileData(
  existing: BrowserProfileData,
  incoming: BrowserProfileData,
  scopeUrl: string,
): BrowserProfileData {
  let url: URL
  try {
    url = new URL(scopeUrl)
  } catch {
    throw new Error(`Invalid session scope URL: ${scopeUrl}`)
  }
  const refreshed = new Set(incoming.origins.map(origin => origin.origin))
  return {
    cookies: [...existing.cookies.filter(cookie => !cookieMatchesUrl(cookie, url)), ...incoming.cookies],
    origins: [...existing.origins.filter(origin => !refreshed.has(origin.origin)), ...incoming.origins],
  }
}

/** The first cookie two profiles both hold with different values, or null when
 *  they can safely be enabled together. Same key and same value is not a
 *  conflict - honouring either one gives the same live session. */
export function conflictingCookie(
  left: BrowserProfileData,
  right: BrowserProfileData,
): BrowserProfileCookie | null {
  const key = (cookie: BrowserProfileCookie) => `${cookie.domain}\u0000${cookie.path}\u0000${cookie.name}`
  const held = new Map(left.cookies.map(cookie => [key(cookie), cookie]))
  for (const cookie of right.cookies) {
    const other = held.get(key(cookie))
    if (other && other.value !== cookie.value) return cookie
  }
  return null
}

/** The first localStorage key two profiles both hold for the same origin with
 *  different values, or null. Cookies are not the only place a login lives, so
 *  the "one value would silently win" rule has to cover storage too. */
export function conflictingStorageKey(
  left: BrowserProfileData,
  right: BrowserProfileData,
): { origin: string; key: string } | null {
  const held = new Map<string, string>()
  for (const origin of left.origins) {
    for (const item of origin.localStorage) {
      held.set(`${origin.origin} ${item.name}`, item.value)
    }
  }
  for (const origin of right.origins) {
    for (const item of origin.localStorage) {
      const other = held.get(`${origin.origin} ${item.name}`)
      if (other !== undefined && other !== item.value) return { origin: origin.origin, key: item.name }
    }
  }
  return null
}

/** Why two profiles cannot be live at the same time, or null when they can.
 *  One shared check so enabling, re-syncing and importing all refuse the same
 *  overlaps instead of each path missing a different one. */
export function profileConflict(
  left: BrowserProfileData,
  right: BrowserProfileData,
): string | null {
  const cookie = conflictingCookie(left, right)
  if (cookie) return `a different ${cookie.name} cookie for ${cookie.domain}`
  const storage = conflictingStorageKey(left, right)
  if (storage) return `different site storage (${storage.key}) for ${storage.origin}`
  return null
}

/** Does `site` (a registrable domain, as Chrome grouped it) cover `host`?
 *  Used to decide which of a profile's cookies a refresh of that site speaks
 *  for, without needing the public-suffix guesswork on this side: the sites
 *  come back from the extension already folded. */
export function siteCoversHost(site: string, host: string): boolean {
  const left = site.replace(/^\./, '').toLowerCase()
  const right = host.replace(/^\./, '').toLowerCase()
  return !!left && (right === left || right.endsWith(`.${left}`))
}

/** Fold a fresh multi-site export into a profile. Only the sites the export
 *  covers are replaced - everything else the profile holds is left alone, so
 *  refreshing what Chrome knows about cannot delete a login that came from
 *  somewhere else. Replacing rather than layering means a cookie the site has
 *  dropped disappears instead of lingering as a stale credential. */
export function mergeProfileSites(
  existing: BrowserProfileData,
  incoming: BrowserProfileData,
  sites: readonly string[],
): BrowserProfileData {
  const covers = (host: string) => sites.some(site => siteCoversHost(site, host));
  const originHost = (origin: string) => {
    try {
      return new URL(origin).hostname
    } catch {
      return ''
    }
  }
  return {
    cookies: [...existing.cookies.filter(cookie => !covers(cookie.domain)), ...incoming.cookies],
    origins: [
      ...existing.origins.filter(origin => !covers(originHost(origin.origin))),
      ...incoming.origins,
    ],
  }
}

/** What one site inside a profile holds, described without the secrets. Cookie
 *  and localStorage *values* are deliberately absent: the point is to let
 *  someone see which logins a profile carries, not to hand the logins to a
 *  window that has no use for them. Names are kept - they are what tells a
 *  session cookie apart from a theme preference at a glance. */
export interface BrowserProfileSiteSummary {
  domain: string
  cookieCount: number
  cookieNames: string[]
  storage: Array<{ origin: string; keys: number }>
}

/** Describe a profile site by site, most cookies first. */
export function summarizeProfileSites(data: BrowserProfileData): BrowserProfileSiteSummary[] {
  const rows = new Map<string, BrowserProfileSiteSummary>()
  const rowFor = (host: string): BrowserProfileSiteSummary => {
    const domain = host.replace(/^\./, '').toLowerCase()
    let row = rows.get(domain)
    if (!row) {
      row = { domain, cookieCount: 0, cookieNames: [], storage: [] }
      rows.set(domain, row)
    }
    return row
  }
  for (const cookie of data.cookies) {
    const row = rowFor(cookie.domain)
    row.cookieCount += 1
    if (!row.cookieNames.includes(cookie.name)) row.cookieNames.push(cookie.name)
  }
  for (const origin of data.origins) {
    let host = origin.origin
    try {
      host = new URL(origin.origin).hostname
    } catch {
      // An origin we cannot parse still deserves a row under its own text.
    }
    rowFor(host).storage.push({ origin: origin.origin, keys: origin.localStorage.length })
  }
  return [...rows.values()].sort((left, right) =>
    right.cookieCount - left.cookieCount || left.domain.localeCompare(right.domain))
}

/** File store for profiles. One \`.json\` per profile plus a dot-file that
 *  records which profile is enabled. */
export class BrowserProfileStore {
  constructor(private readonly dir: string) {}

  private file(name: string): string {
    return path.join(this.dir, profileFileName(name))
  }

  private activeFile(): string {
    return path.join(this.dir, ACTIVE_PROFILE_FILE)
  }

  /** All profiles in the store, sorted by name, with the enabled ones flagged. */
  list(): BrowserProfileSummary[] {
    const active = this.activeNames()
    let names: string[] = []
    try {
      names = fs.readdirSync(this.dir)
        .filter(file => file.endsWith('.json'))
        .map(file => file.slice(0, -'.json'.length))
    } catch {
      return []
    }
    return names.sort().map(name => this.summary(name, active))
  }

  private summary(name: string, activeNames: readonly string[]): BrowserProfileSummary {
    let profile: BrowserProfile | null = null
    try {
      profile = this.read(name)
    } catch {
      // A half-written file still shows up; counts read as zero.
    }
    return {
      name,
      avatar: profile?.avatar ?? null,
      createdAt: profile?.createdAt ?? 0,
      updatedAt: profile?.updatedAt ?? 0,
      cookieCount: profile?.cookies.length ?? 0,
      originCount: profile?.origins.length ?? 0,
      active: activeNames.includes(name),
      sourceUrl: profile?.sourceUrl ?? null,
    }
  }

  read(name: string): BrowserProfile {
    assertProfileName(name)
    let parsed: unknown
    try {
      parsed = JSON.parse(fs.readFileSync(this.file(name), 'utf8'))
    } catch (error) {
      throw new Error(`Profile ${name} is missing or unreadable: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (typeof parsed !== 'object' || parsed === null) throw new Error(`Profile ${name} is corrupt`)
    const record = parsed as Record<string, unknown>
    const data = parseProfileData(record)
    return {
      ...data,
      name,
      avatar: typeof record.avatar === 'string' && (BROWSER_PROFILE_AVATARS as readonly string[]).includes(record.avatar)
        ? record.avatar
        : null,
      createdAt: typeof record.createdAt === 'number' ? record.createdAt : 0,
      updatedAt: typeof record.updatedAt === 'number' ? record.updatedAt : 0,
      sourceUrl: typeof record.sourceUrl === 'string' ? record.sourceUrl : null,
    }
  }

  /** Write (or overwrite) a profile. Keeps the original createdAt so re-saving
   *  a profile updates its snapshot without pretending it is new. */
  write(name: string, data: BrowserProfileData, sourceUrl: string | null, now = Date.now()): BrowserProfile {
    assertProfileName(name)
    let existing: BrowserProfile | null = null
    try {
      existing = this.read(name)
    } catch {
      // New profile.
    }
    const profile: BrowserProfile = {
      ...data,
      name,
      avatar: existing?.avatar ?? null,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      sourceUrl: sourceUrl ?? existing?.sourceUrl ?? null,
    }
    fs.mkdirSync(this.dir, { recursive: true })
    const file = this.file(name)
    fs.writeFileSync(file, JSON.stringify(profile, null, 2), { encoding: 'utf8', mode: 0o600 })
    try { fs.chmodSync(file, 0o600) } catch { /* best-effort */ }
    return profile
  }

  /** Update only presentation metadata; the saved browser session is untouched. */
  setAvatar(name: string, avatar: string): BrowserProfileSummary {
    assertProfileName(name)
    assertProfileAvatar(avatar)
    const profile = this.read(name)
    const next: BrowserProfile = { ...profile, avatar }
    const file = this.file(name)
    fs.writeFileSync(file, JSON.stringify(next, null, 2), { encoding: 'utf8', mode: 0o600 })
    try { fs.chmodSync(file, 0o600) } catch { /* best-effort */ }
    return this.summary(name, this.activeNames())
  }

  remove(name: string): void {
    assertProfileName(name)
    try {
      fs.unlinkSync(this.file(name))
    } catch {
      throw new Error(`Profile ${name} does not exist`)
    }
  }

  /** Names of the enabled profiles, in the order they were enabled. */
  activeNames(): string[] {
    let text: string
    try {
      text = fs.readFileSync(this.activeFile(), 'utf8')
    } catch {
      return []
    }
    const names: string[] = []
    for (const line of text.split('\n')) {
      const name = line.trim()
      if (!name || names.includes(name)) continue
      try {
        assertProfileName(name)
      } catch {
        continue
      }
      names.push(name)
    }
    return names
  }

  /** First enabled profile, or null. Kept for the callers that only ever
   *  needed one name (the agent bridge's status lines). */
  active(): string | null {
    return this.activeNames()[0] ?? null
  }

  setActive(names: string | string[] | null): void {
    const list = names === null ? [] : (Array.isArray(names) ? names : [names])
    if (list.length === 0) {
      try { fs.unlinkSync(this.activeFile()) } catch { /* already absent */ }
      return
    }
    for (const name of list) assertProfileName(name)
    fs.mkdirSync(this.dir, { recursive: true })
    fs.writeFileSync(this.activeFile(), `${list.join('\n')}\n`, { encoding: 'utf8', mode: 0o600 })
  }
}
