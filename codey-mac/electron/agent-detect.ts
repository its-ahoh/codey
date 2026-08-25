/**
 * Detecting which agent CLIs are on the user's PATH.
 *
 * We shell out via the user's *interactive* login shell so PATH includes
 * whatever they set up in .zshrc/.bash_profile (homebrew, nvm, asdf, …); a bare
 * spawn from Electron sees a much narrower PATH. That is also why this is
 * expensive: sourcing a real dotfile chain costs seconds, so the whole probe
 * runs as ONE shell that reports on every binary, not one shell per binary.
 *
 * The other half of the contract is that a failed probe is not an answer. A
 * timeout or a broken shell tells us nothing about what is installed, so it is
 * reported as `conclusive: false` with no statuses at all — never as a pile of
 * `installed: false`, which the UI would render as "you have no agents".
 */

export const AGENT_BINARIES: Record<string, string> = {
  'claude-code': 'claude',
  'opencode': 'opencode',
  'codex': 'codex',
  'pi': 'pi',
}

export type InstallStatus = {
  installed: boolean
  path?: string
  /** First line of `<bin> --version`, trimmed. Absent when the binary is
   *  missing, prints nothing, or the probe was cut short before reaching it. */
  version?: string
}

export type ProbeResult = {
  status: Record<string, InstallStatus>
  /** False when the probe itself failed. Callers must not cache or display it. */
  conclusive: boolean
}

/** Tags our lines so dotfile chatter (banners, nvm notices) can't be mistaken for output. */
const MARKER = 'codey-probe'
/** Tags the version lines. Deliberately not a suffix of MARKER, so the two
 *  kinds of line can never be read as each other. */
const VERSION_MARKER = 'codey-probe-version'

/**
 * One shell command emitting one `MARKER\tbin\tpath` line per binary, and then
 * one `VERSION_MARKER\tbin\tversion` line per binary.
 *
 * Order matters: every path line is printed before the first version is asked
 * for. Running a CLI is far slower and far more able to hang than resolving its
 * name, so if the probe runs out of time it still ends up having answered the
 * question it exists to answer — what is installed — and only loses the
 * versions. `--version` reads no input, but stdin is closed anyway so a CLI
 * that decides to prompt cannot hold the whole probe open.
 */
export function buildProbeScript(bins: string[]): string {
  const paths = bins
    .map(b => `printf '${MARKER}\\t${b}\\t%s\\n' "$(command -v ${b} 2>/dev/null | head -n1)"`)
  const versions = bins
    .map(b => `printf '${VERSION_MARKER}\\t${b}\\t%s\\n' "$(${b} --version 2>/dev/null </dev/null | head -n1)"`)
  return [...paths, ...versions].join('; ')
}

/**
 * Parse probe stdout, or null if any binary is missing a line — which means the
 * script did not run to completion and the run tells us nothing.
 */
export function parseProbeOutput(bins: string[], out: string): Record<string, InstallStatus> | null {
  const seen = new Map<string, string>()
  const versions = new Map<string, string>()
  for (const line of out.split('\n')) {
    const parts = line.split('\t')
    if (parts.length < 3) continue
    const value = parts.slice(2).join('\t').trim()
    // endsWith, not ===: an rc file that prints without a trailing newline
    // leaves its text glued to the front of our first line.
    if (parts[0].endsWith(VERSION_MARKER)) { versions.set(parts[1], value); continue }
    if (parts[0].endsWith(MARKER)) seen.set(parts[1], value)
  }
  if (bins.some(b => !seen.has(b))) return null
  const status: Record<string, InstallStatus> = {}
  for (const b of bins) {
    const path = seen.get(b) as string
    if (!path) { status[b] = { installed: false }; continue }
    const version = versions.get(b)?.slice(0, 80).trim()
    status[b] = version ? { installed: true, path, version } : { installed: true, path }
  }
  return status
}

export type SpawnLike = (cmd: string, args: string[], opts: any) => any

export async function detectInstalledAgents(opts: {
  spawn: SpawnLike
  shell: string
  timeoutMs?: number
  binaries?: Record<string, string>
}): Promise<ProbeResult> {
  const binaries = opts.binaries ?? AGENT_BINARIES
  const bins = Object.values(binaries)
  // Generous: this is one shell, it runs about once per app launch, and the old
  // budget was tight enough that launch-time load alone could blow through it.
  const timeoutMs = opts.timeoutMs ?? 30_000

  // On timeout we keep what the shell had already printed rather than throwing
  // it away: the path lines come first, so a probe killed while asking a slow
  // CLI for its version still answers what is installed.
  const out = await new Promise<string | null>(resolve => {
    // -i so login dotfiles populate PATH the way they do in Terminal.
    const p = opts.spawn(opts.shell, ['-i', '-c', buildProbeScript(bins)], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let buf = ''
    let done = false
    const finish = (v: string | null) => { if (!done) { done = true; clearTimeout(timer); resolve(v) } }
    const timer = setTimeout(() => { try { p.kill() } catch { /* already gone */ } finish(buf) }, timeoutMs)
    p.stdout?.on('data', (d: Buffer) => { buf += d.toString() })
    p.on('close', () => finish(buf))
    p.on('error', () => finish(null))
  })

  if (out === null) return { status: {}, conclusive: false }
  const byBin = parseProbeOutput(bins, out)
  if (!byBin) return { status: {}, conclusive: false }

  const status: Record<string, InstallStatus> = {}
  for (const [agent, bin] of Object.entries(binaries)) status[agent] = byBin[bin]
  return { status, conclusive: true }
}

/**
 * Lifetime cache over a probe. Conclusive answers stick; inconclusive ones are
 * dropped so the next caller gets a real attempt instead of a cached failure.
 */
export function createInstalledAgentsCache(detect: () => Promise<ProbeResult>) {
  let cached: Record<string, InstallStatus> | null = null
  let inFlight: Promise<ProbeResult> | null = null

  return function getInstalledAgents(force = false): Promise<ProbeResult> {
    if (force) cached = null
    if (cached) return Promise.resolve({ status: cached, conclusive: true })
    if (!inFlight) {
      inFlight = detect()
        .then(r => { if (r.conclusive) cached = r.status; return r })
        .finally(() => { inFlight = null })
    }
    return inFlight
  }
}
