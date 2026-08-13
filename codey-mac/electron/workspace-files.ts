// Workspace file index behind the composer's "@" mention menu.
//
// The listing comes from `git ls-files` when the working dir is a repo — that
// gives us .gitignore filtering for free, which a naive fs walk would have to
// reimplement badly. Non-repo directories fall back to a bounded manual walk
// that skips the usual heavyweight directories.

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
  '.git', 'node_modules', 'dist', 'build', 'out', 'target', 'vendor',
  '.next', '.nuxt', '.cache', '.venv', 'venv', '__pycache__', '.pytest_cache',
  'coverage', '.turbo', '.gradle', '.idea', 'DerivedData',
])

/** Split `git ls-files -z` output into clean relative paths. */
export function parseGitFileList(stdout: string): string[] {
  return stdout
    .split('\0')
    .map(l => l.trim())
    .filter(l => l.length > 0)
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
  all.sort((a, b) => a.path.localeCompare(b.path))
  return all.slice(0, MAX_ENTRIES)
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
      if (dirent.name.startsWith('.') && dirent.name !== '.github') continue
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
