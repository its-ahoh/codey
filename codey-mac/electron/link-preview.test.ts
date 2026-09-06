import { describe, it, expect } from 'vitest'
import { isSafePreviewUrl, parseLinkPreview } from './link-preview'

describe('parseLinkPreview', () => {
  it('prefers Open Graph tags', () => {
    const html = `
      <html><head>
        <title>Fallback title</title>
        <meta property="og:title" content="OG title">
        <meta property="og:description" content="OG blurb">
        <meta property="og:image" content="/img/hero.png">
        <meta property="og:site_name" content="Example">
      </head></html>`
    expect(parseLinkPreview(html, 'https://example.com/post')).toEqual({
      url: 'https://example.com/post',
      title: 'OG title',
      description: 'OG blurb',
      image: 'https://example.com/img/hero.png',
      siteName: 'Example',
    })
  })

  it('falls back to twitter tags, then plain html', () => {
    const html = `
      <head>
        <title>Plain &amp; title</title>
        <meta name="description" content="Plain blurb">
        <meta name="twitter:image" content="https://cdn.example.com/t.jpg">
      </head>`
    const preview = parseLinkPreview(html, 'https://www.example.com/x')
    expect(preview.title).toBe('Plain & title')
    expect(preview.description).toBe('Plain blurb')
    expect(preview.image).toBe('https://cdn.example.com/t.jpg')
    expect(preview.siteName).toBe('example.com')
  })

  it('uses a favicon link when no social image exists', () => {
    const html = `<head><link rel="apple-touch-icon" href="/icon.png"><title>T</title></head>`
    expect(parseLinkPreview(html, 'https://example.com/').image).toBe('https://example.com/icon.png')
  })

  it('handles single-quoted and unquoted attributes', () => {
    const html = `<head><meta property='og:title' content=Hello></head>`
    expect(parseLinkPreview(html, 'https://example.com/').title).toBe('Hello')
  })

  it('drops a non-http image scheme', () => {
    const html = `<head><meta property="og:image" content="data:image/png;base64,AAAA"></head>`
    expect(parseLinkPreview(html, 'https://example.com/').image).toBeUndefined()
  })

  it('collapses whitespace and truncates a long description', () => {
    const html = `<head><meta name="description" content="${'x'.repeat(400)}"></head>`
    const desc = parseLinkPreview(html, 'https://example.com/').description!
    expect(desc).toHaveLength(220)
    expect(desc.endsWith('…')).toBe(true)
  })

  it('survives a page with no metadata at all', () => {
    const preview = parseLinkPreview('<html><body>hi</body></html>', 'https://example.com/a')
    expect(preview.title).toBeUndefined()
    expect(preview.siteName).toBe('example.com')
  })
})

describe('isSafePreviewUrl', () => {
  it('rejects local and private literal addresses', async () => {
    await expect(isSafePreviewUrl('http://localhost:3000')).resolves.toBe(false)
    await expect(isSafePreviewUrl('http://127.0.0.1/admin')).resolves.toBe(false)
    await expect(isSafePreviewUrl('http://169.254.169.254/latest/meta-data')).resolves.toBe(false)
    await expect(isSafePreviewUrl('http://[::1]/')).resolves.toBe(false)
    await expect(isSafePreviewUrl('http://[::ffff:127.0.0.1]/')).resolves.toBe(false)
  })

  it('rejects non-http protocols', async () => {
    await expect(isSafePreviewUrl('file:///etc/passwd')).resolves.toBe(false)
  })
})
