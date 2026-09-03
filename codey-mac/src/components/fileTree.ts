/**
 * Folder tree behind the Files tab. The workspace index (every file and
 * directory the "@" mention menu knows about) is merged with what the agent
 * touched this chat, so changed files show up in their real place in the
 * tree, with line counts rolled up to each parent folder.
 */
import { lineDiff } from './toolFormat'

export type FileTouch =
  | { kind: 'edit'; added: number; removed: number; edits: number }
  /** A changed path whose counts come from the working-tree diff. */
  | { kind: 'change'; added: number; removed: number }
  | { kind: 'read' }

export interface TreeNode {
  name: string
  /** Absolute path. */
  path: string
  isDir: boolean
  children: TreeNode[]
  /** What the agent did to this file, if anything. Directories never carry one. */
  touch?: FileTouch
  /** Lines added/removed here, or summed over every descendant for a folder. */
  added: number
  removed: number
  /** This file was edited or shell-written, or a descendant was. */
  changed: boolean
  /** This file was read (and not changed), or a descendant was. */
  read: boolean
}

/** Added/removed line totals for a file's net hunks. */
export const countChangedLines = (
  hunks: Array<{ oldText: string; newText: string }>,
): { added: number; removed: number } => {
  let added = 0
  let removed = 0
  for (const h of hunks) {
    // An empty side is zero lines, not one blank line (a new file is all adds).
    if (!h.oldText || !h.newText) {
      if (h.newText) added += h.newText.split('\n').length
      if (h.oldText) removed += h.oldText.split('\n').length
      continue
    }
    for (const line of lineDiff(h.oldText, h.newText)) {
      if (line.kind === 'add') added++
      else if (line.kind === 'del') removed++
    }
  }
  return { added, removed }
}

/** `abs` relative to `workingDir`, or null when it lives elsewhere. */
export const relativeTo = (abs: string, workingDir?: string): string | null => {
  if (!workingDir) return null
  const root = workingDir.replace(/\/+$/, '')
  if (abs === root) return ''
  if (!abs.startsWith(root + '/')) return null
  return abs.slice(root.length + 1)
}

const makeNode = (name: string, path: string, isDir: boolean): TreeNode => ({
  name, path, isDir, children: [], added: 0, removed: 0, changed: false, read: false,
})

const byName = (a: TreeNode, b: TreeNode): number => {
  if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
  return a.name.localeCompare(b.name)
}

/** Walk/create the directory chain for `rel` under `root`, returning the leaf. */
const ensureNode = (root: TreeNode, rootPath: string, rel: string, isDir: boolean): TreeNode => {
  const segments = rel.split('/').filter(Boolean)
  let current = root
  let abs = rootPath
  segments.forEach((segment, i) => {
    abs = `${abs}/${segment}`
    const last = i === segments.length - 1
    let next = current.children.find(c => c.name === segment)
    if (!next) {
      next = makeNode(segment, abs, last ? isDir : true)
      current.children.push(next)
    } else if (!last && !next.isDir) {
      next.isDir = true
    }
    current = next
  })
  return current
}

const applyTouch = (node: TreeNode, touch: FileTouch) => {
  node.touch = touch
  if (touch.kind === 'edit') {
    node.added = touch.added
    node.removed = touch.removed
    node.changed = true
  } else if (touch.kind === 'change') {
    node.added = touch.added
    node.removed = touch.removed
    node.changed = true
  } else {
    node.read = true
  }
}

/** Sort every level and roll counts/flags up from files to folders. */
const finalize = (node: TreeNode): TreeNode => {
  if (!node.isDir) return node
  node.children.sort(byName)
  for (const child of node.children) {
    finalize(child)
    node.added += child.added
    node.removed += child.removed
    node.changed = node.changed || child.changed
    node.read = node.read || child.read
  }
  return node
}

export const buildFileTree = (opts: {
  workingDir?: string
  entries: Array<{ path: string; isDir: boolean }>
  touches: Map<string, FileTouch>
}): { root: TreeNode[]; outside: TreeNode[] } => {
  const rootPath = opts.workingDir?.replace(/\/+$/, '') ?? ''
  const root = makeNode('', rootPath, true)
  const outside: TreeNode[] = []

  if (opts.workingDir) {
    for (const entry of opts.entries) {
      const rel = entry.path.replace(/^\.\//, '')
      if (rel) ensureNode(root, rootPath, rel, entry.isDir)
    }
  }

  for (const [abs, touch] of opts.touches) {
    const rel = relativeTo(abs, opts.workingDir)
    if (rel) {
      applyTouch(ensureNode(root, rootPath, rel, false), touch)
    } else {
      const node = makeNode(abs, abs, false)
      applyTouch(node, touch)
      outside.push(node)
    }
  }

  finalize(root)
  outside.sort((a, b) => a.path.localeCompare(b.path))
  return { root: root.children, outside }
}
