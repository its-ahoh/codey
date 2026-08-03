import { describe, it, expect } from 'vitest';
import { needsDigest, buildSpeechDigestPrompt, AUTO_DIGEST_THRESHOLD } from './speech-digest';

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
    const prompt = buildSpeechDigestPrompt('修复了 foo.ts 里的空指针问题。');
    expect(prompt.toLowerCase()).toContain('same language');
    expect(prompt).toContain('修复了 foo.ts 里的空指针问题。');
  });
});
