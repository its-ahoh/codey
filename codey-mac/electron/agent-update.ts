/**
 * Updating an agent CLI from Settings.
 *
 * Every agent we support ships its own updater, and that updater is always the
 * right thing to run: it knows how that CLI was installed and where it may
 * write. The one exception is Homebrew. A formula's files live in a Cellar
 * directory Homebrew owns, so a self-update either fails or leaves brew's idea
 * of the version behind the truth; there we run `brew upgrade` instead.
 *
 * We never guess a package manager beyond that. An unknown install layout gets
 * the CLI's own updater and, if that CLI disagrees, its own error message —
 * which tells the user far more than a wrong `npm install -g` would.
 */

import type { InstallStatus, SpawnLike } from './agent-detect'
import { AGENT_BINARIES } from './agent-detect'

/** Each CLI's own "bring me up to date" command. */
const SELF_UPDATE: Record<string, string> = {
  'claude-code': 'claude update',
  'opencode': 'opencode upgrade',
  'codex': 'codex update',
  'pi': 'pi update',
}

export type UpdatePlan = {
  /** The shell command to run. */
  command: string
  /** Why that command — shown to the user before and after the run. */
  via: 'self' | 'homebrew'
}

/** True for a binary that resolves inside a Homebrew prefix. */
export function isHomebrewPath(path?: string): boolean {
  if (!path) return false
  return /(^|\/)(Cellar|homebrew)\//.test(path) || path.startsWith('/home/linuxbrew/')
}

/**
 * How to update one agent, or null when there is nothing to update — either we
 * do not know the agent, or its CLI is not installed in the first place.
 */
export function updatePlanFor(agent: string, status?: InstallStatus): UpdatePlan | null {
  const self = SELF_UPDATE[agent]
  const bin = AGENT_BINARIES[agent]
  if (!self || !bin || !status?.installed) return null
  if (isHomebrewPath(status.path)) return { command: `brew upgrade ${bin}`, via: 'homebrew' }
  return { command: self, via: 'self' }
}

export type UpdateOutcome = {
  command: string
  via: UpdatePlan['via']
  ok: boolean
  /** Tail of the combined output, for the user to read when something failed. */
  output: string
}

/** Keep the end, not the start: an updater's verdict is its last few lines. */
export function tailOutput(text: string, max = 2000): string {
  const trimmed = text.trim()
  return trimmed.length <= max ? trimmed : `…\n${trimmed.slice(-max)}`
}

/**
 * Run an update in the user's interactive login shell — the same shell the
 * install probe uses, so the updater sees the same PATH that put the CLI there.
 */
export async function runAgentUpdate(opts: {
  plan: UpdatePlan
  spawn: SpawnLike
  shell: string
  timeoutMs?: number
}): Promise<UpdateOutcome> {
  // Downloads, not lookups: minutes, not seconds.
  const timeoutMs = opts.timeoutMs ?? 300_000

  const result = await new Promise<{ ok: boolean; output: string }>(resolve => {
    const p = opts.spawn(opts.shell, ['-i', '-c', opts.plan.command], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let buf = ''
    let done = false
    const finish = (v: { ok: boolean; output: string }) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(v)
    }
    const timer = setTimeout(() => {
      try { p.kill() } catch { /* already gone */ }
      finish({ ok: false, output: `${buf}\nTimed out after ${Math.round(timeoutMs / 1000)}s.` })
    }, timeoutMs)
    p.stdout?.on('data', (d: Buffer) => { buf += d.toString() })
    p.stderr?.on('data', (d: Buffer) => { buf += d.toString() })
    p.on('close', (code: number) => finish({ ok: code === 0, output: buf }))
    p.on('error', (e: Error) => finish({ ok: false, output: `${buf}\n${e.message}` }))
  })

  return {
    command: opts.plan.command,
    via: opts.plan.via,
    ok: result.ok,
    output: tailOutput(result.output),
  }
}
