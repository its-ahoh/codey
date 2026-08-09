import { describe, it, expect } from 'vitest';
import {
  isChecklistTool,
  checklistFromTodos,
  checklistFromCodexTodoList,
  currentChecklistItem,
  checklistFromCodexItem,
  ChecklistTracker,
} from './checklist';
import { CODEX_TOOL_ITEMS } from './codex';
import { StatusUpdate } from '../types';

describe('isChecklistTool', () => {
  it('recognizes the todo tools claude-code and opencode expose', () => {
    // Verified against real streams: claude-code emits `TodoWrite`,
    // opencode emits `todowrite` (both lowercase-compared here).
    expect(isChecklistTool('TodoWrite')).toBe(true);
    expect(isChecklistTool('todowrite')).toBe(true);
    expect(isChecklistTool('TodoRead')).toBe(true);
  });

  it('does not claim unrelated tools', () => {
    expect(isChecklistTool('Read')).toBe(false);
    expect(isChecklistTool('bash')).toBe(false);
    expect(isChecklistTool(undefined)).toBe(false);
  });
});

describe('checklistFromTodos', () => {
  it('normalizes a claude-code TodoWrite input, keeping activeForm', () => {
    const items = checklistFromTodos({
      todos: [
        { content: 'Implement the reducer', status: 'in_progress', activeForm: 'Implementing the reducer' },
        { content: 'Write the tests', status: 'pending' },
      ],
    });
    expect(items).toEqual([
      { text: 'Implement the reducer', status: 'in_progress', activeForm: 'Implementing the reducer' },
      { text: 'Write the tests', status: 'pending' },
    ]);
  });

  it('normalizes an opencode todowrite input, which has no activeForm', () => {
    // Real opencode 1.14.18 payload shape: content/status/priority.
    const items = checklistFromTodos({
      todos: [
        { content: 'Step 1', status: 'completed', priority: 'medium' },
        { content: 'Step 2', status: 'pending', priority: 'medium' },
      ],
    });
    expect(items).toEqual([
      { text: 'Step 1', status: 'completed' },
      { text: 'Step 2', status: 'pending' },
    ]);
  });

  it('treats an unknown status word as pending rather than dropping the item', () => {
    const items = checklistFromTodos({ todos: [{ content: 'Step 1', status: 'queued' }] });
    expect(items).toEqual([{ text: 'Step 1', status: 'pending' }]);
  });

  it('returns null when there is nothing usable to show', () => {
    expect(checklistFromTodos(undefined)).toBeNull();
    expect(checklistFromTodos({})).toBeNull();
    expect(checklistFromTodos({ todos: [] })).toBeNull();
    expect(checklistFromTodos({ todos: 'nope' })).toBeNull();
  });

  it('skips entries with no text at all', () => {
    const items = checklistFromTodos({ todos: [{ status: 'pending' }, { content: 'Real', status: 'pending' }] });
    expect(items).toEqual([{ text: 'Real', status: 'pending' }]);
  });
});

describe('recorded CLI payloads', () => {
  it('reads a real opencode 1.14.18 todowrite part', () => {
    // Captured verbatim from `opencode run --format json`.
    const part = {
      type: 'tool',
      tool: 'todowrite',
      callID: 'call_00_xWUclb4HvHEK7hIvf2A22700',
      state: {
        status: 'completed',
        input: {
          todos: [
            { content: 'Step 1', status: 'pending', priority: 'medium' },
            { content: 'Step 2', status: 'pending', priority: 'medium' },
          ],
        },
      },
    };
    expect(isChecklistTool(part.tool)).toBe(true);
    expect(checklistFromTodos(part.state.input)).toEqual([
      { text: 'Step 1', status: 'pending' },
      { text: 'Step 2', status: 'pending' },
    ]);
  });

  it('reads a real codex 0.145.0 todo_list item', () => {
    // Captured verbatim from `codex exec --json`.
    const item = {
      id: 'item_1',
      type: 'todo_list',
      items: [
        { text: 'Define the task scope', completed: true },
        { text: 'Carry out the task', completed: false },
      ],
    };
    expect(checklistFromCodexItem(item)).toEqual([
      { text: 'Define the task scope', status: 'completed' },
      { text: 'Carry out the task', status: 'pending' },
    ]);
  });

  it('ignores codex items that are not the todo list', () => {
    const command = { id: 'x', type: 'command_execution', command: 'ls' };
    expect(checklistFromCodexItem(command)).toBeNull();
    expect(checklistFromCodexItem(undefined)).toBeNull();
  });

  it('keeps todo_list out of the codex tool items, so it never becomes a tool row', () => {
    // codex reports its list as an item, not a tool call. Routing it through
    // the tool collector would invent a tool row per plan revision.
    expect(CODEX_TOOL_ITEMS.has('todo_list')).toBe(false);
  });
});

