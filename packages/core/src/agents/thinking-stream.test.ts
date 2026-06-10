import { describe, it, expect } from 'vitest';
import { thinkingDeltaFrom, isThinkingBlockStart } from './thinking-stream';

describe('thinkingDeltaFrom', () => {
  it('extracts text from a thinking_delta', () => {
    expect(thinkingDeltaFrom({
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'hm ' } },
    })).toBe('hm ');
  });

  it('returns null for a text_delta', () => {
    expect(thinkingDeltaFrom({
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'answer' } },
    })).toBeNull();
  });

  it('returns null for non-delta events', () => {
    expect(thinkingDeltaFrom({ type: 'assistant' })).toBeNull();
  });
});

describe('isThinkingBlockStart', () => {
  it('is true for a thinking content_block_start', () => {
    expect(isThinkingBlockStart({
      type: 'stream_event',
      event: { type: 'content_block_start', content_block: { type: 'thinking' } },
    })).toBe(true);
  });

  it('is false for a tool_use start', () => {
    expect(isThinkingBlockStart({
      type: 'stream_event',
      event: { type: 'content_block_start', content_block: { type: 'tool_use', name: 'Read' } },
    })).toBe(false);
  });

  it('ignores redacted_thinking (no plaintext to show)', () => {
    expect(isThinkingBlockStart({
      type: 'stream_event',
      event: { type: 'content_block_start', content_block: { type: 'redacted_thinking' } },
    })).toBe(false);
  });
});
