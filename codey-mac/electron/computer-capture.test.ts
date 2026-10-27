import { describe, expect, it, vi } from 'vitest'
import { createComputerCapture } from './computer-capture'
const frame = { url: 'file:///app/index.html' }
const request = { frame, videoRequested: true, audioRequested: false, userGesture: true } as Electron.DisplayMediaRequestHandlerHandlerRequest
function setup() {
  const inspect = vi.fn(async () => ({ pid: 51, windowId: 23, app: 'Canvas', title: 'Sample' }))
  const sources = vi.fn(async () => [{ id: 'screen:0:0' }, { id: 'window:24:0' }, { id: 'window:23:0' }] as Electron.DesktopCapturerSource[])
  const permitted = vi.fn(() => true)
  const capture = createComputerCapture({ renderer: () => ({ mainFrame: frame }) as Electron.WebContents, permitted, inspect, sources })
  return { capture, inspect, sources, permitted }
}
describe('exact-window video capture', () => {
  it('grants only the approved native window once and never grants audio or full-screen capture', async () => {
    const { capture } = setup()
    const id = await capture.arm('sample', '51:23')
    const callback = vi.fn()
    await capture.handle(request, callback)
    expect(callback).toHaveBeenCalledWith({ video: { id: 'window:23:0' } })
    expect(capture.isActive(id, 'sample', '51:23')).toBe(true)
    expect(capture.isActive(id, 'sample', '51:24')).toBe(false)
    callback.mockClear()
    await capture.handle(request, callback)
    expect(callback).toHaveBeenCalledWith({})
    capture.release(id)
    expect(capture.isActive(id, 'sample', '51:23')).toBe(false)
  })
  it('rejects websites, subframes, non-gesture requests and audio', async () => {
    const { capture, sources } = setup()
    for (const overrides of [{ frame: { url: 'https://example.test' } }, { userGesture: false }, { audioRequested: true }, { videoRequested: false }]) {
      await capture.arm('sample', '51:23')
      const callback = vi.fn()
      await capture.handle({ ...request, ...overrides } as Electron.DisplayMediaRequestHandlerHandlerRequest, callback)
      expect(callback).toHaveBeenCalledWith({})
    }
    expect(sources).not.toHaveBeenCalled()
  })
  it('refuses a grant revoked while the native source list is loading', async () => {
    const { capture, sources } = setup()
    sources.mockImplementation(async () => { capture.revoke(); return [{ id: 'window:23:0' }] as Electron.DesktopCapturerSource[] })
    await capture.arm('sample', '51:23')
    const callback = vi.fn()
    await capture.handle(request, callback)
    expect(callback).toHaveBeenCalledWith({})
  })
  it('does not replace a closed window with another window or a desktop', async () => {
    const { capture, sources } = setup()
    sources.mockResolvedValue([{ id: 'window:24:0' }, { id: 'screen:23:0' }] as Electron.DesktopCapturerSource[])
    await capture.arm('sample', '51:23')
    const callback = vi.fn()
    await capture.handle(request, callback)
    expect(callback).toHaveBeenCalledWith({})
  })
  it('keeps video during handoff but revokes it when the task or target changes', async () => {
    const { capture } = setup()
    const id = await capture.arm('sample', '51:23')
    await capture.handle(request, vi.fn())
    capture.sync({ sessionId: 'sample', window: '51:23', title: 'Sample', app: 'Canvas', controller: 'human', transitioning: false, controlVersion: 1 })
    expect(capture.isActive(id, 'sample', '51:23')).toBe(true)
    capture.sync(null)
    expect(capture.isActive(id, 'sample', '51:23')).toBe(false)
  })
})
