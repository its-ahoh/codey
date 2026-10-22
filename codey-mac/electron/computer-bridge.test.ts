import { describe, expect, it, vi } from 'vitest'
import { request as httpRequest } from 'node:http'
import { existsSync, readFileSync } from 'node:fs'
import { ComputerControl } from './computer-control'
import { createComputerBridge } from './computer-bridge'
import type { AgentRequest } from '@codey/core'
const apps = [{ bundleId: 'org.example.Canvas', name: 'Canvas' }]
const request: AgentRequest = { agent: 'codex', prompt: 'Draw a square', browserTools: true, context: { workingDir: '/tmp/sample' } }
function setup() {
  const approve = vi.fn(async (_agent: string) => true)
  const start = vi.fn(async () => {})
  const stop = vi.fn(async () => {})
  const execute = vi.fn(async () => ({ text: 'Sample window', target: { pid: 51, windowId: 23, title: 'Sample', app: 'Canvas' }, images: [{ mimeType: 'image/png', dataBase64: 'YWJj' }] }))
  const control = new ComputerControl({ ready: () => true, approve, driver: () => ({ start, stop, execute }), changed: vi.fn() })
  control.apps = apps; control.enabled = true
  const bridge = createComputerBridge(control, '/fixture/cli.cjs', '/fixture/runtime')
  return { control, bridge, approve, start, stop, execute }
}
function call(env: Record<string, string>, command: unknown, token = env.CODEY_COMPUTER_TOKEN): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ socketPath: env.CODEY_COMPUTER_SOCKET, path: '/command', method: 'POST', headers: { authorization: `Bearer ${token}` } }, res => {
      let text = ''; res.on('data', part => { text += part }); res.on('end', () => resolve({ status: res.statusCode!, body: text ? JSON.parse(text) : null }))
    })
    req.on('error', reject); req.end(JSON.stringify(command))
  })
}
describe('Codey computer bridge', () => {
  it('offers one Codey API to every agent without starting a driver for regular tasks', async () => {
    const { bridge, start, approve } = setup()
    try {
      for (const agent of ['codex', 'claude-code', 'opencode', 'pi'] as const) {
        const lease = await bridge.prepare(agent, request)
        expect(lease?.request.mcpServers).toBeUndefined()
        expect(lease?.request.extraEnv?.CODEY_COMPUTER_TOKEN).toBeTruthy()
        expect((await call(lease!.request.extraEnv!, { action: 'apps' })).body.data.data).toEqual(apps)
        await lease!.dispose()
      }
      expect(start).not.toHaveBeenCalled(); expect(approve).not.toHaveBeenCalled()
    } finally { await bridge.shutdown() }
  })
  it('mediates observation, returns an image file, and revokes credentials and pixels at task end', async () => {
    const { bridge, start, execute } = setup()
    try {
      const lease = (await bridge.prepare('pi', request))!
      const env = lease.request.extraEnv!
      expect((await call(env, { action: 'observe' }, 'invalid')).status).toBe(403)
      expect(start).not.toHaveBeenCalled()
      const result = await call(env, { action: 'observe', window: 'sample' })
      expect(execute).toHaveBeenCalledWith({ action: 'observe', window: 'sample' }, expect.any(Function))
      expect(start).toHaveBeenCalledOnce()
      const path = result.body.data.images[0].path
      expect(readFileSync(path, 'utf8')).toBe('abc')
      expect(bridge.preview()?.window).toBe('sample')
      await lease.dispose()
      expect(existsSync(path)).toBe(false)
      expect((await call(env, { action: 'observe' })).status).toBe(403)
      expect(bridge.preview()).toBeNull()
    } finally { await bridge.shutdown() }
  })
  it('declines computer use without aborting an ordinary coding request', async () => {
    const { bridge, approve, start } = setup()
    approve.mockResolvedValue(false)
    try {
      const signal = new AbortController()
      const lease = (await bridge.prepare('codex', { ...request, signal: signal.signal }))!
      const result = await call(lease.request.extraEnv!, { action: 'observe' })
      expect(result.body.ok).toBe(false)
      expect(signal.signal.aborted).toBe(false)
      expect(start).not.toHaveBeenCalled()
      await lease.dispose()
    } finally { await bridge.shutdown() }
  })
  it('stops active and queued computer requests and refuses old capabilities', async () => {
    const { bridge, approve } = setup()
    try {
      const first = (await bridge.prepare('codex', request))!
      const second = (await bridge.prepare('pi', request))!
      await call(first.request.extraEnv!, { action: 'observe' })
      const queued = call(second.request.extraEnv!, { action: 'observe' })
      await bridge.stop()
      expect((await queued).status).not.toBe(200)
      expect(approve).toHaveBeenCalledOnce()
      expect((await call(first.request.extraEnv!, { action: 'observe' })).status).toBe(403)
    } finally { await bridge.shutdown() }
  })
  it('hands a Codey preview over to an agent through a fresh approval', async () => {
    const { bridge, approve, stop } = setup()
    try {
      await bridge.view({ action: 'observe', window: 'sample' })
      expect(approve.mock.calls[0][0]).toBe('Codey preview')
      const lease = (await bridge.prepare('codex', request))!
      await call(lease.request.extraEnv!, { action: 'observe', window: 'sample' })
      expect(stop).toHaveBeenCalledOnce()
      expect(approve).toHaveBeenCalledTimes(2)
      await expect(bridge.view({ action: 'observe' })).rejects.toThrow('agent owns')
      await lease.dispose()
    } finally { await bridge.shutdown() }
  })
  it('exposes takeover only to Codey and rejects old input after handback', async () => {
    const { bridge } = setup()
    try {
      const lease = (await bridge.prepare('codex', request))!
      const env = lease.request.extraEnv!
      await call(env, { action: 'observe', window: 'sample' })
      const desktop = bridge.desktop()!
      expect((await call(env, { action: 'human_input', window: 'sample' })).status).toBe(400)
      const taken = await bridge.handoff(desktop.sessionId, desktop.window, true)
      expect((await call(env, { action: 'act', window: 'sample' })).body.error).toContain('user has control')
      await bridge.humanInput(taken.sessionId, taken.window, { tool: 'click' }, taken.controlVersion)
      await bridge.handoff(taken.sessionId, taken.window, false)
      const again = await bridge.handoff(taken.sessionId, taken.window, true)
      await expect(bridge.humanInput(taken.sessionId, taken.window, { tool: 'click' }, taken.controlVersion)).rejects.toThrow('Take control')
      expect(again.controlVersion).toBeGreaterThan(taken.controlVersion)
      await lease.dispose()
      expect(bridge.desktop()).toBeNull()
    } finally { await bridge.shutdown() }
  })
  it('does not let an agent displace a human-controlled local preview', async () => {
    const { bridge, approve } = setup()
    try {
      await bridge.view({ action: 'observe', window: 'sample' })
      const desktop = bridge.desktop()!
      await bridge.handoff(desktop.sessionId, desktop.window, true)
      const lease = (await bridge.prepare('pi', request))!
      const result = await call(lease.request.extraEnv!, { action: 'observe', window: 'sample' })
      expect(result.body.error).toContain('user has control')
      expect(approve).toHaveBeenCalledOnce()
      expect(bridge.desktop()?.controller).toBe('human')
      await lease.dispose()
    } finally { await bridge.shutdown() }
  })

})
