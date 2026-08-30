// How a chat attachment should be shown when the user clicks it.
//
// Kept out of the component so the mime/extension guessing is testable and so
// both the composer chips and the sent-message chips classify identically.
// Some uploads arrive with a useless mime type (browsers send
// "application/octet-stream" for .md, .ts, .log ...), so the extension is the
// tie-breaker rather than the other way round.

export type PreviewKind = 'image' | 'pdf' | 'text' | 'other'

const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'log', 'csv', 'tsv', 'json', 'jsonl', 'yaml', 'yml',
  'toml', 'ini', 'cfg', 'conf', 'env', 'xml', 'svg', 'html', 'htm', 'css',
  'scss', 'less', 'js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'py', 'rb', 'go',
  'rs', 'java', 'kt', 'swift', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'php',
  'sh', 'bash', 'zsh', 'fish', 'sql', 'diff', 'patch', 'gitignore',
])

export const fileExtension = (name: string): string => {
  const base = name.split(/[\\/]/).pop() ?? ''
  const dot = base.lastIndexOf('.')
  if (dot <= 0 || dot === base.length - 1) return ''
  return base.slice(dot + 1).toLowerCase()
}

export const previewKind = (att: { name: string; mimeType: string }): PreviewKind => {
  const mime = (att.mimeType || '').toLowerCase()
  const ext = fileExtension(att.name || '')
  if (mime.startsWith('image/') && ext !== 'svg') return 'image'
  if (mime === 'application/pdf' || ext === 'pdf') return 'pdf'
  if (mime.startsWith('text/')) return 'text'
  if (mime === 'application/json' || mime === 'application/xml') return 'text'
  if (TEXT_EXTENSIONS.has(ext)) return 'text'
  if (mime.startsWith('image/')) return 'image'
  return 'other'
}
