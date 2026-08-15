// NOTE: this module runs in the renderer (nodeIntegration is off), so it must
// not import Node's 'path' — that externalizes to require() and crashes the
// renderer bundle. The path building below is plain string work (macOS paths).

export interface BranchData { current: string; local: string[]; remote: string[] }

/** Case-insensitive substring filter; empty query returns the list unchanged. */
export function filterBranches(list: string[], query: string): string[] {
  const q = query.trim().toLowerCase();
  if (!q) return list;
  return list.filter(b => b.toLowerCase().includes(q));
}

/** Compact a filesystem path without hiding its identifying final segments. */
export function compactWorktreePath(path: string, maxSegments = 3): string {
  const parts = path.split('/').filter(Boolean);
  if (parts.length <= maxSegments) return path || '—';
  return `…/${parts.slice(-maxSegments).join('/')}`;
}

export interface PullResult {
  ok: boolean;
  updated?: number;
  upstream?: string;
  error?: string;
  reason?: 'dirty' | 'diverged' | 'no-upstream';
}

/** A short status line shown at the top of the picker, next to the branch identity. */
export interface BranchNote { tone: 'ok' | 'warn' | 'error'; text: string }

/** Human-readable note for a sync attempt. Blocked syncs are warnings rather than
 * errors: the branch is fine, it just needs the user to decide what to do next. */
export function describePullResult(result: PullResult): BranchNote {
  if (result.ok) {
    const count = result.updated ?? 0;
    if (count === 0) return { tone: 'ok', text: 'Already up to date' };
    return {
      tone: 'ok',
      text: `Pulled ${count} commit${count === 1 ? '' : 's'}${result.upstream ? ` from ${result.upstream}` : ''}`,
    };
  }
  if (result.reason === 'no-upstream') return { tone: 'warn', text: 'No upstream branch — push this branch first' };
  if (result.reason === 'dirty') return { tone: 'warn', text: 'Local changes would be overwritten — commit or stash first' };
  if (result.reason === 'diverged') return { tone: 'warn', text: 'Branch has diverged from its upstream — rebase or merge manually' };
  return { tone: 'error', text: result.error?.split('\n')[0] || 'Could not sync' };
}

/** Move the current item to the front while preserving every other item's order. */
export function currentFirst<T>(list: T[], isCurrent: (item: T) => boolean): T[] {
  const currentIndex = list.findIndex(isCurrent);
  if (currentIndex <= 0) return list;
  return [list[currentIndex], ...list.slice(0, currentIndex), ...list.slice(currentIndex + 1)];
}
