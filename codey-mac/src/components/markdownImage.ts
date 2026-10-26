export type MarkdownImageSource =
  | { kind: 'asset'; url: string }
  | { kind: 'remote'; url: string }
  | { kind: 'none' }

/** Only Codey's own upload snapshots load inline; remote images could track reads. */
export const markdownImageSource = (src: string | undefined): MarkdownImageSource => {
  if (!src) return { kind: 'none' }
  if (/^https?:\/\//i.test(src)) return { kind: 'remote', url: src }
  // react-markdown percent-encodes URLs before they reach the img component.
  let p = src
  try { p = decodeURIComponent(src) } catch { /* keep the raw value */ }
  if (p.startsWith('/') && p.includes('/.codey/uploads/')) {
    return { kind: 'asset', url: `codey-asset://file/${encodeURIComponent(p)}` }
  }
  return { kind: 'none' }
}
