// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ComputerTab } from './ComputerTab'

// The Computer tab is a setup checklist: each missing permission offers its
// own "Allow" action, the master switch stays locked until setup is complete,
// and picking a window opens the desktop panel in one click.

let host: HTMLDivElement
let root: Root
let state: any
let computer: any

const ok = <T,>(data: T) => ({ ok: true, data })
const base = {
  enabled: false, apps: [], available: true, accessibility: false, screenRecording: false, active: null, queued: 0,
}
const mount = async (props: { onOpenDesktop?: () => void } = {}) => {
  await act(async () => { root.render(React.createElement(ComputerTab, props)) })
}
const button = (text: string) => [...host.querySelectorAll('button')].find(b => b.textContent?.includes(text))
const toggle = () => host.querySelector('[role="switch"]') as HTMLElement

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  state = { ...base }
  computer = {
    status: vi.fn(async () => ok(state)),
    onChanged: vi.fn(() => () => {}),
    preview: vi.fn(async () => ok(null)),
    permissions: vi.fn(async () => { state = { ...state, accessibility: true, screenRecording: true }; return ok(state) }),
    configure: vi.fn(async (enabled: boolean, apps: any[]) => { state = { ...state, enabled, apps }; return ok(state) }),
    pickApp: vi.fn(async () => ok({ bundleId: 'com.example.notes', name: 'Sample Notes' })),
    view: vi.fn(),
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
  it('locks the switch and says why until permissions and an app are set up', async () => {
    await mount()
    expect(toggle().getAttribute('aria-disabled')).toBe('true')
    expect(host.textContent).toContain('Grant both permissions below first.')

    await act(async () => { button('Allow')!.click() })
    expect(computer.permissions).toHaveBeenCalledTimes(1)
    expect(button('Allow')).toBeUndefined()
    expect(host.textContent).toContain('Add at least one application below first.')

    await act(async () => { button('Add application')!.click() })
    expect(host.textContent).toContain('Sample Notes')
    expect(toggle().getAttribute('aria-disabled')).toBeNull()

    await act(async () => { toggle().click() })
    expect(computer.configure).toHaveBeenLastCalledWith(true, [{ bundleId: 'com.example.notes', name: 'Sample Notes' }])
    expect(toggle().getAttribute('aria-checked')).toBe('true')
  })

  it('opens the desktop panel when a window is picked', async () => {
    state = { ...base, accessibility: true, screenRecording: true, enabled: true,
      apps: [{ bundleId: 'com.example.notes', name: 'Sample Notes' }] }
    computer.view = vi.fn(async (command: any) => {
      if (command.action === 'windows') {
        state = { ...state, active: { agent: 'Codey preview', phase: 'controlling' } }
        return ok({ windows: [{ id: 'w1', app: 'Sample Notes', title: 'Shopping list' }] })
      }
      return ok({ text: 'button "Done"', images: [] })
    })
    computer.status = vi.fn(async () => ok(state))
    const onOpenDesktop = vi.fn()
    await mount({ onOpenDesktop })

    await act(async () => { button('Show windows')!.click() })
    // The preview session is announced over onChanged in the app.
    await act(async () => { computer.onChanged.mock.calls[0][0](state) })
    await act(async () => { button('Shopping list')!.click() })

    expect(computer.view).toHaveBeenLastCalledWith({ action: 'observe', window: 'w1' })
    expect(onOpenDesktop).toHaveBeenCalledTimes(1)
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
  const mountList = async (props: { onOpenDesktop?: () => void } = {}) => {
    const { PluginsTab } = await import('./PluginsTab')
    ;(window as any).codey.plugins = plugins
    await act(async () => { root.render(React.createElement(PluginsTab, props)) })
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
