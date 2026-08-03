/**
 * Sentence segmentation and per-conversation digest caching for the
 * `/voice/converse` streaming pipeline. Both pieces are pure/in-memory so
 * they're unit-testable without a live TTS provider or agent run.
 */

/**
 * NDJSON event shapes for `POST /voice/converse`. See
 * docs/superpowers/specs/voice-converse-spec.md for the full event-order
 * contract (`start → ack? → (command | (text/audio pairs)*) → done | error`).
 */
export type VoiceConverseEvent =
  | { type: 'start'; tts: 'server' | 'client' }
  | { type: 'ack'; text: string }
  | { type: 'command'; action: string; result: string }
  | { type: 'text'; seq: number; text: string }
  | { type: 'audio'; seq: number; format: 'mp3'; dataBase64: string }
  | { type: 'done'; ttsDegraded?: boolean }
  | { type: 'error'; message: string };

/**
 * Splits digest text into sentence-sized chunks for sentence-aligned
 * text/audio streaming. Handles both English (.!?) and Chinese (。！？) and
 * newline breaks in one pass; keeps the terminating punctuation on the
 * sentence it closes, so spoken segments read naturally.
 */
const TERMINATOR_CLASS = '.!?。！？';
const SENTENCE_RE = new RegExp(
  `[^${TERMINATOR_CLASS}]+[${TERMINATOR_CLASS}]+|[^${TERMINATOR_CLASS}]+$`,
  'g',
);

export function splitIntoSentences(text: string): string[] {
  const normalized = text.trim();
  if (!normalized) return [];

  const sentences: string[] = [];
  for (const line of normalized.split(/\n+/)) {
    const trimmedLine = line.trim();
    if (!trimmedLine) continue;
    const matches = trimmedLine.match(SENTENCE_RE) ?? [];
    for (const m of matches) {
      const s = m.trim();
      if (s) sentences.push(s);
    }
  }
  return sentences;
}

const TERMINATORS = new Set([...TERMINATOR_CLASS]);

/**
 * Incremental counterpart to `splitIntoSentences`, for a digest that arrives
 * as a token stream. Feed it deltas; it hands back sentences the moment each
 * one is provably complete, so synthesis can start on sentence one while the
 * rest of the summary is still being generated.
 *
 * A trailing terminator is held back rather than emitted, because a stream
 * can split a run like "…" or "?!" across chunks — releasing early would cut
 * a sentence in the wrong place. `flush()` releases whatever is left.
 */
export class SentenceAccumulator {
  private buf = '';

  /** Appends `chunk` and returns any sentences that are now complete. */
  push(chunk: string): string[] {
    this.buf += chunk;
    const out: string[] = [];
    let start = 0;
    let i = 0;

    while (i < this.buf.length) {
      const ch = this.buf[i];
      if (ch === '\n') {
        const s = this.buf.slice(start, i).trim();
        if (s) out.push(s);
        i += 1;
        start = i;
        continue;
      }
      if (TERMINATORS.has(ch)) {
        let end = i;
        while (end < this.buf.length && TERMINATORS.has(this.buf[end])) end += 1;
        // Run touches the end of the buffer — it may continue in the next
        // chunk, so hold everything from `start` and wait for more.
        if (end >= this.buf.length) break;
        const s = this.buf.slice(start, end).trim();
        if (s) out.push(s);
        i = end;
        start = end;
        continue;
      }
      i += 1;
    }

    this.buf = this.buf.slice(start);
    return out;
  }

  /** Releases the trailing partial sentence. Call once the stream ends. */
  flush(): string[] {
    const rest = this.buf;
    this.buf = '';
    return splitIntoSentences(rest);
  }
}

/**
 * Caches the full (pre-digest) agent reply per conversationId so a later
 * "more detail" follow-up can re-speak the details without re-running the
 * agent. Process-local and unbounded by design — voice conversations are
 * short-lived and the gateway restarts clear it naturally.
 */
export class ConversationDigestCache {
  private cache = new Map<string, string>();

  set(conversationId: string, fullText: string): void {
    this.cache.set(conversationId, fullText);
  }

  get(conversationId: string): string | undefined {
    return this.cache.get(conversationId);
  }

  clear(conversationId: string): void {
    this.cache.delete(conversationId);
  }
}
