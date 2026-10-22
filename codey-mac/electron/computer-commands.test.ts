import { describe, expect, it, vi } from 'vitest'
import type { CuaDriverLike } from '@trycua/cua-driver'
import { computerCommands } from './computer-commands'
function setup() {
  const listApps = vi.fn(async () => ({ apps: [{ pid: 42, running: true, bundleId: 'org.example.Canvas' }] }))
  const listWindows = vi.fn(async () => ({ windows: [{ pid: 42, windowId: 10n, title: 'Sample' }] }))
  const callTool = vi.fn(async (_name: string, _args: string) => ({ text: 'sample', images: [{ mimeType: 'image/png', dataBase64: 'YWJj' }], isError: false, structuredJson: JSON.stringify({ screenshot_width: 1200, screenshot_height: 600 }) }))
  const execute = computerCommands({ listApps, listWindows, callTool } as unknown as CuaDriverLike, [{ bundleId: 'org.example.Canvas', name: 'Canvas' }])
  return { execute, listApps, callTool }
}
describe('Codey window commands', () => {
  it('binds input to a listed approved window and requires a new observation after each action', async () => {
    const { execute, callTool } = setup()
    await execute({ action: 'windows', bundleId: 'org.example.Canvas' })
    const action = { action: 'act', window: '42:10', args: { tool: 'click', x: 4, y: 8 } }
    await expect(execute(action)).rejects.toThrow('Observe')
    await execute({ action: 'observe', window: '42:10' })
    await execute(action)
    expect(JSON.parse(callTool.mock.calls[1][1])).toMatchObject({ pid: 42, window_id: 10, scope: 'window', x: 4, y: 8, delivery_mode: 'background' })
    await expect(execute(action)).rejects.toThrow('Observe')
  })
  it('rejects target overrides, unknown apps, and process reuse', async () => {
    const { execute, callTool, listApps } = setup()
    await expect(execute({ action: 'windows', bundleId: 'org.example.Other' })).rejects.toThrow('outside')
    await execute({ action: 'windows', bundleId: 'org.example.Canvas' })
    await execute({ action: 'observe', window: '42:10' })
    for (const field of ['pid', 'window_id', 'scope', 'session', 'target', 'debug_image_out']) {
      await expect(execute({ action: 'act', window: '42:10', args: { tool: 'click', [field]: 'forged' } })).rejects.toThrow('Unsupported action field')
    }
    listApps.mockResolvedValue({ apps: [{ pid: 42, running: true, bundleId: 'org.example.Other' }] })
    await expect(execute({ action: 'act', window: '42:10', args: { tool: 'press_key', key: 'Return' } })).rejects.toThrow('changed')
    expect(callTool).toHaveBeenCalledOnce()
  })
  it('maps live-video coordinates through a fresh window observation and refuses changed geometry', async () => {
    const { execute, callTool } = setup()
    await execute({ action: 'windows', bundleId: 'org.example.Canvas' })
    await execute({ action: 'human_input', window: '42:10', args: { tool: 'click', x: 0.25, y: 0.5, frameWidth: 800, frameHeight: 400 } })
    expect(JSON.parse(callTool.mock.calls[1][1])).toMatchObject({ pid: 42, window_id: 10, x: 300, y: 300 })
    await expect(execute({ action: 'human_input', window: '42:10', args: { tool: 'click', x: 0.25, y: 0.5, frameWidth: 400, frameHeight: 400 } })).rejects.toThrow('geometry changed')
    expect(callTool.mock.calls.filter(call => call[0] === 'click')).toHaveLength(1)
  })
  it('never captures pixels when checking a video target and invalidates observations on handoff', async () => {
    const { execute, callTool } = setup()
    await execute({ action: 'windows', bundleId: 'org.example.Canvas' })
    await expect(execute({ action: 'inspect', window: '42:10' })).resolves.toMatchObject({ target: { pid: 42, windowId: 10 } })
    expect(callTool).not.toHaveBeenCalled()
    await execute({ action: 'observe', window: '42:10' })
    await execute({ action: 'invalidate' })
    await expect(execute({ action: 'act', window: '42:10', args: { tool: 'press_key', key: 'Return' } })).rejects.toThrow('Observe')
  })

})
