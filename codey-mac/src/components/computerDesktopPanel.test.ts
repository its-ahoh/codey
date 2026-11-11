// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DesktopSurface } from './ComputerDesktopPanel'
import type { ComputerDesktop } from '../../electron/computer-control'

const desktop: ComputerDesktop = { sessionId: 'fixture', window: '51:23', app: 'Canvas', title: 'Sample', controller: 'agent', transitioning: false, controlVersion: 0 }
let root: Root
let container: HTMLDivElement
let track: { stop: ReturnType<typeof vi.fn>; addEventListener: ReturnType<typeof vi.fn> }
let api: Record<'armStream' | 'streamStopped' | 'handoff' | 'reveal' | 'stop', ReturnType<typeof vi.fn>>
let getDisplayMedia: ReturnType<typeof vi.fn>
function button(text: string) { return [...container.querySelectorAll('button')].find(b => b.textContent === text)! }
async function click(text: string) { await act(async () => { button(text).click() }) }
beforeEach(async () => {
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  track = { stop: vi.fn(), addEventListener: vi.fn() }
  const stream = { getTracks: () => [track], getVideoTracks: () => [track] }
  getDisplayMedia = vi.fn(async () => stream)
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getDisplayMedia } })
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue()
  api = { armStream: vi.fn(async () => ({ ok: true, data: 'video-grant' })), streamStopped: vi.fn(async () => ({ ok: true })),
    handoff: vi.fn(async () => ({ ok: true, data: desktop })), reveal: vi.fn(async () => ({ ok: true })), stop: vi.fn(async () => ({ ok: true })) }
  window.codey = { computer: api } as any
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  await act(async () => { root.render(React.createElement(DesktopSurface, { desktop, agent: 'Bot' })) })
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks() })
describe('live desktop panel', () => {
  it('streams the window and jumps to it on click, without sending any input', async () => {
    const video = container.querySelector('video')!
    await act(async () => { video.click() })
    expect(api.reveal).not.toHaveBeenCalled()
    await click('Start live view')
    expect(getDisplayMedia).toHaveBeenCalledWith({ audio: false, video: { frameRate: { ideal: 30, max: 30 } } })
    await act(async () => { video.click() })
    expect(api.reveal).toHaveBeenCalledWith('fixture', '51:23')
    expect(container.querySelector('textarea')).toBeNull()
    await click('Pause video')
    expect(track.stop).toHaveBeenCalledOnce()
    expect(api.streamStopped).toHaveBeenCalledWith('video-grant')
  })
  it('pauses and resumes the agent without needing the video', async () => {
    await click('Pause agent')
    expect(api.handoff).toHaveBeenCalledWith('fixture', '51:23', true)
    await act(async () => { root.render(React.createElement(DesktopSurface, { desktop: { ...desktop, controller: 'human', controlVersion: 1 }, agent: 'Bot' })) })
    expect(container.querySelector('[role=status]')!.textContent).toBe('Bot is paused')
    await click('Resume agent')
    expect(api.handoff).toHaveBeenLastCalledWith('fixture', '51:23', false)
    await click('Go to window')
    expect(api.reveal).toHaveBeenCalledWith('fixture', '51:23')
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
})
