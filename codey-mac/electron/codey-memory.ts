import type { CoMemoNote } from '@codey/core'

/** Display adapters for Co-memo records. */
export type MemoryType = 'note' | 'preference' | 'decision' | 'constraint' | 'lesson'

export type MemoryPanelScope = 'workspace' | 'global'

/** What the renderer needs to show and manage one entry. */
export interface CodeyMemoryItem {
  id: string
  version?: number
  type: MemoryType
  content: string
  label: string
  createdAt: number
  updatedAt: number
  accessCount: number
  tags: string[]
  source: string
}

export const MEMORY_TYPES: MemoryType[] = ['note', 'preference', 'decision', 'constraint', 'lesson']

/** Longest content the UI may submit — entries are notes, not documents. */
export const MAX_ENTRY_CHARS = 32000

export function isMemoryType(value: unknown): value is MemoryType {
  return typeof value === 'string' && (MEMORY_TYPES as string[]).includes(value)
}

/** Newest first — the order a person scans a memory list in. */
export function sortItems(items: CodeyMemoryItem[]): CodeyMemoryItem[] {
  return [...items].sort((a, b) => b.updatedAt - a.updatedAt)
}

/**
 * A label for a hand-written entry. The store needs one for its rendered
 * view, and asking the user for a title on top of the note itself is friction.
 */
export function labelFor(content: string, max = 60): string {
  const line = content.split('\n').map(l => l.trim()).find(l => l.length > 0) ?? ''
  const clean = line.replace(/^#+\s*/, '').replace(/^[-*]\s*/, '')
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean
}

/** Reject content the store should not be asked to hold. */
export function validateContent(content: unknown): string {
  if (typeof content !== 'string') throw new Error('Memory content must be text')
  const trimmed = content.trim()
  if (!trimmed) throw new Error('Memory content cannot be empty')
  if (trimmed.length > MAX_ENTRY_CHARS) {
    throw new Error(`Memory content is too long (max ${MAX_ENTRY_CHARS} characters)`)
  }
  return trimmed
}


/** Adapt the public Co-memo record to the existing memory panel. */
export function toCoMemoItem(note: CoMemoNote): CodeyMemoryItem {
  const kind = note.metadata?.kind
  return {
    id: note.id, version: note.version, content: note.content, label: labelFor(note.content),
    type: isMemoryType(kind) ? kind : 'note', createdAt: note.createdAt, updatedAt: note.updatedAt,
    accessCount: 0, tags: [note.scope], source: 'co-memo',
  }
}
