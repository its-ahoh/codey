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
  /** This profile mirrors Chrome, including newly visited sites, except for
   *  its explicit exclusions. Off unless the user turned it on. */
  autoSync?: boolean
  createdAt: number
  updatedAt: number
  /** The page that was showing when the profile was saved; null for imports. */
  sourceUrl: string | null
}

/** A profile record on disk: everything about a profile except its session,
 *  which lives in the profile's partition. */
export interface BrowserProfileMeta {
  name: string
  avatar?: string | null
  autoSync?: boolean
  /** Chrome sites this profile must never refresh from automatically. */
  excludedSites: string[]
  createdAt: number
  updatedAt: number
  sourceUrl: string | null
}

export interface BrowserProfileSummary {
  name: string
  avatar?: string | null
  autoSync: boolean
  excludedSites: string[]
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

/** Bumped when a profile file's shape changes. Schema 1 carried the session
 *  itself; schema 2 carries metadata only, because the partition holds the
 *  session now. A file with no marker is schema 1 and needs migrating. */
export const PROFILE_SCHEMA = 2

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

/** The default storage jar, used by tabs that belong to no profile. This is
 *  the partition the browser used before profiles were isolated, so an
 *  existing install keeps whatever it was signed into. */
export const DEFAULT_BROWSER_PARTITION = 'persist:codey-browser'

/** The Electron partition that holds a profile's session. Each profile gets
 *  its own Chromium storage bucket - cookies, localStorage, IndexedDB, cache -
 *  so two profiles signed into the same site cannot see or overwrite each
 *  other. `null` means "no profile", which is the default jar. */
export function profilePartition(name: string | null): string {
  if (name === null) return DEFAULT_BROWSER_PARTITION
  assertProfileName(name)
  return `persist:codey-profile-${name}`
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

/** Does `site` (a registrable domain, as Chrome grouped it) cover `host`?
 *  Used to decide which of a profile's cookies a refresh of that site speaks
 *  for, without needing the public-suffix guesswork on this side: the sites
 *  come back from the extension already folded. */
export function siteCoversHost(site: string, host: string): boolean {
  const left = site.replace(/^\./, '').toLowerCase()
  const right = host.replace(/^\./, '').toLowerCase()
  return !!left && (right === left || right.endsWith(`.${left}`))
}

/** Normalize the user-maintained Chrome-sync exclusion list. Older metadata
 *  has no field, and hand-edited files may contain mixed values, so reads are
 *  deliberately forgiving while still returning one canonical shape. */
function normalizeExcludedSites(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const sites: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string') continue
    const site = entry.trim().replace(/^\.+/, '').trim().toLowerCase()
    if (!site || sites.includes(site)) continue
    sites.push(site)
  }
  return sites
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

  /** The counts stay on the summary because the UI shows them, but only the
   *  partition can fill them in now - the controller does that. */
  private summary(name: string, activeNames: readonly string[]): BrowserProfileSummary {
    let meta: BrowserProfileMeta | null = null
    try {
      meta = this.read(name)
    } catch {
      // A half-written file still shows up.
    }
    return {
      name,
      avatar: meta?.avatar ?? null,
      autoSync: meta?.autoSync === true,
      excludedSites: meta?.excludedSites ?? [],
      createdAt: meta?.createdAt ?? 0,
      updatedAt: meta?.updatedAt ?? 0,
      cookieCount: 0,
      originCount: 0,
      active: activeNames.includes(name),
      sourceUrl: meta?.sourceUrl ?? null,
    }
  }

  read(name: string): BrowserProfileMeta {
    assertProfileName(name)
    let parsed: unknown
    try {
      parsed = JSON.parse(fs.readFileSync(this.file(name), 'utf8'))
    } catch (error) {
      throw new Error(`Profile ${name} is missing or unreadable: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (typeof parsed !== 'object' || parsed === null) throw new Error(`Profile ${name} is corrupt`)
    const record = parsed as Record<string, unknown>
    return {
      name,
      avatar: typeof record.avatar === 'string' && (BROWSER_PROFILE_AVATARS as readonly string[]).includes(record.avatar)
        ? record.avatar
        : null,
      autoSync: record.autoSync === true,
      excludedSites: normalizeExcludedSites(record.excludedSites),
      createdAt: typeof record.createdAt === 'number' ? record.createdAt : 0,
      updatedAt: typeof record.updatedAt === 'number' ? record.updatedAt : 0,
      sourceUrl: typeof record.sourceUrl === 'string' ? record.sourceUrl : null,
    }
  }

  /** Write (or update) a profile's metadata record. Keeps createdAt, the
   *  avatar and the Chrome-sync switch when the profile already exists. */
  writeMeta(name: string, sourceUrl: string | null, now = Date.now()): BrowserProfileMeta {
    assertProfileName(name)
    let existing: BrowserProfileMeta | null = null
    try {
      existing = this.read(name)
    } catch {
      // New profile.
    }
    const meta: BrowserProfileMeta & { schema: number } = {
      schema: PROFILE_SCHEMA,
      name,
      avatar: existing?.avatar ?? null,
      autoSync: existing?.autoSync === true,
      excludedSites: existing?.excludedSites ?? [],
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      sourceUrl: sourceUrl ?? existing?.sourceUrl ?? null,
    }
    this.writeRecord(name, meta)
    return meta
  }

  /** Move a profile's updatedAt without changing anything else - what a
   *  refresh of its jar reports back to the UI. */
  touch(name: string, now = Date.now()): BrowserProfileMeta {
    const meta = this.read(name)
    const next = { ...meta, schema: PROFILE_SCHEMA, updatedAt: now }
    this.writeRecord(name, next)
    return next
  }

  /** Profiles still holding a schema-1 session, with the session to replay
   *  into their partition. Empty once every profile has been migrated. */
  pendingMigrations(): Array<{ name: string; data: BrowserProfileData }> {
    const pending: Array<{ name: string; data: BrowserProfileData }> = []
    let names: string[] = []
    try {
      names = fs.readdirSync(this.dir)
        .filter(file => file.endsWith('.json'))
        .map(file => file.slice(0, -'.json'.length))
    } catch {
      return []
    }
    for (const name of names.sort()) {
      let record: Record<string, unknown>
      try {
        const parsed: unknown = JSON.parse(fs.readFileSync(this.file(name), 'utf8'))
        if (typeof parsed !== 'object' || parsed === null) continue
        record = parsed as Record<string, unknown>
      } catch {
        continue
      }
      if (record.schema === PROFILE_SCHEMA) continue
      try {
        pending.push({ name, data: parseProfileData(record) })
      } catch {
        // A malformed payload cannot be replayed; leave the file alone.
      }
    }
    return pending
  }

  /** Rewrite a migrated profile as a metadata-only record, dropping the
   *  session it used to carry. Called only after the session has been written
   *  into the partition, so a crash in between simply migrates again. */
  markMigrated(name: string): void {
    assertProfileName(name)
    const meta = this.read(name)
    this.writeRecord(name, { ...meta, schema: PROFILE_SCHEMA })
  }

  private writeRecord(name: string, record: object): void {
    fs.mkdirSync(this.dir, { recursive: true })
    const file = this.file(name)
    fs.writeFileSync(file, JSON.stringify(record, null, 2), { encoding: 'utf8', mode: 0o600 })
    try { fs.chmodSync(file, 0o600) } catch { /* best-effort */ }
  }

  /** Update only presentation metadata; the saved browser session is untouched. */
  setAvatar(name: string, avatar: string): BrowserProfileSummary {
    assertProfileName(name)
    assertProfileAvatar(avatar)
    const meta = this.read(name)
    this.writeRecord(name, { ...meta, schema: PROFILE_SCHEMA, avatar })
    return this.summary(name, this.activeNames())
  }

  /** Turn a profile's "mirror Chrome" flag on or off. Metadata only - the
   *  saved session is untouched, and the snapshot does not read as newer. */
  setAutoSync(name: string, enabled: boolean): BrowserProfileSummary {
    assertProfileName(name)
    const meta = this.read(name)
    this.writeRecord(name, { ...meta, schema: PROFILE_SCHEMA, autoSync: enabled === true })
    return this.summary(name, this.activeNames())
  }

  /** Replace the sites omitted from this profile's automatic Chrome refresh.
   *  Like the auto-sync switch, this changes metadata only. */
  setExcludedSites(name: string, sites: readonly string[]): BrowserProfileSummary {
    assertProfileName(name)
    const meta = this.read(name)
    this.writeRecord(name, {
      ...meta,
      schema: PROFILE_SCHEMA,
      excludedSites: normalizeExcludedSites(sites),
    })
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

  setActive(name: string | null): void {
    if (name === null) {
      try { fs.unlinkSync(this.activeFile()) } catch { /* already absent */ }
      return
    }
    assertProfileName(name)
    fs.mkdirSync(this.dir, { recursive: true })
    fs.writeFileSync(this.activeFile(), `${name}\n`, { encoding: 'utf8', mode: 0o600 })
  }
}
