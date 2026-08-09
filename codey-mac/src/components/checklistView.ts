// codey-mac/src/components/checklistView.ts
//
// Renderer-side derivations over the agent's own task list. The gateway
// normalizes the three CLIs into ChecklistItem before this sees anything, so
// the only difference left to honour is that codex never marks an item
// in_progress — the current item there is our guess, and is flagged as one.
//
// Deliberately free of React and of @codey/core's runtime: this file is pure
// so it can be tested directly, and the renderer only ever imports core types.

import type { ChecklistItem, ToolCallEntry } from '../types'

export interface ChecklistProgress {
  done: number
  total: number
  /** Rounded percentage, for the same bar the LLM-estimated brief drives. */
  percent: number
  /** "3/7" — the compact form shown beside the current item. */
  label: string
}

export function checklistProgress(items: ChecklistItem[]): ChecklistProgress {
  const total = items.length
  const done = items.filter(i => i.status === 'completed').length
  return {
    done,
    total,
    percent: total === 0 ? 0 : Math.round((done / total) * 100),
    label: `${done}/${total}`,
  }
}

export interface CurrentItem {
  item: ChecklistItem
  index: number
  /** True when nothing was marked in_progress and we picked the first
   *  unfinished item instead. Callers must not render a guess as a claim. */
  inferred: boolean
}

/** The item the agent is on, or null when the list is finished. */
export function currentChecklistItem(items: ChecklistItem[]): CurrentItem | null {
  const active = items.findIndex(i => i.status === 'in_progress')
  if (active >= 0) return { item: items[active], index: active, inferred: false }
  const next = items.findIndex(i => i.status !== 'completed')
  if (next >= 0) return { item: items[next], index: next, inferred: true }
  return null
}

/** claude-code writes activeForm ("Implementing the reducer") for exactly this
 *  line; the other two only have the imperative content. Using it verbatim
 *  beats a round-trip to a model just to fix the tense. */
export function currentItemLabel(item: ChecklistItem): string {
  return item.activeForm || item.text
}

/** The tool running right now, or undefined once it has finished.
 *  Only a trailing tool_start counts: after tool_end the agent is deciding what
 *  to do next, and holding the last tool's name there would claim activity that
 *  has already stopped. */
export function activeToolHeadline(
  entries: ToolCallEntry[] | undefined,
  format: (tool: string, input?: Record<string, unknown>) => string,
): string | undefined {
  const last = [...(entries ?? [])].reverse().find(e => e.type === 'tool_start' || e.type === 'tool_end')
  if (!last || last.type !== 'tool_start' || !last.tool) return undefined
  return format(last.tool, last.input) || undefined
}

export interface ChecklistWindow {
  shown: ChecklistItem[]
  /** Items elided before/after the window, so the panel can say so rather
   *  than quietly truncating a list the user is using to track progress. */
  hiddenBefore: number
  hiddenAfter: number
}

/** A long plan would push everything else out of the sidecar, so show a window
 *  around the current item — the finished tail above it is the least useful
 *  part to keep on screen. */
export function checklistWindow(items: ChecklistItem[], max = 6): ChecklistWindow {
  if (items.length <= max) return { shown: items, hiddenBefore: 0, hiddenAfter: 0 }
  const current = currentChecklistItem(items)
  const focus = current ? current.index : items.length - 1
  // Keep one line of finished context above the current item where possible.
  const start = Math.min(Math.max(0, focus - 1), items.length - max)
  const end = start + max
  return { shown: items.slice(start, end), hiddenBefore: start, hiddenAfter: items.length - end }
}

export interface StatusLineInput {
  /** The agent's task list, when it reported one. */
  checklist?: ChecklistItem[]
  /** Tool calls on the in-flight assistant message. */
  entries?: ToolCallEntry[]
  format: (tool: string, input?: Record<string, unknown>) => string
  /** What to say when there is no checklist — the existing activity word. */
  fallback: string
}

export interface StatusLine {
  /** Rendered joined by " · ": what, how, how far. */
  parts: string[]
  /** The leading item is a guess (codex). Render it without the in-progress
   *  marker so a supposition doesn't read as the agent's own statement. */
  inferred: boolean
}

/** Three layers, each dropped when its source has nothing to say:
 *  "Implementing the reducer · Edit(sessionReducer.ts) · 3/7". */
export function statusLine({ checklist, entries, format, fallback }: StatusLineInput): StatusLine {
  const tool = activeToolHeadline(entries, format)
  const items = checklist ?? []
  const current = items.length ? currentChecklistItem(items) : null

  if (!items.length) {
    return { parts: [fallback, ...(tool ? [tool] : [])], inferred: false }
  }

  const progress = checklistProgress(items).label
  // A finished list still deserves its count: "3/3" beats silently reverting
  // to a generic verb while the agent writes up the result.
  const head = current ? currentItemLabel(current.item) : fallback
  return {
    parts: [head, ...(tool ? [tool] : []), progress],
    inferred: current?.inferred ?? false,
  }
}
