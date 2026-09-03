import type { WriteDiff } from '../types'

export type GitFileDiff = { added: number; removed: number; patch: string; isNew: boolean }

/** What the panel shows for a file changed outside Edit/Write. */
export type ChangeSource = {
  added: number
  removed: number
  /** Unified patches, in the order they landed. Empty when only counts survive. */
  patches: string[]
  /** Some recorded write kept its counts but dropped its patch. */
  truncated: boolean
}

/**
 * Choose between git's working tree against HEAD and the diffs the gateway
 * recorded per tool call.
 *
 * Filtered to one turn, the recorded diffs are that turn's own change, so they
 * win. Showing everything, git's net diff wins because it folds repeated
 * writes to one file into a single change. But git only knows about work that
 * is still uncommitted: once the agent commits, `git diff HEAD` is empty and
 * the recorded diffs are the only evidence the chat changed the file at all.
 */
export function pickChangeSource(
  filter: 'all' | 'turn',
  recorded: WriteDiff[] | undefined,
  git: GitFileDiff | undefined,
): ChangeSource | null {
  const fromRecorded = (): ChangeSource | null => {
    if (!recorded || recorded.length === 0) return null
    return {
      added: recorded.reduce((n, d) => n + d.added, 0),
      removed: recorded.reduce((n, d) => n + d.removed, 0),
      patches: recorded.flatMap(d => (d.patch ? [d.patch] : [])),
      truncated: recorded.some(d => d.truncated === true),
    }
  }
  const fromGit = (): ChangeSource | null =>
    git ? { added: git.added, removed: git.removed, patches: [git.patch], truncated: false } : null
  return filter === 'turn'
    ? fromRecorded() ?? fromGit()
    : fromGit() ?? fromRecorded()
}
