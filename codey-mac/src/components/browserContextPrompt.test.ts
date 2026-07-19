import { describe, expect, it } from 'vitest'
import { buildBrowserContextPrompt } from './browserContextPrompt'

describe('buildBrowserContextPrompt', () => {
  it('includes page identity, visible text, and navigation performance', () => {
    const prompt = buildBrowserContextPrompt({
      url: 'https://example.com/',
      title: 'Example',
      description: 'A test page',
      text: 'Visible content',
      performance: { domContentLoadedMs: 120, loadMs: 250, transferBytes: 4096 },
    })
    expect(prompt).toContain('URL: https://example.com/')
    expect(prompt).toContain('DOM content loaded: 120ms')
    expect(prompt).toContain('Transferred: 4096 bytes')
    expect(prompt).toContain('Visible content')
  })

  it('renders unavailable metrics explicitly', () => {
    const prompt = buildBrowserContextPrompt({
      url: 'https://example.com/', title: '', description: '', text: '',
      performance: { domContentLoadedMs: null, loadMs: null, transferBytes: null },
    })
    expect(prompt).toContain('DOM content loaded: unavailable')
    expect(prompt).toContain('(No visible text was available.)')
  })
})
