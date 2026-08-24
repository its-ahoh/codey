import { describe, it, expect, beforeEach } from 'vitest'
import {
  isBottomTerminalOpen,
  setBottomTerminalOpen,
  __resetBottomTerminalVisibility,
} from './terminalVisibility'

describe('bottom terminal visibility', () => {
  beforeEach(() => { __resetBottomTerminalVisibility() })

  it('defaults to closed', () => {
    expect(isBottomTerminalOpen('chat-1')).toBe(false)
  })

  it('remembers an open terminal across a chat switch and back', () => {
    setBottomTerminalOpen('chat-1', true)
    // Switching to another chat must not surface chat-1's terminal there...
    expect(isBottomTerminalOpen('chat-2')).toBe(false)
    // ...and switching back must still show it.
    expect(isBottomTerminalOpen('chat-1')).toBe(true)
  })

  it('forgets a closed terminal', () => {
    setBottomTerminalOpen('chat-1', true)
    setBottomTerminalOpen('chat-1', false)
    expect(isBottomTerminalOpen('chat-1')).toBe(false)
  })
})
