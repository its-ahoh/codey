/**
 * Turn a unified diff (one file) into the hunks the combined diff view draws:
 * each `@@` block becomes one region with its before/after text and the real
 * line it starts at in the new file. Context lines land on both sides so the
 * view diffs them back out as unchanged.
 */
export interface PatchHunk {
  oldText: string
  newText: string
  startLine: number
}

export function parseUnifiedPatch(patch: string): PatchHunk[] {
  const hunks: PatchHunk[] = []
  let current: { oldLines: string[]; newLines: string[]; startLine: number } | null = null
  const flush = () => {
    if (current) hunks.push({ oldText: current.oldLines.join('\n'), newText: current.newLines.join('\n'), startLine: current.startLine })
    current = null
  }
  for (const line of patch.split('\n')) {
    const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
    if (header) {
      flush()
      current = { oldLines: [], newLines: [], startLine: parseInt(header[1], 10) || 1 }
      continue
    }
    if (!current) continue
    if (line.startsWith('\\')) continue // "\ No newline at end of file"
    if (line.startsWith('+')) current.newLines.push(line.slice(1))
    else if (line.startsWith('-')) current.oldLines.push(line.slice(1))
    else if (line.startsWith(' ')) { current.oldLines.push(line.slice(1)); current.newLines.push(line.slice(1)) }
    else if (line === '') { /* trailing blank after the last hunk */ }
  }
  flush()
  return hunks
}
