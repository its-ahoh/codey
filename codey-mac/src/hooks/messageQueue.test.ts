import { describe, it, expect } from 'vitest'
import { readyDeliveries } from './messageQueue'

const msg = (id: string, text: string) => ({ id, text })

describe('readyDeliveries', () => {
  it('releases only the head of an idle chat', () => {
    const ready = readyDeliveries({ c1: [msg('q1', 'one'), msg('q2', 'two')] }, {}, new Set())
    expect(ready).toEqual([{ chatId: 'c1', message: msg('q1', 'one') }])
  })

  it('holds a chat whose turn is still running', () => {
    expect(readyDeliveries({ c1: [msg('q1', 'one')] }, { c1: {} }, new Set())).toEqual([])
  })

  it('holds a chat already mid-delivery so the head cannot fire twice', () => {
    expect(readyDeliveries({ c1: [msg('q1', 'one')] }, {}, new Set(['c1']))).toEqual([])
  })

  it('drains independent chats in the same pass', () => {
    const ready = readyDeliveries(
      { c1: [msg('q1', 'one')], c2: [msg('q2', 'two')] },
      { c1: {} },
      new Set(),
    )
    expect(ready).toEqual([{ chatId: 'c2', message: msg('q2', 'two') }])
  })
})
