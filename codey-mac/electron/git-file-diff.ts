/**
 * Parse `git diff --numstat -z` output into per-path line counts. Binary files
 * report "-" for both columns and are skipped. With -z each record is
 * "added\tremoved\tpath\0"; renames add a second path field, which is
 * ignored here because the caller only asks about plain paths.
 */
export function parseNumstat(stdout: string): Map<string, { added: number; removed: number }> {
  const out = new Map<string, { added: number; removed: number }>()
  for (const record of stdout.split('\0')) {
    if (!record) continue
    const [a, r, path] = record.split('\t')
    if (!path) continue
    const added = parseInt(a, 10)
    const removed = parseInt(r, 10)
    if (Number.isNaN(added) || Number.isNaN(removed)) continue
    out.set(path, { added, removed })
  }
  return out
}
