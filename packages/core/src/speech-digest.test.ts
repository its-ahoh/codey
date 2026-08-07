import { describe, it, expect } from 'vitest';
import { needsDigest, buildSpeechDigestPrompt, stripForSpeech, AUTO_DIGEST_THRESHOLD } from './speech-digest';

describe('needsDigest', () => {
  it('never digests in full verbosity', () => {
    expect(needsDigest('x'.repeat(10_000), 'full')).toBe(false);
  });

  it('always digests non-empty text in digest verbosity', () => {
    expect(needsDigest('short', 'digest')).toBe(true);
    expect(needsDigest('', 'digest')).toBe(false);
  });

  it('digests only long replies in auto verbosity', () => {
    expect(needsDigest('short reply', 'auto')).toBe(false);
    expect(needsDigest('x'.repeat(AUTO_DIGEST_THRESHOLD + 1), 'auto')).toBe(true);
    expect(needsDigest('x'.repeat(AUTO_DIGEST_THRESHOLD), 'auto')).toBe(false);
  });
});

describe('buildSpeechDigestPrompt', () => {
  it('embeds the source text and asks for spoken prose', () => {
    const prompt = buildSpeechDigestPrompt('Fixed the bug in foo.ts by adding a null check.');
    expect(prompt).toContain('Fixed the bug in foo.ts by adding a null check.');
    expect(prompt).toContain('spoken summary');
    expect(prompt.toLowerCase()).toContain('no markdown');
  });

  it('instructs the model to keep the source language', () => {
    const prompt = buildSpeechDigestPrompt('修复了 foo.ts 里的空指针问题。'); // lint-allow-non-english
    expect(prompt.toLowerCase()).toContain('same language');
    expect(prompt).toContain('修复了 foo.ts 里的空指针问题。'); // lint-allow-non-english
  });
});

describe('stripForSpeech', () => {
  it('replaces fenced code with a marker instead of reading it aloud', () => {
    const out = stripForSpeech('Fixed it:\n```ts\nconst a = 1\n```\nAll good.');
    expect(out).not.toContain('const');
    expect(out).toContain('(code)');
    expect(out).toContain('All good.');
  });

  it('drops heading, list and emphasis markers but keeps the words', () => {
    expect(stripForSpeech('## Summary')).toBe('Summary');
    expect(stripForSpeech('- one\n- two')).toBe('one\ntwo');
    expect(stripForSpeech('this is **very** important')).toBe('this is very important');
    expect(stripForSpeech('a `flag` here')).toBe('a flag here');
  });

  it('keeps link text and drops the URL', () => {
    expect(stripForSpeech('see [the docs](https://example.com/x)')).toBe('see the docs');
    expect(stripForSpeech('go to https://example.com/x now')).toContain('(link)');
  });

  it('removes file paths, which are unreadable aloud', () => {
    expect(stripForSpeech('changed packages/core/src/a.ts today')).toBe('changed today');
  });

  it('leaves ordinary prose untouched', () => {
    const prose = '我改了三个文件，主要逻辑在网关里。'; // lint-allow-non-english
    expect(stripForSpeech(prose)).toBe(prose);
  });
});
