import * as path from 'path';

export interface Worktree { branch: string; path: string; isMain: boolean }
export interface BranchData { current: string; local: string[]; remote: string[] }

/** Case-insensitive substring filter; empty query returns the list unchanged. */
export function filterBranches(list: string[], query: string): string[] {
  const q = query.trim().toLowerCase();
  if (!q) return list;
  return list.filter(b => b.toLowerCase().includes(q));
}

/** Default worktree location: `<repo-parent>/.codey-worktrees/<repo>-<branch>`. */
export function defaultWorktreePath(repoPath: string, branchName: string): string {
  const parent = path.dirname(repoPath);
  const repo = path.basename(repoPath);
  const safe = branchName.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return path.join(parent, '.codey-worktrees', `${repo}-${safe}`);
}

/** Separate the main worktree from the rest for display. */
export function partitionWorktrees(list: Worktree[]): { main?: Worktree; others: Worktree[] } {
  const main = list.find(w => w.isMain);
  const others = list.filter(w => !w.isMain);
  return { main, others };
}
