// Workspace file index behind the composer's "@" mention menu.
//
// The listing comes from `git ls-files` when the working dir is a repo, purely
// because it is a fast single fork. It deliberately does NOT pass
// --exclude-standard: .gitignore'd paths (.env, build output, local scratch
// files) are exactly the things people want to point an agent at. Instead both
// the git path and the non-repo fs walk drop the handful of heavyweight
// directories below, which would otherwise drown the menu.

export type FileEntry = {
  /** Path relative to the working dir, POSIX separators, no leading "./". */
  path: string
  /** Last segment of `path`. */
  name: string
  isDir: boolean
}

/** Hard cap on indexed entries — big monorepos should not blow up memory. */
export const MAX_ENTRIES = 20000

const SKIP_DIRS = new Set([
  '.git', 'node_modules', 'dist', 'build', '.build', 'out', 'target', 'vendor',
  '.next', '.nuxt', '.cache', '.venv', 'venv', '__pycache__', '.pytest_cache',
  'coverage', '.turbo', '.gradle', '.idea', 'DerivedData',
])

/** True when any segment of `path` is a directory we never index. */
export function isSkippedPath(path: string): boolean {
  return path.split('/').some(segment => SKIP_DIRS.has(segment))
}

/**
 * Split `git ls-files -z` output into clean relative paths, minus anything
 * under a skipped directory — without --exclude-standard the raw listing
 * includes every ignored build artifact and dependency tree.
 */
export function parseGitFileList(stdout: string): string[] {
  return stdout
    .split('\0')
    .map(l => l.trim())
    .filter(l => l.length > 0 && !isSkippedPath(l))
}

/**
 * Expand a file path list into the menu's entry list: every file plus each
 * directory that contains one, so "@src/comp" can offer the folder too.
 */
export function deriveEntries(paths: string[]): FileEntry[] {
  const seenDirs = new Set<string>()
  const files: FileEntry[] = []
  for (const raw of paths) {
    const path = raw.replace(/^\.\//, '')
    if (!path) continue
    const segments = path.split('/')
    files.push({ path, name: segments[segments.length - 1], isDir: false })
    for (let i = 1; i < segments.length; i++) {
      seenDirs.add(segments.slice(0, i).join('/'))
    }
  }
  const dirs: FileEntry[] = [...seenDirs].map(path => {
    const segments = path.split('/')
    return { path, name: segments[segments.length - 1], isDir: true }
  })
  const all = [...dirs, ...files]
  all.sort(byPath)
  if (all.length <= MAX_ENTRIES) return all

  // Over the cap. Slicing the alphabetical list would delete whole top-level
  // directories from the tail — "src/" simply vanishing is far worse than
  // losing scattered deep files. Keep the shallowest paths instead, so
  // truncation thins the deep tails of a huge tree and every top-level entry
  // survives. Re-sort by path afterwards so callers still get a stable order.
  const kept = [...all].sort((a, b) => depthOf(a.path) - depthOf(b.path) || byPath(a, b))
  kept.length = MAX_ENTRIES
  kept.sort(byPath)
  return kept
}

const byPath = (a: FileEntry, b: FileEntry) => a.path.localeCompare(b.path)
const depthOf = (path: string) => {
  let depth = 1
  for (let i = 0; i < path.length; i++) if (path[i] === '/') depth++
  return depth
}

/** Bounded fs walk for working dirs that are not git repos. */
export function walkDirectory(
  root: string,
  fs: { readdirSync: (p: string, o: { withFileTypes: true }) => Array<{ name: string; isDirectory(): boolean; isFile(): boolean }> },
  limit = MAX_ENTRIES,
): string[] {
  const out: string[] = []
  const queue: string[] = ['']
  while (queue.length > 0 && out.length < limit) {
    const rel = queue.shift() as string
    const abs = rel ? `${root}/${rel}` : root
    let dirEntries
    try { dirEntries = fs.readdirSync(abs, { withFileTypes: true }) } catch { continue }
    for (const dirent of dirEntries) {
      // Dotfiles are included on purpose — .env and friends are worth mentioning.
      // .git itself is excluded via SKIP_DIRS below.
      const childRel = rel ? `${rel}/${dirent.name}` : dirent.name
      if (dirent.isDirectory()) {
        if (SKIP_DIRS.has(dirent.name)) continue
        queue.push(childRel)
      } else if (dirent.isFile()) {
        out.push(childRel)
        if (out.length >= limit) break
      }
    }
  }
  return out
}
