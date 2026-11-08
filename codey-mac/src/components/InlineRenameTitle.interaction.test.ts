// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { InlineRenameTitle } from './InlineRenameTitle'

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})

const render = async (onRename: (title: string) => Promise<void>) => {
  await act(async () => root.render(React.createElement(InlineRenameTitle, { title: 'Sample Chat', onRename })))
}
const label = () => host.querySelector<HTMLElement>('[data-testid="inline-rename-label"]')!
const input = () => host.querySelector<HTMLInputElement>('input')
const startEditing = async () => {
  await act(async () => { label().dispatchEvent(new MouseEvent('dblclick', { bubbles: true })) })
}
const type = async (value: string) => {
  const el = input()!
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  await act(async () => {
    setter.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const key = async (k: string) => {
  await act(async () => { input()!.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })) })
}

describe('InlineRenameTitle', () => {
  it('shows the title and is not editing at first', async () => {
    await render(vi.fn(async () => {}))
    expect(label().textContent).toBe('Sample Chat')
    expect(input()).toBeNull()
  })

  it('enters rename mode on double-click with the current title selected', async () => {
    await render(vi.fn(async () => {}))
    await startEditing()
    expect(input()?.value).toBe('Sample Chat')
    expect(document.activeElement).toBe(input())
  })

  it('saves the trimmed name on Enter', async () => {
    const onRename = vi.fn(async () => {})
    await render(onRename)
    await startEditing()
    await type('  Example Room  ')
    await key('Enter')
    expect(onRename).toHaveBeenCalledTimes(1)
    expect(onRename).toHaveBeenCalledWith('Example Room')
    expect(input()).toBeNull()
  })

  it('saves on blur', async () => {
    const onRename = vi.fn(async () => {})
    await render(onRename)
    await startEditing()
    await type('Demo Space')
    await act(async () => { input()!.blur() })
    expect(onRename).toHaveBeenCalledWith('Demo Space')
    expect(input()).toBeNull()
  })

  it('cancels on Escape without saving', async () => {
    const onRename = vi.fn(async () => {})
    await render(onRename)
    await startEditing()
    await type('Demo Space')
    await key('Escape')
    expect(onRename).not.toHaveBeenCalled()
    expect(input()).toBeNull()
    expect(label().textContent).toBe('Sample Chat')
  })

  it('does not save when Esc removes the input and Chromium fires blur', async () => {
    const onRename = vi.fn(async () => {})
    await render(onRename)
    await startEditing()
    await type('Demo Space')
    const el = input()!
    await act(async () => {
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
    })
    expect(onRename).not.toHaveBeenCalled()
    expect(input()).toBeNull()
  })

  it('rejects an empty name and keeps the old one', async () => {
    const onRename = vi.fn(async () => {})
    await render(onRename)
    await startEditing()
    await type('   ')
    await key('Enter')
    expect(onRename).not.toHaveBeenCalled()
    expect(input()).not.toBeNull()
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('Name cannot be empty')
  })

  it('does not save when the name is unchanged', async () => {
    const onRename = vi.fn(async () => {})
    await render(onRename)
    await startEditing()
    await key('Enter')
    expect(onRename).not.toHaveBeenCalled()
  })

  it('keeps editing and shows the error when saving fails', async () => {
    const onRename = vi.fn(async () => { throw new Error('Name rejected') })
    await render(onRename)
    await startEditing()
    await type('Example Room')
    await key('Enter')
    expect(input()).not.toBeNull()
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('Name rejected')
  })

  it('marks the label so the header drag region does not swallow the double-click', async () => {
    await render(vi.fn(async () => {}))
    expect(label().classList.contains('inline-rename-title')).toBe(true)
  })
})
