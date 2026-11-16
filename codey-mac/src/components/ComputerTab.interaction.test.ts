// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ComputerTab } from './ComputerTab'

// The Computer page is a setup checklist: each missing permission offers its
// own "Allow" action and the master switch stays locked until setup is
// complete. Every application is allowed until the user picks specific ones.

let host: HTMLDivElement
let root: Root
let state: any
let computer: any

const ok = <T,>(data: T) => ({ ok: true, data })
const base = {
  enabled: false, scope: 'all', apps: [], available: true, accessibility: false, screenRecording: false, active: null, queued: 0,
}
const mount = async () => {
  await act(async () => { root.render(React.createElement(ComputerTab)) })
}
const button = (text: string) => [...host.querySelectorAll('button')].find(b => b.textContent?.includes(text))
const toggle = () => host.querySelector('[role="switch"]') as HTMLElement

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  state = { ...base }
  computer = {
    status: vi.fn(async () => ok(state)),
    onChanged: vi.fn(() => () => {}),
    permissions: vi.fn(async () => { state = { ...state, accessibility: true, screenRecording: true }; return ok(state) }),
    configure: vi.fn(async (enabled: boolean, apps: any[]) => { state = { ...state, enabled, apps, scope: apps.length ? 'selected' : 'all' }; return ok(state) }),
    pickApp: vi.fn(async () => ok({ bundleId: 'com.example.notes', name: 'Sample Notes' })),
  }
  ;(window as any).codey = { computer }
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

describe('ComputerTab', () => {
  it('locks the switch and says why until permissions are granted; no app list is needed', async () => {
    await mount()
    expect(toggle().getAttribute('aria-disabled')).toBe('true')
    expect(host.textContent).toContain('Grant both permissions below first.')

    await act(async () => { button('Allow')!.click() })
    expect(computer.permissions).toHaveBeenCalledTimes(1)
    expect(button('Allow')).toBeUndefined()
    expect(host.textContent).toContain('All applications.')
    expect(toggle().getAttribute('aria-disabled')).toBeNull()

    await act(async () => { toggle().click() })
    expect(computer.configure).toHaveBeenLastCalledWith(true, [])
    expect(toggle().getAttribute('aria-checked')).toBe('true')
  })

  it('narrows to a list when an app is picked and returns to all when the list is emptied', async () => {
    state = { ...base, enabled: true, accessibility: true, screenRecording: true }
    await mount()
    await act(async () => { button('Limit to specific apps')!.click() })
    expect(computer.configure).toHaveBeenLastCalledWith(true, [{ bundleId: 'com.example.notes', name: 'Sample Notes' }])
    expect(host.textContent).toContain('Only these applications.')
    expect(host.textContent).toContain('Sample Notes')
    expect(button('Add application')).toBeDefined()

    await act(async () => { (host.querySelector('[aria-label="Remove Sample Notes"]') as HTMLElement).click() })
    // Emptying the list keeps computer control on: it is "all applications" again.
    expect(computer.configure).toHaveBeenLastCalledWith(true, [])
    expect(host.textContent).toContain('All applications.')
  })

  it('shows a failed action as a banner', async () => {
    computer.permissions = vi.fn(async () => ({ ok: false, error: 'Driver did not start' }))
    await mount()
    await act(async () => { button('Allow')!.click() })
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('Driver did not start')
  })
})

describe('Computer in the Plugins list', () => {
  const plugins = {
    list: async () => ok([{ id: 'terminal', name: 'Terminal', tagline: 'Sample tagline', description: 'Sample description',
      state: 'installed', dir: '/tmp/sample' }]),
    check: vi.fn(), install: vi.fn(), uninstall: vi.fn(), setEnabled: vi.fn(),
  }
  const mountList = async () => {
    const { PluginsTab } = await import('./PluginsTab')
    ;(window as any).codey.plugins = plugins
    await act(async () => { root.render(React.createElement(PluginsTab)) })
  }
  const computerSwitch = () => host.querySelector('[role="switch"][aria-label="Enable Computer"]') as HTMLElement

  it('sits beside the other plugins and opens its checklist when setup is missing', async () => {
    await mountList()
    expect(host.textContent).toContain('Terminal')
    expect(host.textContent).toContain('Needs setup')

    await act(async () => { computerSwitch().click() })
    expect(computer.configure).not.toHaveBeenCalled()
    expect(host.textContent).toContain('Grant both permissions below first.')

    await act(async () => { button('Plugins')!.click() })
    expect(host.textContent).toContain('Terminal')
  })

  it('switches on from the list once setup is complete', async () => {
    state = { ...base, accessibility: true, screenRecording: true, apps: [{ bundleId: 'com.example.notes', name: 'Sample Notes' }] }
    await mountList()
    expect(host.textContent).not.toContain('Needs setup')
    await act(async () => { computerSwitch().click() })
    expect(computer.configure).toHaveBeenCalledWith(true, state.apps)
    expect(computerSwitch().getAttribute('aria-checked')).toBe('true')
  })
})
