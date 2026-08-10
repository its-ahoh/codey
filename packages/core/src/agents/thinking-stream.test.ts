import { describe, it, expect } from 'vitest';
import { thinkingDeltaFrom } from './thinking-stream';

describe('thinkingDeltaFrom', () => {
  it('extracts text from a thinking_delta', () => {
    expect(thinkingDeltaFrom({
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'hm ' } },
    })).toBe('hm ');
  });

  it('returns non-English thinking text and whitespace unchanged', () => {
    const source = `\n  \u5148\u68C0\u67E5\u73B0\u6709\u903B\u8F91\nthen verify  `;
    expect(thinkingDeltaFrom({
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: source } },
    })).toBe(source);
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
