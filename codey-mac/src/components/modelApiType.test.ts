import { describe, it, expect } from 'vitest'
import { AGENT_API_TYPE, modelFitsAgent, modelFitsApiType } from './modelApiType'

describe('modelFitsApiType', () => {
  it('matches like-for-like protocols', () => {
    expect(modelFitsApiType('anthropic', 'anthropic')).toBe(true)
    expect(modelFitsApiType('openai', 'openai')).toBe(true)
  })

  it('rejects a cross-protocol pairing', () => {
    expect(modelFitsApiType('anthropic', 'openai')).toBe(false)
    expect(modelFitsApiType('openai', 'anthropic')).toBe(false)
  })

  it('lets an "all" model serve either protocol', () => {
    expect(modelFitsApiType('all', 'anthropic')).toBe(true)
    expect(modelFitsApiType('all', 'openai')).toBe(true)
  })

  it('accepts anything when the agent declares no protocol', () => {
    expect(modelFitsApiType('openai', undefined)).toBe(true)
    expect(modelFitsApiType('all', undefined)).toBe(true)
  })
})

describe('modelFitsAgent', () => {
  it('routes each known agent to its protocol', () => {
    expect(modelFitsAgent('anthropic', 'claude-code')).toBe(true)
    expect(modelFitsAgent('anthropic', 'codex')).toBe(false)
    expect(modelFitsAgent('openai', 'opencode')).toBe(true)
    expect(modelFitsAgent('openai', 'pi')).toBe(false)
  })

  it('makes an "all" model available to every known agent', () => {
    for (const agent of Object.keys(AGENT_API_TYPE)) {
      expect(modelFitsAgent('all', agent)).toBe(true)
    }
  })

  it('accepts an unknown agent name', () => {
    expect(modelFitsAgent('openai', 'some-future-agent')).toBe(true)
  })
})
