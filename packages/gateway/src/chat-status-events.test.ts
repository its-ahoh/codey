import { describe, it, expect } from 'vitest';
import { chatStreamEventForStatus, isPersistableToolCall } from './chat-status-events';

describe('chatStreamEventForStatus', () => {
  it('maps a checklist update onto its own event carrying the items', () => {
    const event = chatStreamEventForStatus('c1', {
      type: 'checklist',
      message: '1/2 · Doing b',
      checklist: [
        { text: 'a', status: 'completed' },
        { text: 'b', status: 'in_progress', activeForm: 'Doing b' },
      ],
    });
    expect(event).toEqual({
      type: 'checklist',
      chatId: 'c1',
      message: '1/2 · Doing b',
      items: [
        { text: 'a', status: 'completed' },
        { text: 'b', status: 'in_progress', activeForm: 'Doing b' },
      ],
    });
  });

  it('drops a checklist update with no items instead of emitting an empty list', () => {
    // An empty list would blank the panel mid-run for no reason.
    expect(chatStreamEventForStatus('c1', { type: 'checklist', message: '', checklist: [] })).toBeNull();
    expect(chatStreamEventForStatus('c1', { type: 'checklist', message: '' })).toBeNull();
  });

  it('still maps the tool events unchanged', () => {
    expect(chatStreamEventForStatus('c1', { type: 'tool_start', tool: 'Read', message: 'Read(a.ts)', input: { file_path: 'a.ts' } }))
      .toEqual({ type: 'tool_start', chatId: 'c1', tool: 'Read', message: 'Read(a.ts)', input: { file_path: 'a.ts' } });
    expect(chatStreamEventForStatus('c1', { type: 'tool_end', tool: 'Read', message: 'done', output: 'x' }))
      .toEqual({ type: 'tool_end', chatId: 'c1', tool: 'Read', message: 'done', output: 'x' });
  });

  it('treats anything else as an info notice', () => {
    expect(chatStreamEventForStatus('c1', { type: 'info', message: 'hello' }))
      .toEqual({ type: 'info', chatId: 'c1', message: 'hello' });
    expect(chatStreamEventForStatus('c1', { message: 'no type' }))
      .toEqual({ type: 'info', chatId: 'c1', message: 'no type' });
  });
});

describe('isPersistableToolCall', () => {
  it('keeps real tool activity in the message transcript', () => {
    expect(isPersistableToolCall('tool_start')).toBe(true);
    expect(isPersistableToolCall('tool_end')).toBe(true);
    expect(isPersistableToolCall('info')).toBe(true);
  });

  it('excludes checklist updates, which are state and not a tool call', () => {
    // The list is restated in full on every revision; recording each one would
    // bury the transcript under duplicate rows that never were tool calls.
    expect(isPersistableToolCall('checklist')).toBe(false);
  });
});
