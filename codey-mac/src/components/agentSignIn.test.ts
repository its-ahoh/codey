import { describe, expect, it } from 'vitest'
import { cardView, retryPlan, signInReducer, type SignInState } from './agentSignIn'

const idle: SignInState = {}

describe('signInReducer', () => {
  it('tracks one agent through a login', () => {
    let s = signInReducer(idle, { agent: 'codex', phase: 'starting', command: 'codex login' })
    expect(s.codex.phase).toBe('starting')
    s = signInReducer(s, { agent: 'codex', phase: 'waiting', command: 'codex login', url: 'https://x' })
    expect(s.codex.url).toBe('https://x')
    s = signInReducer(s, { agent: 'codex', phase: 'succeeded', command: 'codex login' })
    expect(s.codex.phase).toBe('succeeded')
  })
  it('keeps agents apart', () => {
    const s = signInReducer({ codex: { agent: 'codex', phase: 'waiting', command: 'codex login' } }, { agent: 'claude-code', phase: 'failed', command: 'claude auth login', output: 'no' })
    expect(s.codex.phase).toBe('waiting')
    expect(s['claude-code'].phase).toBe('failed')
  })
  it('a cancelled login goes back to idle', () => {
    const s = signInReducer({ codex: { agent: 'codex', phase: 'waiting', command: 'codex login' } }, { agent: 'codex', phase: 'cancelled', command: 'codex login' })
    expect(s.codex).toBeUndefined()
  })
})

describe('cardView', () => {
  it('ignores a result that ended before this failure', () => {
    const done = signInReducer(idle, { agent: 'codex', phase: 'succeeded', command: 'codex login' }, 1_000).codex
    expect(done.endedAt).toBe(1_000)
    expect(cardView(done, 2_000)).toBe('idle')
    expect(cardView(done, 500)).toBe('succeeded')
    const failed = signInReducer(idle, { agent: 'codex', phase: 'failed', command: 'codex login' }, 1_000).codex
    expect(cardView(failed, 2_000)).toBe('idle')
  })
  it('still shows a login that is running, whenever it started', () => {
    const running = signInReducer(idle, { agent: 'codex', phase: 'waiting', command: 'codex login' }, 1_000).codex
    expect(cardView(running, 2_000)).toBe('running')
  })
  it('is idle with no login in progress', () => {
    expect(cardView(undefined)).toBe('idle')
  })
  it('is running while starting or waiting', () => {
    expect(cardView({ agent: 'codex', phase: 'starting', command: '' })).toBe('running')
    expect(cardView({ agent: 'codex', phase: 'waiting', command: '' })).toBe('running')
  })
  it('passes succeeded and failed through', () => {
    expect(cardView({ agent: 'codex', phase: 'succeeded', command: '' })).toBe('succeeded')
    expect(cardView({ agent: 'codex', phase: 'failed', command: '' })).toBe('failed')
  })
})

describe('retryPlan', () => {
  const user = (id: string, content = 'do it') => ({ id, role: 'user' as const, content, timestamp: 1 })
  const failed = (id: string) => ({ id, role: 'assistant' as const, content: 'x', timestamp: 2, failed: true, authRequired: { agent: 'codex' as const } })

  it('re-sends the user message right before the failed one', () => {
    const messages = [user('u1', 'first'), failed('a1')]
    expect(retryPlan(messages, 'a1', { busy: false })).toEqual({ kind: 'auto', userMessageId: 'u1' })
  })
  it('asks the user instead when they have sent something since', () => {
    const messages = [user('u1'), failed('a1'), user('u2')]
    expect(retryPlan(messages, 'a1', { busy: false })).toEqual({ kind: 'manual', userMessageId: 'u1' })
  })
  it('asks the user instead when the chat is busy', () => {
    expect(retryPlan([user('u1'), failed('a1')], 'a1', { busy: true })).toEqual({ kind: 'manual', userMessageId: 'u1' })
  })
  it('finds the user message behind a team of bot messages', () => {
    const bot = { id: 'b1', role: 'assistant' as const, content: '', timestamp: 2, bot: 'a', teamTurnId: 't' }
    expect(retryPlan([user('u1'), bot, { ...failed('a1'), bot: 'b', teamTurnId: 't' }], 'a1', { busy: false })).toEqual({ kind: 'auto', userMessageId: 'u1' })
  })
  it('has nothing to do when there is no user message to re-send', () => {
    expect(retryPlan([failed('a1')], 'a1', { busy: false })).toEqual({ kind: 'none' })
  })
})
