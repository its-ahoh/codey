import type { MemoryEntry, MemoryStore, MemoryType } from '@codey/core'

/**
 * Codey's own memory — the structured entries it injects into prompts,
 * distinct from the agent-owned instruction files in `./memory.ts`.
 *
 * Entries live in `index.json` under a store root; the `memory.md` beside it
 * is a rendered view the store rewrites on every change. The Workspaces tab
 * used to edit that rendered file, so anything typed there was silently
 * overwritten by the next entry. These helpers back the UI with the entries
 * themselves instead.
 */

export type MemoryStoreScope = 'workspace' | 'global'

/** What the renderer needs to show and manage one entry. */
export interface CodeyMemoryItem {
  id: string
  type: MemoryType
  content: string
  label: string
  createdAt: number
  updatedAt: number
  accessCount: number
  tags: string[]
  source: string
}

export const MEMORY_TYPES: MemoryType[] = ['fact', 'preference', 'lesson', 'decision', 'context']

/** Longest content the UI may submit — entries are notes, not documents. */
export const MAX_ENTRY_CHARS = 4000

export function isMemoryType(value: unknown): value is MemoryType {
  return typeof value === 'string' && (MEMORY_TYPES as string[]).includes(value)
}

export function toMemoryItem(entry: MemoryEntry): CodeyMemoryItem {
  return {
    id: entry.id,
    type: entry.type,
    content: entry.content,
    label: entry.label,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    accessCount: entry.accessCount,
    tags: entry.tags,
    source: entry.source,
  }
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

/** All entries in a store, newest first. */
export function listStore(store: MemoryStore): CodeyMemoryItem[] {
  return sortItems(store.getAll().map(toMemoryItem))
}
