// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const render = vi.fn(async (_id: string, _code: string) => ({ svg: '<svg data-drawn=""></svg>' }))
vi.mock('mermaid', () => ({ default: { initialize: vi.fn(), render } }))

import { MermaidBlock } from './MermaidBlock'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  render.mockClear()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

const show = (code: string) => act(async () => {
  root.render(React.createElement(MermaidBlock, { code, fallback: React.createElement('pre', null, code) }))
})

describe('MermaidBlock', () => {
  it('waits for the streamed source to settle before rendering', async () => {
    await show('graph TD')
    await act(async () => { vi.advanceTimersByTime(100) })
    await show('graph TD\nA')
    await act(async () => { vi.advanceTimersByTime(100) })
    await show('graph TD\nA-->B')
    await act(async () => { vi.advanceTimersByTime(299) })
    expect(render).not.toHaveBeenCalled()
    expect(container.querySelector('[data-mermaid-pending]')?.textContent).toBe('graph TD\nA-->B')

    await act(async () => { vi.advanceTimersByTime(1) })
    await act(async () => { await vi.runAllTimersAsync() })
    expect(render).toHaveBeenCalledOnce()
    expect(render.mock.calls[0][1]).toBe('graph TD\nA-->B')
    expect(container.querySelector('[data-drawn]')).not.toBeNull()
  })

  it('does not render after unmounting during the wait', async () => {
    await show('graph TD\nA-->B')
    await act(async () => root.unmount())
    await act(async () => { vi.advanceTimersByTime(1000) })
    expect(render).not.toHaveBeenCalled()
    root = createRoot(container)
  })
})
