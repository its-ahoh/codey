import { describe, expect, it } from 'vitest'
import type { BrowserSkillStatus } from '@codey/core'
import { PLUGINS, isKnownPlugin, listPlugins } from './plugins'

const status = (over: Partial<BrowserSkillStatus> = {}): BrowserSkillStatus => ({
  state: 'absent',
  dir: '/Users/test/.codey/skills/browser',
  sourceUrl: 'https://github.com/its-ahoh/codey-skills',
  ...over,
})

describe('plugin registry', () => {
  it('registers exactly the browser plugin', () => {
    expect(PLUGINS.map(p => p.id)).toEqual(['browser'])
    expect(PLUGINS[0].name).toBe('Browser')
    expect(PLUGINS[0].description.length).toBeGreaterThan(10)
  })

  it('reports the state the skill is actually in on disk', () => {
    for (const state of ['installed', 'disabled', 'absent'] as const) {
      expect(listPlugins(() => status({ state }))[0].state).toBe(state)
    }
  })

  it('carries where the copy lives, where it came from, who wrote it, and which version', () => {
    const plugin = listPlugins(() => status({ state: 'installed', origin: 'user', version: '1.2.3' }))[0]
    expect(plugin.version).toBe('1.2.3')
    expect(plugin.dir).toBe('/Users/test/.codey/skills/browser')
    expect(plugin.sourceUrl).toBe('https://github.com/its-ahoh/codey-skills')
    expect(plugin.origin).toBe('user')
  })

  it('asks about each registered plugin by id', () => {
    const asked: string[] = []
    listPlugins(id => { asked.push(id); return status() })
    expect(asked).toEqual(['browser'])
  })

  it('isKnownPlugin accepts registry ids and rejects others', () => {
    expect(isKnownPlugin('browser')).toBe(true)
    expect(isKnownPlugin('nope')).toBe(false)
    expect(isKnownPlugin('')).toBe(false)
  })
})
