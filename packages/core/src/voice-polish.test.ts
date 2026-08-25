import { describe, it, expect } from 'vitest';
import {
  buildVoicePolishPrompt,
  needsPolish,
  sanitizePolished,
  MIN_POLISH_LENGTH,
} from './voice-polish';

describe('needsPolish', () => {
  it('skips text short enough to be a command', () => {
    expect(needsPolish('git status')).toBe(false);
    expect(needsPolish('undo')).toBe(false);
    expect(needsPolish('   ')).toBe(false);
  });

  it('accepts anything longer than the floor', () => {
    expect(needsPolish('x'.repeat(MIN_POLISH_LENGTH + 1))).toBe(true);
    expect(needsPolish('so I I want to add a button here')).toBe(true);
  });
});

describe('buildVoicePolishPrompt', () => {
  it('carries the transcript and forbids the destructive rewrites', () => {
    const prompt = buildVoicePolishPrompt('so um I want a button');
    expect(prompt).toContain('so um I want a button');
    expect(prompt).toContain('Do not translate');
    expect(prompt).toContain('Do not summarize');
    expect(prompt).toContain('Do not answer');
  });
});

describe('sanitizePolished', () => {
  const original = 'so um I I want to to add a button here right';

  it('keeps a plausible cleanup', () => {
    expect(sanitizePolished('So I want to add a button here.', original))
      .toBe('So I want to add a button here.');
  });

  it('returns null when there is nothing to fall back from', () => {
    expect(sanitizePolished(null, original)).toBeNull();
    expect(sanitizePolished('', original)).toBeNull();
    expect(sanitizePolished('   ', original)).toBeNull();
  });

  it('returns null when the model changed nothing, so the caller keeps the original', () => {
    expect(sanitizePolished(original, original)).toBeNull();
    expect(sanitizePolished(`  ${original}  `, original)).toBeNull();
  });

  it('unwraps a fenced block', () => {
    expect(sanitizePolished('```\nSo I want to add a button here.\n```', original))
      .toBe('So I want to add a button here.');
    expect(sanitizePolished('```text\nSo I want to add a button here.\n```', original))
      .toBe('So I want to add a button here.');
  });

  it('strips a narrating preamble', () => {
    expect(sanitizePolished("Here's the cleaned text:\nSo I want to add a button.", original))
      .toBe('So I want to add a button.');
    expect(sanitizePolished('Cleaned text: So I want to add a button.', original))
      .toBe('So I want to add a button.');
  });

  it('unquotes a wholly quoted result', () => {
    expect(sanitizePolished('"So I want to add a button here."', original))
      .toBe('So I want to add a button here.');
  });

  it('leaves quotation marks that belong to the sentence', () => {
    const quoted = 'He said "hello" and then he said "goodbye" to everyone';
    expect(sanitizePolished('He said "hello", and then he said "goodbye" to everyone.', quoted))
      .toBe('He said "hello", and then he said "goodbye" to everyone.');
  });

  it('rejects a summary', () => {
    expect(sanitizePolished('Add a button.', original)).toBeNull();
  });

  it('rejects an answer or an explanation', () => {
    const answer = 'Sure! To add a button you will want to create a new component, '
      + 'import it into the page, and then wire up its click handler to the action you need.';
    expect(sanitizePolished(answer, original)).toBeNull();
  });

  it('rejects a translation in either direction', () => {
    const zh = '所以我想在这里加一个按钮，对吧'; // lint-allow-non-english
    expect(sanitizePolished(zh, original)).toBeNull();
    expect(sanitizePolished('So I want to add a button here, right?', zh)).toBeNull();
  });

  it('keeps a Chinese cleanup of Chinese speech', () => {
    const spoken = '那个我想就是说在这里加一个按钮然后呢让它可以点击'; // lint-allow-non-english
    const cleaned = '我想在这里加一个按钮，然后让它可以点击。'; // lint-allow-non-english
    expect(sanitizePolished(cleaned, spoken)).toBe(cleaned);
  });

  it('keeps a cleanup of mixed-language speech', () => {
    const spoken = 'we need to to fix the the bug in ChatTab dot t s x today';
    const cleaned = 'We need to fix the bug in ChatTab.tsx today.';
    expect(sanitizePolished(cleaned, spoken)).toBe(cleaned);
  });
});
