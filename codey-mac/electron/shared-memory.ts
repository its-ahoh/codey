import type * as Fs from 'fs'
import type * as Path from 'path'
import { AGENT_MEMORY, userMemoryFiles } from './memory'

/**
 * Sharing Codey's user-global memory with the agents.
 *
 * The entries in the global store (`~/.codey/memory`) are the single source
 * of truth for "what is true about this user everywhere". Codey injects them
 * into its own prompts; with sharing on, the same entries are also rendered
 * into each agent's own global memory file so the CLIs know them when run
 * outside Codey too. There is no second place to type this text.
 *
 * The mirror is a marked block rather than a whole-file copy, because those
 * files belong to the user — anything outside the markers is never touched.
 * Symlinking is deliberately avoided: an agent's global memory is a single
 * file the user also writes to, so it cannot be replaced by a link.
 *
 * Syncing is one-way (Codey → agents). Nothing an agent writes flows back.
 */

/** Legacy home of the shared text, before the global store owned it. */
export const LEGACY_SHARED_FILE = ['.codey', 'memory', 'MEMORY.md']

export const BLOCK_BEGIN = '<!-- BEGIN CODEY SHARED MEMORY -->'
export const BLOCK_END = '<!-- END CODEY SHARED MEMORY -->'
const BLOCK_NOTE = '<!-- Managed by Codey. Edit it in Codey: Settings > Agents > Shared memory. -->'

/** Where the pre-merge shared text lived, so it can be migrated once. */
export function legacySharedFilePath(pathMod: typeof Path, home: string): string {
  return pathMod.join(home, ...LEGACY_SHARED_FILE)
}

/** One memory entry as the agents should read it. */
export interface SharedMemoryEntry {
  content: string
}

/**
 * Render the entries into the block body: one bullet each, so an agent reads
 * them as a list of standing facts rather than as prose it might follow as
 * instructions for the current task.
 */
export function renderSharedBody(entries: SharedMemoryEntry[]): string {
  const lines = entries
    .map(e => e.content.trim())
    .filter(Boolean)
    // A multi-line memory keeps its shape, indented under its own bullet.
    .map(content => `- ${content.split('\n').join('\n  ')}`)
  return lines.join('\n')
}

/**
 * The agent files the block is mirrored into: each agent's effective global
 * memory file, so an agent-specific config-dir override is respected.
 */
export function sharedMemoryTargets(
  pathMod: typeof Path,
  home: string,
  envFor: (agent: string) => Record<string, string>,
): Array<{ agent: string; path: string }> {
  return Object.keys(AGENT_MEMORY).flatMap(agent => {
    const file = userMemoryFiles(pathMod, agent, home, envFor(agent))[0]
    return file ? [{ agent, path: file }] : []
  })
}

function findBlock(text: string): { start: number; end: number } | null {
  const start = text.indexOf(BLOCK_BEGIN)
  if (start < 0) return null
  const endMarker = text.indexOf(BLOCK_END, start)
  if (endMarker < 0) return null
  return { start, end: endMarker + BLOCK_END.length }
}

/** True when a file already carries Codey's block. */
export function hasManagedBlock(text: string): boolean {
  return findBlock(text) !== null
}

/**
 * Replace, insert, or (with an empty body) drop Codey's block in a file the
 * user owns. The block is appended at the end so the user's own opening
 * instructions keep their position.
 */
export function applyManagedBlock(existing: string, body: string): string {
  const trimmedBody = body.trim()
  const found = findBlock(existing)
  const block = trimmedBody ? [BLOCK_BEGIN, BLOCK_NOTE, '', trimmedBody, BLOCK_END].join('\n') : ''

  if (found) {
    const before = existing.slice(0, found.start)
    const after = existing.slice(found.end)
    if (!block) {
      // Removing the block should not leave the blank lines that framed it.
      const joined = `${before.replace(/\n*$/, '')}\n${after.replace(/^\n*/, '')}`
      return joined.trim() ? joined.replace(/\n{3,}/g, '\n\n') : ''
    }
    return `${before}${block}${after}`
  }

  if (!block) return existing
  if (!existing.trim()) return `${block}\n`
  return `${existing.replace(/\n*$/, '')}\n\n${block}\n`
}

export interface SharedMemorySyncResult {
  /** Files the block was written into or removed from. */
  written: string[]
  /** Files left untouched because they already matched. */
  unchanged: string[]
}

/**
 * Mirror `body` into every agent's global memory file. An empty body (or a
 * disabled feature) removes the block again, and deletes a file that Codey's
 * block was the only content of.
 */
export function syncSharedMemory(
  fsMod: typeof Fs,
  pathMod: typeof Path,
  targets: Array<{ agent: string; path: string }>,
  body: string,
): SharedMemorySyncResult {
  const result: SharedMemorySyncResult = { written: [], unchanged: [] }
  for (const target of targets) {
    let existing = ''
    let exists = true
    try {
      existing = fsMod.readFileSync(target.path, 'utf-8')
    } catch { exists = false }

    // Never create a file just to say the shared memory is empty.
    if (!exists && !body.trim()) continue

    const next = applyManagedBlock(existing, body)
    if (exists && next === existing) {
      result.unchanged.push(target.path)
      continue
    }
    if (exists && !next.trim()) {
      // The block was all the file held — leave no empty leftovers behind.
      try { fsMod.unlinkSync(target.path) } catch { /* already gone */ }
      result.written.push(target.path)
      continue
    }
    fsMod.mkdirSync(pathMod.dirname(target.path), { recursive: true })
    fsMod.writeFileSync(target.path, next, 'utf-8')
    result.written.push(target.path)
  }
  return result
}
