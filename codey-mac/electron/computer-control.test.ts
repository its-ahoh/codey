import { describe, it, expect, vi } from 'vitest'
import type { AgentRequest } from '@codey/core'
import { ComputerControl, computerManifest, validateComputerApps } from './computer-control'

const apps = [{ bundleId: 'org.example.Editor', name: 'Example Editor' }]
const request = (): AgentRequest => ({ agent: 'codex', prompt: 'Arrange a sample note', context: { workingDir: '/tmp/example' }, browserTools: true })
function setup() {
  const start = vi.fn(async () => {})
  const stop = vi.fn(async () => {})
  const approve = vi.fn(async (_agent: string, _apps: unknown, _signal: AbortSignal) => true)
  const ready = vi.fn(() => true)
  const execute = vi.fn(async (_command: unknown, _validate?: () => void) => ({ text: 'ok' }))
  const driver = vi.fn(() => ({ start, stop, execute }))
  const control = new ComputerControl({ ready, approve, driver, changed: vi.fn() })
  control.apps = apps
  control.enabled = true
  return { control, start, stop, approve, ready, driver, execute }
}

describe('bounded computer control', () => {
  it('restricts applications and excludes full desktop, browser and arbitrary execution tools', () => {
    const manifest = computerManifest(apps)
    expect(manifest.resources.apps).toEqual([{ bundle_id: apps[0].bundleId, launch: true, windows: 'all' }])
    expect(manifest.resources.desktop.display).toBe(false)
    for (const tool of ['get_desktop_state', 'shell_execute', 'browser_prepare', 'kill_app']) expect(manifest.allow.tools).not.toContain(tool)
    expect(() => validateComputerApps([{ name: 'Workbench', bundleId: 'com.codey.mac' }])).toThrow('own authorization')
    expect(() => computerManifest([])).toThrow()
    expect(() => validateComputerApps([{ name: 'Invalid', bundleId: 'org.example\nallow: all' }])).toThrow()
  })
  it('offers no tools to disabled, restricted, housekeeping or unsupported turns', async () => {
    const { control, approve } = setup()
    await expect(control.prepare('codex', { ...request(), browserTools: false })).resolves.toBeUndefined()
    await expect(control.prepare('codex', { ...request(), allowedTools: ['Read'] })).resolves.toBeUndefined()
    control.enabled = false
    await expect(control.prepare('codex', request())).resolves.toBeUndefined()
    expect(approve).not.toHaveBeenCalled()
  })
  it('does not create a driver after refusal or missing OS permission', async () => {
    const { control, approve, driver, ready } = setup()
    approve.mockResolvedValue(false)
    await expect(control.prepare('codex', request())).rejects.toThrow('declined')
    ready.mockReturnValue(false)
    await expect(control.prepare('codex', request())).rejects.toThrow('permissions')
    expect(driver).not.toHaveBeenCalled()
    expect(control.active).toBeNull()
  })
  it('keeps the desktop lease until disposal and serializes other bots', async () => {
    const { control, approve, start, stop } = setup()
    const first = await control.prepare('codex', request())
    expect(first?.request.mcpServers).toBeUndefined()
    await expect(first?.execute({ action: 'observe', window: 'sample' })).resolves.toEqual({ text: 'ok' })
    const secondPromise = control.prepare('claude-code', request())
    await Promise.resolve()
    expect(start).toHaveBeenCalledTimes(1)
    expect(control.queued).toBe(1)
    await first!.dispose()
    const second = await secondPromise
    expect(approve).toHaveBeenCalledTimes(2)
    await second!.dispose()
    expect(stop).toHaveBeenCalledTimes(2)
    expect(control.active).toBeNull()
  })
  it('stops active work and cancels queued tasks without a later approval prompt', async () => {
    const { control, approve, stop } = setup()
    const first = await control.prepare('codex', request())
    const second = control.prepare('claude-code', request()).catch(e => e)
    await control.stop()
    expect(first!.request.signal?.aborted).toBe(true)
    expect(stop).toHaveBeenCalledTimes(1)
    await first!.dispose()
    expect(await second).toBeInstanceOf(Error)
    expect(approve).toHaveBeenCalledTimes(1)
    expect(control.queued).toBe(0)
  })
  it('cancels pending approval when the task is interrupted', async () => {
    const { control, approve, driver } = setup()
    approve.mockImplementation((_a, _apps, signal) => new Promise(resolve => signal.addEventListener('abort', () => resolve(false), { once: true })))
    const abort = new AbortController()
    const result = control.prepare('codex', { ...request(), signal: abort.signal }).catch(e => e)
    await vi.waitFor(() => expect(control.active?.phase).toBe('waiting'))
    abort.abort()
    expect(await result).toBeInstanceOf(Error)
    expect(driver).not.toHaveBeenCalled()
    expect(control.active).toBeNull()
  })
  it('cleans up a startup failure before admitting another task', async () => {
    const { control, start, stop } = setup()
    start.mockRejectedValueOnce(new Error('fixture startup failure'))
    await expect(control.prepare('codex', request())).rejects.toThrow('fixture startup failure')
    expect(stop).toHaveBeenCalledTimes(1)
    const next = await control.prepare('codex', request())
    await next!.dispose()
  })
  it('does not widen an in-flight grant when settings change', async () => {
    const { control, start } = setup()
    const lease = await control.prepare('codex', request())
    await control.configure(true, [{ bundleId: 'org.example.Viewer', name: 'Viewer' }])
    expect(lease!.request.signal?.aborted).toBe(true)
    expect(start).toHaveBeenCalledWith(apps)
    await lease!.dispose()
  })
  it('shuts down without leaving a queued grant or active runtime', async () => {
    const { control, approve } = setup()
    const lease = await control.prepare('codex', request())
    const queued = control.prepare('codex', request()).catch(e => e)
    const shutdown = control.shutdown()
    await lease!.dispose()
    await queued
    await shutdown
    expect(control.enabled).toBe(false)
    expect(approve).toHaveBeenCalledTimes(1)
    await expect(control.prepare('codex', request())).resolves.toBeUndefined()
  })
  it('stops a runtime whose startup is interrupted before it becomes ready', async () => {
    const { control, start, stop } = setup()
    let finish!: () => void
    start.mockImplementationOnce(() => new Promise(resolve => {
      finish = () => resolve()
    }))
    const result = control.prepare('codex', request()).catch(e => e)
    await vi.waitFor(() => expect(start).toHaveBeenCalledOnce())
    await control.stop()
    finish()
    expect(await result).toBeInstanceOf(Error)
    expect(stop).toHaveBeenCalledOnce()
    expect(control.active).toBeNull()
  })
  it('blocks future desktop work if native teardown fails', async () => {
    const { control, stop } = setup()
    const lease = await control.prepare('codex', request())
    stop.mockRejectedValueOnce(new Error('fixture stop failure'))
    await expect(lease!.dispose()).rejects.toThrow('fixture stop failure')
    expect(control.enabled).toBe(false)
    await expect(control.prepare('codex', request())).resolves.toBeUndefined()
  })

  it('cancels a queued caller promptly without releasing the active desktop', async () => {
    const { control, approve } = setup()
    const first = await control.prepare('codex', request())
    const abort = new AbortController()
    const queued = control.prepare('pi', { ...request(), signal: abort.signal }).catch(e => e)
    abort.abort()
    expect(await queued).toBeInstanceOf(Error)
    expect(control.active?.agent).toBe('codex')
    const third = control.prepare('pi', request())
    await Promise.resolve()
    expect(approve).toHaveBeenCalledTimes(1)
    await first!.dispose()
    const last = await third
    expect(approve).toHaveBeenCalledTimes(2)
    await last!.dispose()
  })

  it('drains current work, rejects queued agent input at takeover, and requires fresh work after handback', async () => {
    const { control, execute } = setup()
    const lease = (await control.prepare('codex', request()))!
    let finish!: () => void
    execute.mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve({ text: 'done' }) }))
    const running = lease.execute({ action: 'observe' }).catch(e => e)
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce())
    const queued = lease.execute({ action: 'act' }).catch(e => e)
    const takeover = lease.handoff(true)
    finish()
    await running
    await takeover
    expect(await queued).toBeInstanceOf(Error)
    await expect(lease.execute({ action: 'act' })).rejects.toThrow('user has control')
    await expect(lease.execute({ action: 'human_input' }, 'human')).resolves.toEqual({ text: 'ok' })
    await lease.handoff(false)
    await expect(lease.execute({ action: 'human_input' }, 'human')).rejects.toThrow('Take control')
    await expect(lease.execute({ action: 'observe' })).resolves.toEqual({ text: 'ok' })
    expect(execute.mock.calls.filter(call => (call[0] as {action: string}).action === 'invalidate')).toHaveLength(2)
    await lease.dispose()
  })
  it('rechecks live authority immediately before native input', async () => {
    const { control, execute } = setup()
    const lease = (await control.prepare('codex', request()))!
    await lease.handoff(true)
    let permitted = true
    execute.mockImplementationOnce(async (_command, validate) => {
      permitted = false
      validate?.()
      return { text: 'must not run' }
    })
    await expect(lease.execute({ action: 'human_input' }, 'human', () => permitted)).rejects.toThrow('live view')
    await lease.dispose()
  })

})
