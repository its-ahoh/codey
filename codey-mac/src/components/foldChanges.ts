/**
 * Folds a file's edit history into the net result — what the file actually looks
 * like now — instead of stacking every intermediate edit on top of each other.
 *
 * Agents routinely rewrite the same region several times in a run. Rendering
 * each edit separately shows the same lines two or three times, including text
 * that no longer exists anywhere in the file. Folding chains those edits so one
 * region produces one hunk: the text before the first edit touched it, and the
 * text after the last one did.
 */

export interface FoldableChange {
  tool: 'Edit' | 'Write' | 'Patch' | 'Notebook'
  oldText: string
  newText: string
}

export interface FoldedChange<T> {
  /** The region as it was before the first edit in this chain. */
  oldText: string
  /** The region as it is after the last edit in this chain. */
  newText: string
  /** Edits folded into this region, oldest first. */
  sources: T[]
}

/** Literal (non-regex) replacement of the first occurrence of `find`. */
const replaceOnce = (text: string, find: string, replacement: string): string => {
  const idx = text.indexOf(find)
  if (idx < 0) return text
  return text.slice(0, idx) + replacement + text.slice(idx + find.length)
}

/**
 * Fold `changes` (chronological, single file, no Patch entries) into the net set
 * of regions. A later edit joins an earlier chain when either text contains the
 * other: rewriting part of what the chain produced, or replacing a wider region
 * that swallows it. A Write supersedes everything before it, since it rewrites
 * the whole file. Regions that end up unchanged are dropped.
 */
export const foldFileChanges = <T extends FoldableChange>(changes: T[]): Array<FoldedChange<T>> => {
  let chains: Array<FoldedChange<T>> = []

  for (const change of changes) {
    if (change.tool === 'Write') {
      // Prior edits are moot — keep them only as sources so edit counts stay honest.
      const superseded = chains.flatMap(c => c.sources)
      chains = [{ oldText: change.oldText, newText: change.newText, sources: [...superseded, change] }]
      continue
    }

    // Prefer the most recent chain: repeated edits to one spot land there, and
    // short strings are less likely to collide with an older, unrelated region.
    let folded = false
    for (let i = chains.length - 1; i >= 0; i--) {
      const chain = chains[i]
      if (change.oldText && chain.newText.includes(change.oldText)) {
        chain.newText = replaceOnce(chain.newText, change.oldText, change.newText)
        chain.sources.push(change)
        folded = true
        break
      }
      if (chain.newText && change.oldText.includes(chain.newText)) {
        // This edit spans a wider region; the chain's own "before" text belongs
        // inside the wider before-text.
        chain.oldText = replaceOnce(change.oldText, chain.newText, chain.oldText)
        chain.newText = change.newText
        chain.sources.push(change)
        folded = true
        break
      }
    }
    if (!folded) {
      chains.push({ oldText: change.oldText, newText: change.newText, sources: [change] })
    }
  }

  return chains.filter(c => c.oldText !== c.newText)
}
