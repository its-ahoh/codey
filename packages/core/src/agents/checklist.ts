// packages/core/src/agents/checklist.ts
//
// The three CLIs all track a task list, and all three describe it differently.
// Verified against real streams:
//
//   claude-code  TodoWrite tool  -> input.todos = [{content, status, activeForm}]
//   opencode     todowrite tool  -> state.input.todos = [{content, status, priority}]
//   codex        todo_list item  -> item.items = [{text, completed}]
//
// The first two share a tri-state status word; codex has only a boolean and
// never reports which item is in flight. Normalizing here keeps that difference
// in one place, so the UI renders one shape and only has to know that an
// inferred current item is a guess rather than a claim.

import { ChecklistItem, ChecklistStatus, StatusUpdate } from '../types';

const CHECKLIST_TOOLS = new Set(['todowrite', 'todoread']);

/** True for the tool names claude-code and opencode use to write a task list. */
export function isChecklistTool(tool?: string): boolean {
  return CHECKLIST_TOOLS.has((tool ?? '').toLowerCase());
}

/** An unknown status word means "not started": claiming completion we were
 *  never told about would overstate progress, which is the one error the
 *  panel must not make. */
function statusOf(raw: unknown): ChecklistStatus {
  const word = typeof raw === 'string' ? raw.toLowerCase().trim() : '';
  if (word === 'completed' || word === 'complete' || word === 'done') return 'completed';
  if (word === 'in_progress' || word === 'in-progress' || word === 'active') return 'in_progress';
  return 'pending';
}

/** Normalize the `todos` array claude-code and opencode both pass as tool input.
 *  Returns null when there is no list worth showing. */
export function checklistFromTodos(input?: Record<string, unknown>): ChecklistItem[] | null {
  const todos = input?.todos;
  if (!Array.isArray(todos) || todos.length === 0) return null;

  const items: ChecklistItem[] = [];
  for (const raw of todos) {
    if (!raw || typeof raw !== 'object') continue;
    const todo = raw as Record<string, unknown>;
    const text = typeof todo.content === 'string' ? todo.content
      : typeof todo.text === 'string' ? todo.text
      : '';
    if (!text) continue;
    // activeForm is claude-code's present-tense phrasing of the same item
    // ("Implementing the reducer"), written for exactly this display.
    const activeForm = typeof todo.activeForm === 'string' && todo.activeForm ? todo.activeForm : undefined;
    items.push({ text, status: statusOf(todo.status), ...(activeForm ? { activeForm } : {}) });
  }
  return items.length ? items : null;
}

/** Normalize a codex `todo_list` item payload. Its booleans collapse onto
 *  completed/pending — codex has no in_progress to report. */
export function checklistFromCodexTodoList(
  items?: Array<{ text?: string; completed?: boolean }>,
): ChecklistItem[] | null {
  if (!Array.isArray(items) || items.length === 0) return null;
  const normalized: ChecklistItem[] = [];
  for (const entry of items) {
    const text = typeof entry?.text === 'string' ? entry.text : '';
    if (!text) continue;
    normalized.push({ text, status: entry.completed ? 'completed' : 'pending' });
  }
  return normalized.length ? normalized : null;
}

/** Pull the checklist out of a codex stream item, or null when the item is
 *  anything else. Codex reports its list as a `todo_list` item — never a tool
 *  call — so this is the only hook for it. */
export function checklistFromCodexItem(item?: {
  type?: string;
  items?: Array<{ text?: string; completed?: boolean }>;
}): ChecklistItem[] | null {
  if (item?.type !== 'todo_list') return null;
  return checklistFromCodexTodoList(item.items);
}

export interface CurrentChecklistItem {
  item: ChecklistItem;
  index: number;
  /** True when no item was marked in_progress and we picked the first
   *  unfinished one instead. The UI must not present a guess as a fact. */
  inferred: boolean;
}

/** The item the agent is working on, or null when the list is finished. */
export function currentChecklistItem(items: ChecklistItem[]): CurrentChecklistItem | null {
  const active = items.findIndex(i => i.status === 'in_progress');
  if (active >= 0) return { item: items[active], index: active, inferred: false };
  const next = items.findIndex(i => i.status !== 'completed');
  if (next >= 0) return { item: items[next], index: next, inferred: true };
  return null;
}

/** One-line summary for surfaces that get text rather than structure
 *  (channels, logs): "1/3 · Implementing the reducer". */
export function summarizeChecklist(items: ChecklistItem[]): string {
  const done = items.filter(i => i.status === 'completed').length;
  const progress = `${done}/${items.length}`;
  const current = currentChecklistItem(items);
  if (!current) return progress;
  return `${progress} · ${current.item.activeForm ?? current.item.text}`;
}

/** Holds a run's task list and announces it only when it actually changes.
 *  Codex restates an identical list on both item.started and item.completed,
 *  and any CLI may rewrite a list without moving anything in it. */
export class ChecklistTracker {
  private current: ChecklistItem[] | null = null;
  private lastKey = '';

  constructor(private readonly onStatus?: (update: StatusUpdate) => void) {}

  record(items: ChecklistItem[] | null): void {
    if (!items || items.length === 0) return;
    const key = items.map(i => `${i.status}:${i.text}`).join(' ');
    if (key === this.lastKey) return;
    this.lastKey = key;
    this.current = items;
    this.onStatus?.({ type: 'checklist', message: summarizeChecklist(items), checklist: items });
  }

  /** The list as last reported, for the run's final response. */
  latest(): ChecklistItem[] | null {
    return this.current;
  }
}
