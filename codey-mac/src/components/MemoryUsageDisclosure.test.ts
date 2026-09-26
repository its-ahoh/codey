import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { MemoryUsageDisclosure } from './MemoryUsageDisclosure'

describe('memory disclosure', () => {
  it('shows archived snapshots without obsolete mutation controls or unescaped HTML', () => {
    const html = renderToStaticMarkup(React.createElement(MemoryUsageDisclosure, { entries: [{
      id: 'one', version: 1, content: '<script>old preference</script>', source: 'Remember this', audience: 'private', botName: 'alice', projectName: 'App',
    }] }))
    expect(html).toContain('Memory included')
    expect(html).toContain('alice')
    expect(html).toContain('Archived Bot memory')
    expect(html).not.toContain('<button')
    expect(html).not.toContain('<script>')
    expect(renderToStaticMarkup(React.createElement(MemoryUsageDisclosure, { entries: [] }))).toBe('')
  })
})
