import { describe, expect, it } from 'vitest'
import { hasAgentUpdate } from './agentUpdates'

describe('hasAgentUpdate', () => {
  it('is true when any agent has a newer version published', () => {
    expect(hasAgentUpdate({
      'claude-code': { updateAvailable: false, unknown: false },
      'pi': { current: '0.84.2', latest: '0.84.3', updateAvailable: true, unknown: false },
    })).toBe(true)
  })

  it('is false when every agent is current', () => {
    expect(hasAgentUpdate({
      'claude-code': { updateAvailable: false, unknown: false },
      'pi': { updateAvailable: false, unknown: false },
    })).toBe(false)
  })

  // A dot says "there is something here". A lookup that failed is not
  // something, and a dot the user opens to find nothing is a lie.
  it('is false when the check could not complete', () => {
    expect(hasAgentUpdate({ 'pi': { updateAvailable: false, unknown: true } })).toBe(false)
  })

  it('is false before the first check answers', () => {
    expect(hasAgentUpdate(null)).toBe(false)
  })
})
