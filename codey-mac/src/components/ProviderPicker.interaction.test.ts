// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProviderLogo, ProviderPickerModal } from './ProviderPicker'
import { UsageTab } from './UsageTab'

let host: HTMLDivElement
let root: Root
const ok = <T,>(data: T) => ({ ok: true, data })

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  delete (window as any).codey
  vi.unstubAllGlobals()
})

const providers = [
  { id: 'deepseek', label: 'DeepSeek', modelCount: 1, curated: true, logoId: 'deepseek', colorLogo: 'deepseek' },
  { id: 'nologo', label: 'No Logo Co', modelCount: 1, curated: false },
]

describe('ProviderLogo', () => {
  it('draws bundled logos as data URLs, never from the network', async () => {
    await act(async () => root.render(React.createElement(ProviderLogo, { provider: providers[0] as any })))
    // The logo bank is a lazily loaded chunk; wait for it to resolve.
    for (let i = 0; i < 100 && !host.querySelector('img'); i++) {
      await act(async () => { await new Promise(r => setTimeout(r, 20)) })
    }
    const img = host.querySelector('img')
    expect(img).toBeTruthy()
    expect(img!.getAttribute('src')!.startsWith('data:image/svg+xml')).toBe(true)
  })

  it('falls back to the first letter when there is no logo', async () => {
    await act(async () => root.render(React.createElement(ProviderLogo, { provider: providers[1] as any })))
    await act(async () => { await new Promise(r => setTimeout(r, 50)) })
    expect(host.querySelector('img')).toBeNull()
    expect(host.textContent).toBe('N')
  })
})

describe('ProviderPickerModal keyboard', () => {
  it('keeps Tab focus inside the dialog', async () => {
    ;(window as any).codey = { providers: { catalogModels: async () => ok([]) } }
    await act(async () => root.render(React.createElement(ProviderPickerModal, {
      providers: providers as any, mode: 'provider', onClose: () => {},
    })))
    const dialog = document.querySelector('[role="dialog"]')!
    const focusables = [...dialog.querySelectorAll<HTMLElement>('button:not(:disabled), input')]
    const last = focusables[focusables.length - 1]
    last.focus()
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true })) })
    expect(document.activeElement).toBe(focusables[0])
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true })) })
    expect(document.activeElement).toBe(last)
  })
})

describe('UsageTab', () => {
  it('reads usage even while the gateway is stopped', async () => {
    const summary = vi.fn(async () => ok({
      since: 0, rows: [], unpricedRows: false, balanceKeys: [],
      totals: { runs: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 },
    }))
    ;(window as any).codey = { usage: { summary }, providers: { balance: vi.fn() } }
    await act(async () => root.render(React.createElement(UsageTab, { isGatewayRunning: false })))
    expect(summary).toHaveBeenCalledWith(7)
    expect(host.textContent).not.toContain('Gateway not available')
    expect(host.textContent).toContain('No agent runs recorded')
  })
})
