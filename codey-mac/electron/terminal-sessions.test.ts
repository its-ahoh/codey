import * as os from 'os'
import { describe, expect, it, vi } from 'vitest'
import { TerminalSessionManager, TERMINAL_REPLAY_LIMIT } from './terminal-sessions'
import { fakeSpawn } from './terminal-pty.fixture'

const events = () => ({ data: vi.fn(), exit: vi.fn() })

describe('TerminalSessionManager', () => {
  it('opens a login shell in the folder and forwards output to the panel', async () => {
    const spawn = vi.fn(fakeSpawn(undefined, '').spawn)
    const ev = events()
    const manager = new TerminalSessionManager(spawn, ev, () => '/bin/zsh', () => ({ PATH: '/bin' }))
    const opened = await manager.open('chat-1', os.tmpdir(), 80, 24, 'sid')
    expect(spawn).toHaveBeenCalledWith('/bin/zsh', ['-l'], expect.objectContaining({
      cwd: os.tmpdir(), env: expect.objectContaining({ PATH: '/bin', TERM: 'xterm-256color' }),
    }))
    const session = manager.get(opened.sessionId)!
    ;(session.process as any).emit('hello')
    expect(ev.data).toHaveBeenCalledWith({ sessionId: 'sid', chatId: 'chat-1', data: 'hello' })
    expect(session.output).toBe('hello')
    expect(session.agent).toBe(false)
  })

  it('remembers who opened a session', async () => {
    const manager = new TerminalSessionManager(fakeSpawn(undefined, '').spawn, events())
    const opened = await manager.open('chat-1', os.tmpdir(), 80, 24, undefined, { agent: true })
    expect(manager.get(opened.sessionId)?.agent).toBe(true)
    expect(manager.list('chat-1').map(s => s.id)).toEqual([opened.sessionId])
    expect(manager.list('other')).toEqual([])
  })

  it('returns output after an offset, and says when the start was dropped', async () => {
    const manager = new TerminalSessionManager(fakeSpawn(undefined, '').spawn, events())
    const { sessionId } = await manager.open('chat-1', os.tmpdir(), 80, 24)
    const session = manager.get(sessionId)!
    const pty = session.process as any
    pty.emit('abc')
    const offset = session.written
    pty.emit('def')
    expect(manager.outputSince(session, offset)).toEqual({ text: 'def', lost: false })
    pty.emit('x'.repeat(TERMINAL_REPLAY_LIMIT))
    expect(manager.outputSince(session, offset).lost).toBe(true)
  })

  it('rejects writes to a closed session and kills it on close', async () => {
    const manager = new TerminalSessionManager(fakeSpawn(undefined, '').spawn, events())
    const { sessionId } = await manager.open('chat-1', os.tmpdir(), 80, 24)
    const pty = manager.get(sessionId)!.process as any
    const onExit = vi.fn()
    manager.onExit(onExit)
    manager.close(sessionId)
    expect(pty.killed).toBe(true)
    expect(onExit).toHaveBeenCalledTimes(1)
    expect(() => manager.write(sessionId, 'ls\r')).toThrow('not running')
  })

  it('refuses a folder that does not exist', async () => {
    const manager = new TerminalSessionManager(fakeSpawn().spawn, events())
    await expect(manager.open('chat-1', '/definitely/not/here', 80, 24)).rejects.toThrow()
  })
})
