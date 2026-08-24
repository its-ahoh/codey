import { describe, expect, it } from 'vitest'
import { toggleSettingsId } from './PluginsTab'

describe('toggleSettingsId', () => {
  it('opens a plugin settings page when none is open', () => {
    expect(toggleSettingsId(null, 'browser')).toBe('browser')
  })

  it('closes the same plugin when it is already open', () => {
    expect(toggleSettingsId('browser', 'browser')).toBeNull()
  })

  it('switches to a different plugin', () => {
    expect(toggleSettingsId('mcp', 'browser')).toBe('browser')
  })
})

