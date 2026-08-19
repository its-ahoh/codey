import { describe, expect, it } from 'vitest'
import { PLUGINS, isKnownPlugin, listPlugins } from './plugins'

describe('plugin registry', () => {
  it('registers exactly the browser plugin', () => {
    expect(PLUGINS.map(p => p.id)).toEqual(['browser'])
    expect(PLUGINS[0].name).toBe('Browser')
    expect(PLUGINS[0].description.length).toBeGreaterThan(10)
  })

  it('reports the state the skill is actually in on disk', () => {
    expect(listPlugins(() => ({ state: 'installed', updateAvailable: false }))[0].state).toBe('installed')
    expect(listPlugins(() => ({ state: 'disabled', updateAvailable: false }))[0].state).toBe('disabled')
    expect(listPlugins(() => ({ state: 'absent', updateAvailable: false }))[0].state).toBe('absent')
  })

  it('passes an available update through, so the card can offer it', () => {
    expect(listPlugins(() => ({ state: 'installed', updateAvailable: true }))[0].updateAvailable).toBe(true)
  })

  it('asks about each registered plugin by id', () => {
    const asked: string[] = []
    listPlugins(id => { asked.push(id); return { state: 'absent', updateAvailable: false } })
    expect(asked).toEqual(['browser'])
  })

  it('isKnownPlugin accepts registry ids and rejects others', () => {
    expect(isKnownPlugin('browser')).toBe(true)
    expect(isKnownPlugin('nope')).toBe(false)
    expect(isKnownPlugin('')).toBe(false)
  })
})