describe('checklistFromCodexTodoList', () => {
  it('maps codex booleans onto the shared tri-state', () => {
    // Real codex 0.145.0 payload: {text, completed} — there is no in_progress.
    const items = checklistFromCodexTodoList([
      { text: 'Define the task scope', completed: true },
      { text: 'Carry out the task', completed: false },
    ]);
    expect(items).toEqual([
      { text: 'Define the task scope', status: 'completed' },
      { text: 'Carry out the task', status: 'pending' },
    ]);
  });

  it('returns null for an empty or malformed list', () => {
    expect(checklistFromCodexTodoList([])).toBeNull();
    expect(checklistFromCodexTodoList(undefined)).toBeNull();
  });
});

describe('currentChecklistItem', () => {
  it('reports an explicitly marked in_progress item', () => {
    const current = currentChecklistItem([
      { text: 'a', status: 'completed' },
      { text: 'b', status: 'in_progress', activeForm: 'Doing b' },
      { text: 'c', status: 'pending' },
    ]);
    expect(current).toEqual({
      item: { text: 'b', status: 'in_progress', activeForm: 'Doing b' },
      index: 1,
      inferred: false,
    });
  });

  it('infers the first unfinished item when nothing is marked in_progress', () => {
    // codex never marks in_progress, so the current item is a guess and must
    // say so — the UI styles an inferred item differently.
    const current = currentChecklistItem([
      { text: 'a', status: 'completed' },
      { text: 'b', status: 'pending' },
      { text: 'c', status: 'pending' },
    ]);
    expect(current).toEqual({ item: { text: 'b', status: 'pending' }, index: 1, inferred: true });
  });

  it('has no current item once everything is done', () => {
    expect(currentChecklistItem([{ text: 'a', status: 'completed' }])).toBeNull();
    expect(currentChecklistItem([])).toBeNull();
  });
});

describe('ChecklistTracker', () => {
  const capture = () => {
    const seen: StatusUpdate[] = [];
    return { seen, tracker: new ChecklistTracker(u => seen.push(u)) };
  };

  it('emits a checklist update summarizing progress and the current item', () => {
    const { seen, tracker } = capture();
    tracker.record([
      { text: 'a', status: 'completed' },
      { text: 'b', status: 'in_progress', activeForm: 'Doing b' },
      { text: 'c', status: 'pending' },
    ]);
    expect(seen).toHaveLength(1);
    expect(seen[0].type).toBe('checklist');
    expect(seen[0].message).toBe('1/3 · Doing b');
    expect(seen[0].checklist).toHaveLength(3);
  });

  it('falls back to the plain text when the CLI has no activeForm', () => {
    const { seen, tracker } = capture();
    tracker.record([{ text: 'Step 1', status: 'pending' }, { text: 'Step 2', status: 'pending' }]);
    expect(seen[0].message).toBe('0/2 · Step 1');
  });

  it('reports a finished list without a current item', () => {
    const { seen, tracker } = capture();
    tracker.record([{ text: 'a', status: 'completed' }]);
    expect(seen[0].message).toBe('1/1');
  });

  it('stays silent when the list has not changed', () => {
    // codex emits item.started and item.completed with an identical payload;
    // re-announcing the same list would add noise and no information.
    const { seen, tracker } = capture();
    const items: Array<{ text: string; status: 'pending' }> = [{ text: 'a', status: 'pending' }];
    tracker.record(items);
    tracker.record([{ text: 'a', status: 'pending' }]);
    expect(seen).toHaveLength(1);
  });

  it('emits again once any item changes state', () => {
    const { seen, tracker } = capture();
    tracker.record([{ text: 'a', status: 'pending' }]);
    tracker.record([{ text: 'a', status: 'completed' }]);
    expect(seen).toHaveLength(2);
  });

  it('ignores an empty list rather than announcing an empty checklist', () => {
    const { seen, tracker } = capture();
    tracker.record(null);
    tracker.record([]);
    expect(seen).toHaveLength(0);
  });

  it('exposes the latest list so the run can report it when it ends', () => {
    const { tracker } = capture();
    expect(tracker.latest()).toBeNull();
    tracker.record([{ text: 'a', status: 'completed' }]);
    expect(tracker.latest()).toEqual([{ text: 'a', status: 'completed' }]);
  });
});
