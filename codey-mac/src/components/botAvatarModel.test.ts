import { describe, expect, it } from 'vitest'
import { avatarColors, resolveBotAvatar, botAvatarState } from './botAvatarModel'
import type { ChatMessage } from '../types'
const m = (botStatus?: ChatMessage['botStatus']): ChatMessage => ({ id: 'a', role: 'assistant', content: '', timestamp: 0, botStatus })
describe('bot avatar identity and state', () => {
  it('keeps existing members stable and rejects colors outside the palette', () => {
    expect(resolveBotAvatar('Alice')).toEqual(resolveBotAvatar('alice'))
    expect(avatarColors).toContain(resolveBotAvatar('a', { color: 'red' }).color)
    expect(resolveBotAvatar('a', { shape: 'triangle', color: '#8CCDB5' })).toEqual({ shape: 'triangle', color: '#8CCDB5' })
  })
  it('distinguishes waiting, input requests, inactive, and interrupted runs', () => {
    expect(botAvatarState(m('pending'), true)).toBe('waiting')
    expect(botAvatarState(m('pending'), false)).toBe('idle')
    expect(botAvatarState(m('askedUser'), false)).toBe('reply')
    expect(botAvatarState(m('running'), true)).toBe('working')
    expect(botAvatarState(m('running'), false)).toBe('stopped')
    expect(botAvatarState(m('failed'), false)).toBe('failed')
    expect(botAvatarState(m('done'), false)).toBe('done')
    expect(botAvatarState({ ...m(), isComplete: false }, false)).toBe('stopped')
  })
})
