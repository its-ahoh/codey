// NOTE: this module runs in the renderer (nodeIntegration is off), so it must
// not import Node's 'path' — that externalizes to require() and crashes the
// renderer bundle. The path building below is plain string work (macOS paths).

export interface Worktree { branch: string; path: string; isMain: boolean }
export interface BranchData { current: string; local: string[]; remote: string[] }

/** Case-insensitive substring filter; empty query returns the list unchanged. */
export function filterBranches(list: string[], query: string): string[] {
  const q = query.trim().toLowerCase();
  if (!q) return list;
  return list.filter(b => b.toLowerCase().includes(q));
}

/** Default worktree location: `<repo>/.codey/worktrees/<branch>` (in-repo, gitignored). */
export function defaultWorktreePath(repoPath: string, branchName: string): string {
  const root = repoPath.replace(/\/+$/, '');
  const safe = branchName.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return `${root}/.codey/worktrees/${safe}`;
}

/** Separate the main worktree from the rest for display. */
export function partitionWorktrees(list: Worktree[]): { main?: Worktree; others: Worktree[] } {
  const main = list.find(w => w.isMain);
  const others = list.filter(w => !w.isMain);
  return { main, others };
}
