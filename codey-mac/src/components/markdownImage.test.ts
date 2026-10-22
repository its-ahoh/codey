import { describe, expect, it } from 'vitest'
import { markdownImageSource } from './markdownImage'

describe('markdownImageSource', () => {
  it('serves Codey uploads through codey-asset', () => {
    expect(markdownImageSource('/w/.codey/uploads/outputs/1-a b.png'))
      .toEqual({ kind: 'asset', url: `codey-asset://file/${encodeURIComponent('/w/.codey/uploads/outputs/1-a b.png')}` })
  })

  it('does not auto-load remote images', () => {
    expect(markdownImageSource('https://e.com/x.png')).toEqual({ kind: 'remote', url: 'https://e.com/x.png' })
  })

  it('rejects other paths', () => {
    expect(markdownImageSource('/etc/x.png')).toEqual({ kind: 'none' })
    expect(markdownImageSource(undefined)).toEqual({ kind: 'none' })
  })
})
