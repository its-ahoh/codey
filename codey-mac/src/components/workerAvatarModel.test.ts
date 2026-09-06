import { describe, expect, it } from 'vitest'
import { avatarColors, resolveWorkerAvatar, workerAvatarState } from './workerAvatarModel'
import type { ChatMessage } from '../types'
const m = (workerStatus?: ChatMessage['workerStatus']): ChatMessage => ({ id: 'a', role: 'assistant', content: '', timestamp: 0, workerStatus })
describe('worker avatar identity and state', () => {
  it('keeps existing members stable and rejects colors outside the palette', () => {
    expect(resolveWorkerAvatar('Alice')).toEqual(resolveWorkerAvatar('alice'))
    expect(avatarColors).toContain(resolveWorkerAvatar('a', { color: 'red' }).color)
    expect(resolveWorkerAvatar('a', { shape: 'triangle', color: '#8CCDB5' })).toEqual({ shape: 'triangle', color: '#8CCDB5' })
  })
  it('distinguishes waiting, input requests, inactive, and interrupted runs', () => {
    expect(workerAvatarState(m('pending'), true)).toBe('waiting')
    expect(workerAvatarState(m('pending'), false)).toBe('idle')
    expect(workerAvatarState(m('askedUser'), false)).toBe('reply')
    expect(workerAvatarState(m('running'), true)).toBe('working')
    expect(workerAvatarState(m('running'), false)).toBe('stopped')
    expect(workerAvatarState(m('failed'), false)).toBe('failed')
    expect(workerAvatarState(m('done'), false)).toBe('done')
    expect(workerAvatarState({ ...m(), isComplete: false }, false)).toBe('stopped')
  })
})
