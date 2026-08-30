// Turn a path written inside a chat message into a real path on disk.
//
// Messages carry paths in three shapes: absolute ("/Users/me/x.ts"), home
// relative ("~/x.ts") and workspace relative ("src/app.ts"). Only the last one
// needs the chat's working dir, which the renderer passes along.

import { isAbsolute, join, normalize, resolve } from 'path'
import { homedir } from 'os'
import { stat } from 'fs/promises'

export interface LocatedPath {
  /** Absolute path, or null when the reference could not be resolved at all. */
  absPath: string | null
  exists: boolean
  isDirectory: boolean
}

/**
 * Expand `~` and resolve a relative path against `cwd`. Returns null when the
 * path is relative and no working dir is known — guessing against the app's
 * own cwd would open unrelated files.
 */
export function resolveRefPath(path: string, cwd?: string | null): string | null {
  const trimmed = typeof path === 'string' ? path.trim() : ''
  if (!trimmed) return null
  if (trimmed === '~' || trimmed.startsWith('~/')) {
    return normalize(join(homedir(), trimmed.slice(1)))
  }
  if (isAbsolute(trimmed)) return normalize(trimmed)
  if (!cwd) return null
  return resolve(cwd, trimmed)
}

/** Resolve a reference and ask the filesystem what, if anything, is there. */
export async function locateRefPath(path: string, cwd?: string | null): Promise<LocatedPath> {
  const absPath = resolveRefPath(path, cwd)
  if (!absPath) return { absPath: null, exists: false, isDirectory: false }
  try {
    const info = await stat(absPath)
    return { absPath, exists: true, isDirectory: info.isDirectory() }
  } catch {
    return { absPath, exists: false, isDirectory: false }
  }
}
