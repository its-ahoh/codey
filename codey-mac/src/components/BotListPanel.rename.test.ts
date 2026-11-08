// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const renameChat = vi.fn(async () => {})
const selectChat = vi.fn()
const chat = {
  id: 'chat-1', title: 'Sample Room', messages: [],
  botChat: { kind: 'group', members: ['alpha', 'beta'] },
}

vi.mock('../hooks/useChats', () => ({
  useChats: () => ({
    state: { order: ['chat-1'], chats: { 'chat-1': chat }, selectedChatId: null, inFlight: {}, unreadChats: {} },
    openBot: vi.fn(), selectChat, renameChat,
  }),
}))
vi.mock('../services/api', () => ({ apiService: { listBots: vi.fn(async () => []) } }))

vi.mock('./SidebarNavigation', () => ({
  SidebarFooter: () => null,
  SidebarAction: () => null,
  SidebarSearch: () => null,
}))

const { BotListPanel } = await import('./BotListPanel')

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {} })
  renameChat.mockClear()
  selectChat.mockClear()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})

const render = async () => {
  await act(async () => root.render(React.createElement(BotListPanel, {
    newBotRequested: false, onNewBotHandled: () => {}, onOpenSettings: () => {},
  } as never)))
}
const label = () => host.querySelector<HTMLElement>('[data-testid="inline-rename-label"]')

describe('BotListPanel rename', () => {
  it('renames a chat when its name is double-clicked in the list', async () => {
    await render()
    expect(label()?.textContent).toBe('Sample Room')
    await act(async () => { label()!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })) })
    const input = host.querySelector<HTMLInputElement>('input[aria-label="Rename chat"]')!
    expect(input).not.toBeNull()
    expect(input.closest('button')).toBeNull()
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(input, 'Example Room')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    expect(renameChat).toHaveBeenCalledWith('chat-1', 'Example Room')
  })

  it('still opens the chat on a single click', async () => {
    await render()
    await act(async () => { label()!.click() })
    expect(selectChat).toHaveBeenCalledWith('chat-1')
  })
})
