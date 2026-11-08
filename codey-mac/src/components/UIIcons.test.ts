import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { UIIcon } from './UIIcons'

const markup = (name: 'panel' | 'panel-left', filled = false) =>
  renderToStaticMarkup(React.createElement(UIIcon, { name, filled }))

describe('panel toggle icons', () => {
  it('draws the left panel divider on the left, mirroring the right panel icon', () => {
    expect(markup('panel')).toContain('d="M15 3v18"')
    expect(markup('panel-left')).toContain('d="M9 3v18"')
    expect(markup('panel-left')).not.toContain('d="M15 3v18"')
  })

  it('fills the left strip when the left panel is open', () => {
    expect(markup('panel', true)).toContain('d="M15 3h6v18h-6z"')
    expect(markup('panel-left', true)).toContain('d="M3 3h6v18H3z"')
    expect(markup('panel-left')).not.toContain('d="M3 3h6v18H3z"')
  })
})
