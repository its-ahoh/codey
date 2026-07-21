import { describe, expect, it } from 'vitest'
import { PLUGINS, isKnownPlugin, listPlugins } from './plugins'

describe('plugin registry', () => {
  it('registers exactly the browser plugin', () => {
    expect(PLUGINS.map(p => p.id)).toEqual(['browser'])
    expect(PLUGINS[0].name).toBe('Browser')
    expect(PLUGINS[0].description.length).toBeGreaterThan(10)
  })

  it('merges enabled state from config', () => {
    expect(listPlugins({ plugins: { browser: { enabled: true } } })[0].enabled).toBe(true)
    expect(listPlugins({ plugins: { browser: { enabled: false } } })[0].enabled).toBe(false)
    expect(listPlugins({})[0].enabled).toBe(false)
    expect(listPlugins(undefined)[0].enabled).toBe(false)
  })

  it('isKnownPlugin accepts registry ids and rejects others', () => {
    expect(isKnownPlugin('browser')).toBe(true)
    expect(isKnownPlugin('nope')).toBe(false)
    expect(isKnownPlugin('')).toBe(false)
  })
})
