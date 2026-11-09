import { describe, it, expect } from 'vitest'
import { AGENT_API_TYPE, agentsPinnedTo, inheritedModelFor, missingAllEndpoints, modelFitsAgent, modelFitsApiType } from './modelApiType'

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

  it('lets a provider-agnostic agent take either protocol', () => {
    expect(modelFitsApiType('anthropic', 'all')).toBe(true)
    expect(modelFitsApiType('openai', 'all')).toBe(true)
    expect(modelFitsApiType('all', 'all')).toBe(true)
  })
})

describe('modelFitsAgent', () => {
  it('routes each known agent to its protocol', () => {
    expect(modelFitsAgent('anthropic', 'claude-code')).toBe(true)
    expect(modelFitsAgent('openai', 'claude-code')).toBe(false)
    expect(modelFitsAgent('openai', 'codex')).toBe(true)
    expect(modelFitsAgent('anthropic', 'codex')).toBe(false)
  })

  it('lets the provider-agnostic agents take either protocol', () => {
    for (const agent of ['opencode', 'pi']) {
      expect(modelFitsAgent('anthropic', agent)).toBe(true)
      expect(modelFitsAgent('openai', agent)).toBe(true)
    }
  })

  it('makes an "all" model available to every protocol-based agent', () => {
    // Cursor and Grok are the exceptions: each only takes its own vendor-key models.
    for (const agent of Object.keys(AGENT_API_TYPE).filter(a => a !== 'cursor' && a !== 'grok')) {
      expect(modelFitsAgent('all', agent)).toBe(true)
    }
  })

  it('accepts an unknown agent name', () => {
    expect(modelFitsAgent('openai', 'some-future-agent')).toBe(true)
  })
})

describe('missingAllEndpoints', () => {
  const both = { anthropicBaseUrl: 'https://a', openaiBaseUrl: 'https://o' }

  it('is satisfied when the key covers both protocols', () => {
    expect(missingAllEndpoints('all', both)).toEqual([])
  })

  it('names the protocol whose endpoint the key lacks', () => {
    expect(missingAllEndpoints('all', { openaiBaseUrl: 'https://o' })).toEqual(['anthropic'])
    expect(missingAllEndpoints('all', { anthropicBaseUrl: 'https://a' })).toEqual(['openai'])
  })

  it('names both when the key defines no endpoint at all', () => {
    expect(missingAllEndpoints('all', {})).toEqual(['anthropic', 'openai'])
    expect(missingAllEndpoints('all', { anthropicBaseUrl: '  ' })).toEqual(['anthropic', 'openai'])
  })

  it('says nothing about single-protocol models — a bare base URL is normal there', () => {
    expect(missingAllEndpoints('anthropic', {})).toEqual([])
    expect(missingAllEndpoints('openai', {})).toEqual([])
  })

  it('says nothing when no key is bound — that is opting into the ambient env', () => {
    expect(missingAllEndpoints('all', undefined)).toEqual([])
  })
})

describe('agentsPinnedTo', () => {
  it('lists only the agents with no other protocol to fall back on', () => {
    expect(agentsPinnedTo('anthropic')).toEqual(['claude-code'])
    expect(agentsPinnedTo('openai')).toEqual(['codex'])
  })

  it('excludes the provider-agnostic agents, which run on either protocol', () => {
    expect(agentsPinnedTo('anthropic')).not.toContain('pi')
    expect(agentsPinnedTo('openai')).not.toContain('opencode')
  })
})

describe('cursor models', () => {
  it('only fit the cursor agent, and the cursor agent only takes them', () => {
    expect(modelFitsAgent('cursor', 'cursor')).toBe(true)
    expect(modelFitsAgent('all', 'cursor')).toBe(false)
    expect(modelFitsAgent('anthropic', 'cursor')).toBe(false)
    for (const agent of ['claude-code', 'codex', 'opencode', 'pi']) {
      expect(modelFitsAgent('cursor', agent)).toBe(false)
    }
    // A picker with no agent chosen (e.g. Aide on its default) must not offer one.
    expect(modelFitsApiType('cursor', undefined)).toBe(false)
  })
})

describe('inheritedModelFor', () => {
  const models = [
    { model: 'sonnet-x', apiType: 'anthropic' as const },
    { model: 'gpt-x', apiType: 'openai' as const },
  ]

  it('prefers the model pinned in fallback.order', () => {
    expect(inheritedModelFor('codex', 'pinned-x', models)).toBe('pinned-x')
  })

  it('otherwise takes the first model the agent can run', () => {
    expect(inheritedModelFor('codex', undefined, models)).toBe('gpt-x')
  })

  it('is undefined when nothing fits, so the header says default', () => {
    expect(inheritedModelFor('cursor', undefined, models)).toBeUndefined()
  })
})
