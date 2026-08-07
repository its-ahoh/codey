import { describe, it, expect } from 'vitest';
import { splitIntoSentences, ConversationDigestCache, SentenceAccumulator } from './voice-converse';

describe('SentenceAccumulator', () => {
  it('releases a sentence as soon as it is complete', () => {
    const acc = new SentenceAccumulator();
    expect(acc.push('I fixed ')).toEqual([]);
    expect(acc.push('three files. The main')).toEqual(['I fixed three files.']);
    expect(acc.push(' logic is in the gateway.')).toEqual([]);
    expect(acc.flush()).toEqual(['The main logic is in the gateway.']);
  });

  it('handles Chinese terminators', () => {
    const acc = new SentenceAccumulator();
    expect(acc.push('改完了。细节')).toEqual(['改完了。']); // lint-allow-non-english
    expect(acc.push('在屏幕上。')).toEqual([]); // lint-allow-non-english
    expect(acc.flush()).toEqual(['细节在屏幕上。']); // lint-allow-non-english
  });

  it('holds back a terminator run that may continue in the next chunk', () => {
    const acc = new SentenceAccumulator();
    // '.' at the buffer end could be the start of '...' — must not release yet.
    expect(acc.push('Wait.')).toEqual([]);
    // Once the full run is known, it stays attached to the sentence it closes.
    expect(acc.push('..then go. Done.')).toEqual(['Wait...', 'then go.']);
    expect(acc.flush()).toEqual(['Done.']);
  });

  it('treats a newline as a hard sentence break even without punctuation', () => {
    const acc = new SentenceAccumulator();
    expect(acc.push('First line\nsecond')).toEqual(['First line']);
    expect(acc.flush()).toEqual(['second']);
  });

  it('emits nothing for whitespace-only input and flushes empty', () => {
    const acc = new SentenceAccumulator();
    expect(acc.push('   \n  ')).toEqual([]);
    expect(acc.flush()).toEqual([]);
  });

  it('agrees with splitIntoSentences when fed one character at a time', () => {
    const text = 'Fixed it. 两个文件改好了！细节在屏幕上？好。'; // lint-allow-non-english
    const acc = new SentenceAccumulator();
    const streamed: string[] = [];
    for (const ch of text) streamed.push(...acc.push(ch));
    streamed.push(...acc.flush());
    expect(streamed).toEqual(splitIntoSentences(text));
  });
});

describe('splitIntoSentences', () => {
  it('splits English sentences on terminal punctuation', () => {
    expect(splitIntoSentences('I fixed three files. The main logic is in the gateway.')).toEqual([
      'I fixed three files.',
      'The main logic is in the gateway.',
    ]);
  });

  it('splits Chinese sentences on Chinese punctuation', () => {
    expect(splitIntoSentences('我改了三个文件。主要逻辑在网关里。')).toEqual([ // lint-allow-non-english
      '我改了三个文件。', // lint-allow-non-english
      '主要逻辑在网关里。', // lint-allow-non-english
    ]);
  });

  it('splits on newlines even without terminal punctuation', () => {
    expect(splitIntoSentences('line one\nline two')).toEqual(['line one', 'line two']);
  });

  it('keeps trailing text without punctuation as its own sentence', () => {
    expect(splitIntoSentences('done for now')).toEqual(['done for now']);
  });

  it('returns an empty array for empty or whitespace-only input', () => {
    expect(splitIntoSentences('')).toEqual([]);
    expect(splitIntoSentences('   ')).toEqual([]);
  });

  it('treats consecutive punctuation (ellipsis) as one sentence boundary', () => {
    expect(splitIntoSentences('Wait... really?')).toEqual(['Wait...', 'really?']);
  });
});

describe('ConversationDigestCache', () => {
  it('stores and retrieves a full reply by conversationId', () => {
    const cache = new ConversationDigestCache();
    cache.set('conv-1', 'the full detailed reply');
    expect(cache.get('conv-1')).toBe('the full detailed reply');
  });

  it('returns undefined for an unknown conversationId', () => {
    const cache = new ConversationDigestCache();
    expect(cache.get('missing')).toBeUndefined();
  });

  it('overwrites a previous entry for the same conversationId', () => {
    const cache = new ConversationDigestCache();
    cache.set('conv-1', 'first reply');
    cache.set('conv-1', 'second reply');
    expect(cache.get('conv-1')).toBe('second reply');
  });

  it('clears an entry by conversationId', () => {
    const cache = new ConversationDigestCache();
    cache.set('conv-1', 'reply');
    cache.clear('conv-1');
    expect(cache.get('conv-1')).toBeUndefined();
  });
});
