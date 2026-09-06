import { describe, it, expect } from 'vitest'
import { extractPreviewUrls } from './linkPreviewUrls'

describe('extractPreviewUrls', () => {
  it('finds a bare url', () => {
    expect(extractPreviewUrls('see https://example.com/page for details'))
      .toEqual(['https://example.com/page'])
  })

  it('drops sentence punctuation stuck to the end', () => {
    expect(extractPreviewUrls('read https://example.com/a.'))
      .toEqual(['https://example.com/a'])
  })

  it('unwraps a markdown link target', () => {
    expect(extractPreviewUrls('[docs](https://example.com/docs)'))
      .toEqual(['https://example.com/docs'])
  })

  it('dedupes repeats', () => {
    expect(extractPreviewUrls('https://a.com/x and again https://a.com/x'))
      .toEqual(['https://a.com/x'])
  })

  it('ignores urls inside code fences and inline code', () => {
    expect(extractPreviewUrls('```\nhttps://a.com\n```\nand `https://b.com`')).toEqual([])
  })

  it('ignores localhost and private hosts', () => {
    expect(extractPreviewUrls('http://localhost:3000 http://192.168.1.4/x http://10.0.0.2')).toEqual([])
  })

  it('ignores direct image and file links', () => {
    expect(extractPreviewUrls('https://a.com/pic.png https://a.com/app.dmg')).toEqual([])
  })

  it('caps the number of cards', () => {
    const text = 'https://a.com https://b.com https://c.com https://d.com'
    expect(extractPreviewUrls(text)).toHaveLength(3)
  })

  it('returns nothing for empty text', () => {
    expect(extractPreviewUrls('')).toEqual([])
  })
})
