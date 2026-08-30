import { describe, it, expect } from 'vitest'
import { fileExtension, previewKind } from './attachmentKind'

describe('fileExtension', () => {
  it('reads the last extension', () => {
    expect(fileExtension('notes.tar.gz')).toBe('gz')
  })

  it('ignores directories and dotfiles without an extension', () => {
    expect(fileExtension('/a/b.c/README')).toBe('')
    expect(fileExtension('.gitignore')).toBe('')
    expect(fileExtension('trailing.')).toBe('')
  })
})

describe('previewKind', () => {
  it('shows images as images', () => {
    expect(previewKind({ name: 'shot.png', mimeType: 'image/png' })).toBe('image')
  })

  it('shows pdfs as pdfs, even with a useless mime type', () => {
    expect(previewKind({ name: 'a.pdf', mimeType: 'application/pdf' })).toBe('pdf')
    expect(previewKind({ name: 'a.pdf', mimeType: 'application/octet-stream' })).toBe('pdf')
  })

  it('falls back to the extension when the mime type says nothing', () => {
    expect(previewKind({ name: 'notes.md', mimeType: 'application/octet-stream' })).toBe('text')
    expect(previewKind({ name: 'main.ts', mimeType: '' })).toBe('text')
  })

  it('reads svg as text so the markup is inspectable', () => {
    expect(previewKind({ name: 'logo.svg', mimeType: 'image/svg+xml' })).toBe('text')
  })

  it('treats unknown binaries as unpreviewable', () => {
    expect(previewKind({ name: 'archive.zip', mimeType: 'application/zip' })).toBe('other')
  })
})
