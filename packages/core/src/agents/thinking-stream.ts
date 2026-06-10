/** Minimal shape of a claude-code stream-json event we inspect for thinking. */
export interface ThinkingProbe {
  type?: string;
  event?: {
    type?: string;
    delta?: { type?: string; thinking?: string; text?: string };
    content_block?: { type?: string; name?: string };
  };
}

/** Returns the thinking text of a thinking_delta event, or null if not one. */
export function thinkingDeltaFrom(event: ThinkingProbe): string | null {
  if (event.type !== 'stream_event') return null;
  if (event.event?.type !== 'content_block_delta') return null;
  const delta = event.event.delta;
  if (delta?.type === 'thinking_delta' && typeof delta.thinking === 'string') {
    return delta.thinking;
  }
  return null;
}

/** True when this event opens a (non-redacted) thinking content block. */
export function isThinkingBlockStart(event: ThinkingProbe): boolean {
  if (event.type !== 'stream_event') return false;
  if (event.event?.type !== 'content_block_start') return false;
  return event.event.content_block?.type === 'thinking';
}
