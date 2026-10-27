// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DesktopSurface } from './ComputerDesktopPanel'
import type { ComputerDesktop } from '../../electron/computer-control'

const desktop: ComputerDesktop = { sessionId: 'fixture', window: '51:23', app: 'Canvas', title: 'Sample', controller: 'agent', transitioning: false, controlVersion: 0 }
let root: Root
let container: HTMLDivElement
let frame: VideoFrameRequestCallback
let track: { stop: ReturnType<typeof vi.fn>; addEventListener: ReturnType<typeof vi.fn> }
let api: { armStream: ReturnType<typeof vi.fn>; streamStopped: ReturnType<typeof vi.fn>; handoff: ReturnType<typeof vi.fn>; input: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }
let getDisplayMedia: ReturnType<typeof vi.fn>
function button(text: string) { return [...container.querySelectorAll('button')].find(b => b.textContent === text)! }
async function click(text: string) { await act(async () => { button(text).click() }) }
beforeEach(async () => {
  vi.useFakeTimers()
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  track = { stop: vi.fn(), addEventListener: vi.fn() }
  const stream = { getTracks: () => [track], getVideoTracks: () => [track] }
  getDisplayMedia = vi.fn(async () => stream)
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getDisplayMedia } })
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue()
  HTMLVideoElement.prototype.requestVideoFrameCallback = vi.fn(callback => { frame = callback; return 1 })
  api = { armStream: vi.fn(async () => ({ ok: true, data: 'video-grant' })), streamStopped: vi.fn(async () => ({ ok: true })),
    handoff: vi.fn(async () => ({ ok: true, data: desktop })), input: vi.fn(async () => ({ ok: true, data: {} })), stop: vi.fn(async () => ({ ok: true })) }
  window.codey = { computer: api } as any
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  await act(async () => { root.render(React.createElement(DesktopSurface, { desktop, agent: 'Bot' })) })
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); vi.restoreAllMocks() })
describe('live desktop panel', () => {
  it('uses video streaming without polling screenshots and only enables takeover after a decoded frame', async () => {
    expect(button('Take control').disabled).toBe(true)
    await click('Start live view')
    expect(getDisplayMedia).toHaveBeenCalledWith({ audio: false, video: { frameRate: { ideal: 30, max: 30 } } })
    await act(async () => { vi.advanceTimersByTime(300) })
    expect(button('Take control').disabled).toBe(true)
    await act(async () => { frame(0, {} as VideoFrameCallbackMetadata); vi.advanceTimersByTime(300) })
    expect(button('Take control').disabled).toBe(false)
    await click('Take control')
    expect(api.handoff).toHaveBeenCalledWith('fixture', '51:23', true, 'video-grant')
    await click('Pause video')
    expect(track.stop).toHaveBeenCalledOnce()
    expect(api.streamStopped).toHaveBeenCalledWith('video-grant')
    expect(button('Take control').disabled).toBe(true)
  })
  it('stops tracks when the desktop panel unmounts, including a stream that resolves late', async () => {
    let finish!: (stream: unknown) => void
    getDisplayMedia.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    await click('Start live view')
    await act(async () => { root.unmount() })
    await act(async () => { finish({ getTracks: () => [track], getVideoTracks: () => [track] }) })
    expect(track.stop).toHaveBeenCalledOnce()
    expect(api.streamStopped).toHaveBeenCalledWith('video-grant')
  })
  it('pauses input on stalled video without silently handing control back', async () => {
    await click('Start live view')
    await act(async () => {
      frame(0, {} as VideoFrameCallbackMetadata)
      root.render(React.createElement(DesktopSurface, { desktop: { ...desktop, controller: 'human', controlVersion: 1 }, agent: 'Bot' }))
      vi.advanceTimersByTime(300)
    })
    const input = container.querySelector('textarea')!
    expect(input.disabled).toBe(false)
    await act(async () => { vi.advanceTimersByTime(1800) })
    expect(input.disabled).toBe(true)
    expect(api.handoff).not.toHaveBeenCalled()
    expect(button('Return control').disabled).toBe(false)
  })
})
