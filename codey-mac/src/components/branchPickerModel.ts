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

/** Move the current item to the front while preserving every other item's order. */
export function currentFirst<T>(list: T[], isCurrent: (item: T) => boolean): T[] {
  const currentIndex = list.findIndex(isCurrent);
  if (currentIndex <= 0) return list;
  return [list[currentIndex], ...list.slice(0, currentIndex), ...list.slice(currentIndex + 1)];
}
