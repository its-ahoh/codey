import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'events'
import { AGENT_BINARIES, createInstalledAgentsCache, detectInstalledAgents, parseProbeOutput } from './agent-detect'

const BINS = Object.values(AGENT_BINARIES)

/** Minimal stand-in for child_process.spawn's return value. */
function fakeChild() {
  const p: any = new EventEmitter()
  p.stdout = new EventEmitter()
  p.stderr = new EventEmitter()
  p.kill = vi.fn()
  return p
}

/** A spawn that emits `out`, then closes with `code`. */
function spawnEmitting(out: string, code = 0) {
  const calls: Array<{ shell: string; args: string[] }> = []
  const spawn = ((shell: string, args: string[]) => {
    calls.push({ shell, args })
    const p = fakeChild()
    queueMicrotask(() => { p.stdout.emit('data', Buffer.from(out)); p.emit('close', code) })
    return p
  }) as any
  return { spawn, calls }
}

/** The exact stdout the real probe script produces for a given resolution map. */
function probeStdout(resolved: Record<string, string>) {
  return BINS.map(b => `codey-probe\t${b}\t${resolved[b] ?? ''}`).join('\n') + '\n'
}

describe('detectInstalledAgents', () => {
  it('probes every binary in a single shell', async () => {
    const { spawn, calls } = spawnEmitting(probeStdout({ claude: '/usr/local/bin/claude' }))
    await detectInstalledAgents({ spawn, shell: '/bin/zsh' })
    expect(calls).toHaveLength(1)
    for (const bin of BINS) expect(calls[0].args.join(' ')).toContain(bin)
  })

  it('reports each binary that resolved, and is conclusive', async () => {
    const { spawn } = spawnEmitting(probeStdout({
      claude: '/Users/j/.local/bin/claude',
      opencode: '/opt/homebrew/bin/opencode',
    }))
    const r = await detectInstalledAgents({ spawn, shell: '/bin/zsh' })
    expect(r.conclusive).toBe(true)
    expect(r.status['claude-code']).toEqual({ installed: true, path: '/Users/j/.local/bin/claude' })
    expect(r.status['opencode']).toEqual({ installed: true, path: '/opt/homebrew/bin/opencode' })
    expect(r.status['codex']).toEqual({ installed: false })
  })

  it('ignores chatter printed by interactive rc files, even unterminated', async () => {
    const { spawn } = spawnEmitting(
      'nvm: loading\nWelcome back!' + probeStdout({ claude: '/usr/local/bin/claude' }),
    )
    const r = await detectInstalledAgents({ spawn, shell: '/bin/zsh' })
    expect(r.conclusive).toBe(true)
    expect(r.status['claude-code']).toEqual({ installed: true, path: '/usr/local/bin/claude' })
  })

  it('is INCONCLUSIVE when the probe times out, and reports no negatives', async () => {
    const spawn = ((_s: string, _a: string[]) => fakeChild()) as any  // never closes
    const r = await detectInstalledAgents({ spawn, shell: '/bin/zsh', timeoutMs: 5 })
    expect(r.conclusive).toBe(false)
    expect(r.status).toEqual({})
  })

  it('is INCONCLUSIVE when the shell dies before emitting the full script output', async () => {
    const { spawn } = spawnEmitting('codey-probe\tclaude\t/usr/local/bin/claude\n', 0)
    const r = await detectInstalledAgents({ spawn, shell: '/bin/zsh' })
    expect(r.conclusive).toBe(false)
  })

  it('is INCONCLUSIVE when the shell cannot be spawned', async () => {
    const spawn = ((_s: string, _a: string[]) => {
      const p = fakeChild()
      queueMicrotask(() => p.emit('error', new Error('ENOENT')))
      return p
    }) as any
    const r = await detectInstalledAgents({ spawn, shell: '/bin/zsh' })
    expect(r.conclusive).toBe(false)
  })
})

describe('parseProbeOutput', () => {
  it('takes only the first line of a multi-line `command -v` result', () => {
    const status = parseProbeOutput(['claude'], 'codey-probe\tclaude\t/usr/local/bin/claude\n')
    expect(status).toEqual({ claude: { installed: true, path: '/usr/local/bin/claude' } })
  })

  it('returns null when a probed binary produced no line at all', () => {
    expect(parseProbeOutput(['claude', 'codex'], 'codey-probe\tclaude\t/x\n')).toBeNull()
  })
})

describe('createInstalledAgentsCache', () => {
  it('caches a conclusive answer for the app lifetime', async () => {
    const detect = vi.fn(async () => ({ status: { codex: { installed: true } }, conclusive: true }))
    const get = createInstalledAgentsCache(detect)
    await get(); await get()
    expect(detect).toHaveBeenCalledTimes(1)
  })

  it('NEVER caches an inconclusive answer — the next caller re-probes', async () => {
    const detect = vi.fn(async () => ({ status: {}, conclusive: false }))
    const get = createInstalledAgentsCache(detect)
    await get(); await get()
    expect(detect).toHaveBeenCalledTimes(2)
  })

  it('re-probes on force even when a conclusive answer is cached', async () => {
    const detect = vi.fn(async () => ({ status: { codex: { installed: true } }, conclusive: true }))
    const get = createInstalledAgentsCache(detect)
    await get()
    await get(true)
    expect(detect).toHaveBeenCalledTimes(2)
  })

  it('coalesces concurrent callers onto one probe', async () => {
    const detect = vi.fn(async () => ({ status: { codex: { installed: true } }, conclusive: true }))
    const get = createInstalledAgentsCache(detect)
    await Promise.all([get(), get(), get()])
    expect(detect).toHaveBeenCalledTimes(1)
  })
})
