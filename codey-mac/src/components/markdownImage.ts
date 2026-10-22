export type MarkdownImageSource =
  | { kind: 'asset'; url: string }
  | { kind: 'remote'; url: string }
  | { kind: 'none' }

/** Only Codey's own upload snapshots load inline; remote images could track reads. */
export const markdownImageSource = (src: string | undefined): MarkdownImageSource => {
  if (!src) return { kind: 'none' }
  if (/^https?:\/\//i.test(src)) return { kind: 'remote', url: src }
  if (src.startsWith('/') && src.includes('/.codey/uploads/')) {
    return { kind: 'asset', url: `codey-asset://file/${encodeURIComponent(src)}` }
  }
  return { kind: 'none' }
}
