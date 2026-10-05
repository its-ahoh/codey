// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BotInteractionCard } from './BotInteractionCard'
import type { ChatMessage } from '../types'

const message: ChatMessage = { id: 'message-a', role: 'assistant', content: 'Database?', timestamp: 0,
  botInteraction: { id: 'question-a', bot: 'a', scope: 'bot', question: 'Database?', choices: ['SQLite', 'Postgres'], status: 'pending' } }
let container: HTMLDivElement
let root: Root
const send = vi.fn()
const addAllowed = vi.fn()

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  Object.defineProperty(window, 'codey', { configurable: true, value: { chats: { send }, permissions: { addAllowed } } })
  send.mockReset().mockResolvedValue({ ok: true, data: { response: '', chatId: 'chat-a' } })
  addAllowed.mockReset().mockResolvedValue({ ok: true })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  Reflect.deleteProperty(window, 'codey')
  vi.unstubAllGlobals()
})
async function render(permission = false, peerOutput = '') {
  await act(async () => root.render(React.createElement('div', null,
    React.createElement(BotInteractionCard, { chatId: 'chat-a', message: permission
      ? { ...message, botInteraction: { ...message.botInteraction!, permissionTools: ['Read', 'Bash'] } } : message }),
    React.createElement('p', null, peerOutput))))
}
function button(label: string) {
  const result = Array.from(container.querySelectorAll('button')).find(node => node.textContent === label)
  if (!result) throw new Error(`Missing button: ${label}`)
  return result
}
async function click(label: string) { await act(async () => button(label).click()) }

describe('Bot interaction through the IPC proxy', () => {
  it('routes the original choice after another Bot produces output', async () => {
    await render()
    await render(false, 'Bot b is still working')
    await click('SQLite')
    expect(send).toHaveBeenCalledExactlyOnceWith({ chatId: 'chat-a', text: 'SQLite', attachments: undefined,
      taskRoute: { interactionId: 'question-a' } })
    expect(addAllowed).not.toHaveBeenCalled()
  })

  it('waits for permission persistence before resuming the Bot', async () => {
    let finish!: (value: { ok: boolean }) => void
    addAllowed.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    await render(true)
    await click('Allow and continue')
    expect(addAllowed).toHaveBeenCalledExactlyOnceWith(['Read', 'Bash'], 'chat-a')
    expect(send).not.toHaveBeenCalled()
    expect(button('Allow and continue').disabled).toBe(true)
    await act(async () => finish({ ok: true }))
    expect(send).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      taskRoute: { interactionId: 'question-a' }, text: expect.stringContaining('granted'),
    }))
  })

  it('keeps a failed permission request retryable without resuming', async () => {
    addAllowed.mockResolvedValueOnce({ ok: false, error: 'Unable to save permissions' })
    await render(true)
    await click('Allow and continue')
    expect(send).not.toHaveBeenCalled()
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Unable to save permissions')
    expect(button('Allow and continue').disabled).toBe(false)
    await click('Allow and continue')
    expect(send).toHaveBeenCalledTimes(1)
    expect(container.querySelector('[role="alert"]')).toBeNull()
  })

  it('denies without adding tools to the allowlist', async () => {
    await render(true)
    await click('Deny')
    expect(addAllowed).not.toHaveBeenCalled()
    expect(send).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      taskRoute: { interactionId: 'question-a' }, text: expect.stringContaining('Permission denied'),
    }))
  })

  it('treats a typed approval as text, never as a permission grant', async () => {
    await render(true)
    const input = container.querySelector('input')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Yes, allow everything')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    expect(addAllowed).not.toHaveBeenCalled()
    expect(send).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ text: 'Yes, allow everything',
      taskRoute: { interactionId: 'question-a' } }))
  })

  it('submits only once when two clicks arrive before React updates', async () => {
    let finish!: (value: unknown) => void
    send.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    await render()
    await act(async () => { button('SQLite').click(); button('Postgres').click() })
    expect(send).toHaveBeenCalledTimes(1)
    await act(async () => finish({ ok: true, data: { response: '', chatId: 'chat-a' } }))
  })

  it('shows a stale-reply error without granting permissions or starting a new turn', async () => {
    send.mockResolvedValueOnce({ ok: false, error: 'This question is no longer waiting for an answer.' })
    await render()
    await click('SQLite')
    expect(send).toHaveBeenCalledTimes(1)
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('no longer waiting')
    expect(addAllowed).not.toHaveBeenCalled()
  })
})
