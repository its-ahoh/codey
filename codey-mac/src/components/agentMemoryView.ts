import type { MemoryEntry } from '../codey-api'

/** Compact size label for a memory file. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * One-line summary of what an agent currently remembers. A view usually shows
 * one scope at a time, so the scope split is only spelled out when both are
 * present.
 */
export function summarizeMemory(entries: MemoryEntry[]): string {
  if (entries.length === 0) return 'No memory files yet'
  const total = entries.reduce((sum, e) => sum + e.bytes, 0)
  const user = entries.filter(e => e.scope === 'user').length
  const project = entries.length - user
  const count = `${entries.length} file${entries.length === 1 ? '' : 's'}`
  const split = user && project ? ` · ${user} user + ${project} project` : ''
  return `${count}${split} · ${formatBytes(total)}`
}

/** First non-empty, non-frontmatter line — what the file is about, at a glance. */
export function memoryPreview(content: string, max = 120): string {
  const body = content.replace(/^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n?/, '')
  const line = body.split('\n').map(l => l.trim()).find(l => l.length > 0) ?? ''
  const clean = line.replace(/^#+\s*/, '').replace(/^[-*]\s*/, '')
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean
}
