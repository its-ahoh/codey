import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'events'
import { isHomebrewPath, runAgentUpdate, tailOutput, updatePlanFor } from './agent-update'

function fakeChild() {
  const p: any = new EventEmitter()
  p.stdout = new EventEmitter()
  p.stderr = new EventEmitter()
  p.kill = vi.fn()
  return p
}

describe('updatePlanFor', () => {
  it('runs each CLI\'s own updater when it manages its own files', () => {
    expect(updatePlanFor('claude-code', { installed: true, path: '/Users/j/.local/bin/claude' }))
      .toEqual({ command: 'claude update', via: 'self' })
    expect(updatePlanFor('codex', { installed: true, path: '/Users/j/.local/bin/codex' }))
      .toEqual({ command: 'codex update', via: 'self' })
    expect(updatePlanFor('pi', { installed: true, path: '/Users/j/.nvm/versions/node/v24/bin/pi' }))
      .toEqual({ command: 'pi update', via: 'self' })
  })

  it('hands a Homebrew install to brew, which owns those files', () => {
    expect(updatePlanFor('opencode', { installed: true, path: '/opt/homebrew/bin/opencode' }))
      .toEqual({ command: 'brew upgrade opencode', via: 'homebrew' })
    expect(updatePlanFor('opencode', { installed: true, path: '/usr/local/Cellar/opencode/1.14.18/bin/opencode' }))
      .toEqual({ command: 'brew upgrade opencode', via: 'homebrew' })
  })

  it('has nothing to offer for an agent that is not installed, or not known', () => {
    expect(updatePlanFor('claude-code', { installed: false })).toBeNull()
    expect(updatePlanFor('claude-code', undefined)).toBeNull()
    expect(updatePlanFor('some-other-agent', { installed: true, path: '/bin/x' })).toBeNull()
  })
})

describe('isHomebrewPath', () => {
  it('recognizes both prefixes and neither a lookalike nor nothing', () => {
    expect(isHomebrewPath('/opt/homebrew/bin/opencode')).toBe(true)
    expect(isHomebrewPath('/home/linuxbrew/.linuxbrew/bin/opencode')).toBe(true)
    expect(isHomebrewPath('/Users/j/homebrewery/bin/opencode')).toBe(false)
    expect(isHomebrewPath(undefined)).toBe(false)
  })
})

describe('runAgentUpdate', () => {
  const plan = { command: 'claude update', via: 'self' } as const

  it('runs the command in the login shell and reports success', async () => {
    const calls: Array<{ shell: string; args: string[] }> = []
    const spawn = ((shell: string, args: string[]) => {
      calls.push({ shell, args })
      const p = fakeChild()
      queueMicrotask(() => { p.stdout.emit('data', Buffer.from('Updated to 2.1.9\n')); p.emit('close', 0) })
      return p
    }) as any
    const r = await runAgentUpdate({ plan, spawn, shell: '/bin/zsh' })
    expect(calls[0]).toEqual({ shell: '/bin/zsh', args: ['-i', '-c', 'claude update'] })
    expect(r).toEqual({ command: 'claude update', via: 'self', ok: true, output: 'Updated to 2.1.9' })
  })

  it('keeps stderr, where a failing updater says what went wrong', async () => {
    const spawn = ((_s: string, _a: string[]) => {
      const p = fakeChild()
      queueMicrotask(() => { p.stderr.emit('data', Buffer.from('permission denied')); p.emit('close', 1) })
      return p
    }) as any
    const r = await runAgentUpdate({ plan, spawn, shell: '/bin/zsh' })
    expect(r.ok).toBe(false)
    expect(r.output).toContain('permission denied')
  })

  it('kills an update that never finishes and says so', async () => {
    const p = fakeChild()
    const spawn = (() => p) as any
    const r = await runAgentUpdate({ plan, spawn, shell: '/bin/zsh', timeoutMs: 5 })
    expect(r.ok).toBe(false)
    expect(r.output).toContain('Timed out')
    expect(p.kill).toHaveBeenCalled()
  })

  it('fails with the spawn error when the shell cannot start', async () => {
    const spawn = (() => {
      const p = fakeChild()
      queueMicrotask(() => p.emit('error', new Error('ENOENT')))
      return p
    }) as any
    const r = await runAgentUpdate({ plan, spawn, shell: '/bin/zsh' })
    expect(r.ok).toBe(false)
    expect(r.output).toContain('ENOENT')
  })
})

describe('tailOutput', () => {
  it('keeps the end of a long log, marked as cut', () => {
    const out = tailOutput('x'.repeat(50) + 'THE VERDICT', 20)
    expect(out.startsWith('…\n')).toBe(true)
    expect(out).toContain('THE VERDICT')
  })

  it('leaves a short log alone', () => {
    expect(tailOutput('  done  ', 20)).toBe('done')
  })
})
