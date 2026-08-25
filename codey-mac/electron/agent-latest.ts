/**
 * Is there a newer version of an agent CLI than the one installed?
 *
 * Every agent we support publishes to npm, and publishes there first: the
 * native installer, the standalone build and the Homebrew formula all track
 * the same release. So one registry lookup per agent answers the question
 * without running anything, which matters — a CLI that can tell you whether it
 * is current usually does so by starting up, and four cold starts is not a
 * thing to do behind a settings panel.
 *
 * A lookup that fails answers nothing. It is reported as `unknown`, never as
 * "you are up to date", because the second is a claim we have not earned and
 * would quietly hide the update button from someone who needs it.
 */

/** Where each agent publishes. The registry is the source of truth for
 *  "latest", including for the Homebrew formula, which can lag it by a day. */
export const AGENT_PACKAGES: Record<string, string> = {
  'claude-code': '@anthropic-ai/claude-code',
  'opencode': 'opencode-ai',
  'codex': '@openai/codex',
  'pi': '@earendil-works/pi-coding-agent',
}

/**
 * The version inside whatever a CLI prints for `--version`: `2.1.238 (Claude
 * Code)`, `codex-cli 0.148.0`, `v1.14.18`, `0.84.2`. Null when there is no
 * version-shaped token in there at all.
 */
export function parseVersion(raw?: string): string | null {
  if (!raw) return null
  // No leading \b: a `v` prefix is a word character, so `v0.84.2` would not
  // match one. Only a digit or dot before the number disqualifies it.
  const m = raw.match(/(?<![\d.])(\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z.-]+)?)/)
  return m ? m[1] : null
}

/** Negative if a < b, 0 if equal, positive if a > b. */
export function compareVersions(a: string, b: string): number {
  const split = (v: string) => {
    const [core, pre] = v.split('-', 2)
    return { nums: core.split('.').map(n => parseInt(n, 10) || 0), pre }
  }
  const x = split(a)
  const y = split(b)
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0)
    if (d !== 0) return d
  }
  // 1.2.3-beta is the release before 1.2.3, not after it.
  if (x.pre && !y.pre) return -1
  if (!x.pre && y.pre) return 1
  if (x.pre && y.pre) return x.pre < y.pre ? -1 : x.pre > y.pre ? 1 : 0
  return 0
}

export type UpdateAvailability = {
  /** What the installed CLI reports, normalized. */
  current?: string
  /** Latest published, normalized. Absent when the lookup failed. */
  latest?: string
  /** True only when both versions are known and latest is genuinely newer. */
  updateAvailable: boolean
  /** True when we could not find out — offline, registry down, odd version
   *  string. The UI keeps the update button reachable in this state. */
  unknown: boolean
}

export function availability(currentRaw?: string, latestRaw?: string | null): UpdateAvailability {
  const current = parseVersion(currentRaw) ?? undefined
  const latest = parseVersion(latestRaw ?? undefined) ?? undefined
  if (!current || !latest) return { current, latest, updateAvailable: false, unknown: true }
  return { current, latest, updateAvailable: compareVersions(latest, current) > 0, unknown: false }
}

export type FetchLike = (url: string, init?: any) => Promise<{ ok: boolean; json: () => Promise<any> }>

/** The `latest` dist-tag of one package, or null if the registry did not say. */
export async function fetchLatestVersion(
  pkg: string,
  fetchImpl: FetchLike,
  timeoutMs = 8000,
): Promise<string | null> {
  const controller = typeof AbortController === 'function' ? new AbortController() : null
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null
  try {
    const res = await fetchImpl(`https://registry.npmjs.org/${pkg}/latest`, {
      headers: { accept: 'application/json' },
      signal: controller?.signal,
    })
    if (!res.ok) return null
    const body = await res.json()
    return typeof body?.version === 'string' ? body.version : null
  } catch {
    return null
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** Every agent's latest published version, looked up in parallel. */
export async function fetchAllLatestVersions(
  fetchImpl: FetchLike,
  packages: Record<string, string> = AGENT_PACKAGES,
): Promise<Record<string, string | null>> {
  const entries = await Promise.all(
    Object.entries(packages).map(async ([agent, pkg]) =>
      [agent, await fetchLatestVersion(pkg, fetchImpl)] as const,
    ),
  )
  return Object.fromEntries(entries)
}

/**
 * Time-boxed cache over the lookups. Releases are a daily event at most, and
 * the panel can be opened many times an hour; `force` is what the Recheck
 * button uses.
 */
export function createLatestVersionsCache(
  fetchAll: () => Promise<Record<string, string | null>>,
  opts: { ttlMs?: number; now?: () => number } = {},
) {
  const ttlMs = opts.ttlMs ?? 6 * 60 * 60 * 1000
  const now = opts.now ?? Date.now
  let cached: Record<string, string | null> | null = null
  let cachedAt = 0
  let inFlight: Promise<Record<string, string | null>> | null = null

  return function getLatestVersions(force = false): Promise<Record<string, string | null>> {
    if (force) cached = null
    if (cached && now() - cachedAt < ttlMs) return Promise.resolve(cached)
    if (!inFlight) {
      inFlight = fetchAll()
        .then(r => {
          // A round where nothing resolved is a network outage, not an answer;
          // caching it would keep the panel wrong for hours.
          if (Object.values(r).some(v => v !== null)) { cached = r; cachedAt = now() }
          return r
        })
        .finally(() => { inFlight = null })
    }
    return inFlight
  }
}
