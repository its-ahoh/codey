import { describe, it, expect } from 'vitest';
import { capPromptForArgv, withForegroundPolicy, DEFAULT_MAX_PROMPT_BYTES, maxPromptBytes } from './process-tree';

describe('capPromptForArgv', () => {
  it('leaves a prompt that fits untouched', () => {
    const prompt = 'hello world';
    expect(capPromptForArgv(prompt, 1000)).toBe(prompt);
  });

  it('leaves a prompt exactly at the limit untouched', () => {
    const prompt = 'x'.repeat(1000);
    expect(capPromptForArgv(prompt, 1000)).toBe(prompt);
  });

  it('keeps the result within the byte limit', () => {
    const prompt = 'x'.repeat(50_000);
    const capped = capPromptForArgv(prompt, 4_000);
    expect(Buffer.byteLength(capped, 'utf8')).toBeLessThanOrEqual(4_000);
  });

  it('keeps the head and the tail, drops the middle', () => {
    const prompt = `HEAD_MARKER${'x'.repeat(50_000)}TAIL_MARKER`;
    const capped = capPromptForArgv(prompt, 4_000);
    expect(capped.startsWith('HEAD_MARKER')).toBe(true);
    expect(capped.endsWith('TAIL_MARKER')).toBe(true);
    expect(capped).toContain('elided by Codey');
  });

  it('gives the tail more room than the head', () => {
    const prompt = 'x'.repeat(50_000);
    const capped = capPromptForArgv(prompt, 4_000);
    const [head, tail] = capped.split(/\n\n\[… .* …\]\n\n/);
    expect(tail.length).toBeGreaterThan(head.length);
  });

  it('never splits a multi-byte character', () => {
    const prompt = '中'.repeat(20_000); // lint-allow-non-english: multi-byte boundary fixture
    const capped = capPromptForArgv(prompt, 4_000);
    expect(capped).not.toContain('�');
    expect(Buffer.byteLength(capped, 'utf8')).toBeLessThanOrEqual(4_000);
  });

  it('reports how many bytes it dropped', () => {
    const prompt = 'x'.repeat(50_000);
    const capped = capPromptForArgv(prompt, 4_000);
    const omitted = Number(/… (\d+) bytes elided/.exec(capped)![1]);
    const kept = Buffer.byteLength(capped, 'utf8');
    expect(omitted).toBeGreaterThan(0);
    expect(omitted + kept).toBeGreaterThan(50_000);
  });
});

describe('maxPromptBytes', () => {
  it('falls back to the default when the env override is unusable', () => {
    const prior = process.env.CODEY_MAX_PROMPT_BYTES;
    try {
      process.env.CODEY_MAX_PROMPT_BYTES = 'not-a-number';
      expect(maxPromptBytes()).toBe(DEFAULT_MAX_PROMPT_BYTES);
      process.env.CODEY_MAX_PROMPT_BYTES = '0';
      expect(maxPromptBytes()).toBe(DEFAULT_MAX_PROMPT_BYTES);
      process.env.CODEY_MAX_PROMPT_BYTES = '12345';
      expect(maxPromptBytes()).toBe(12345);
    } finally {
      if (prior === undefined) delete process.env.CODEY_MAX_PROMPT_BYTES;
      else process.env.CODEY_MAX_PROMPT_BYTES = prior;
    }
  });
});

describe('withForegroundPolicy', () => {
  it('caps an oversized prompt but never elides the policy block', () => {
    const prior = process.env.CODEY_MAX_PROMPT_BYTES;
    try {
      process.env.CODEY_MAX_PROMPT_BYTES = '4000';
      const out = withForegroundPolicy('x'.repeat(50_000));
      expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(4000);
      expect(out).toContain('<codey-runtime-policy>');
      expect(out).toContain('</codey-runtime-policy>');
      expect(out).toContain('elided by Codey');
    } finally {
      if (prior === undefined) delete process.env.CODEY_MAX_PROMPT_BYTES;
      else process.env.CODEY_MAX_PROMPT_BYTES = prior;
    }
  });

  it('passes a normal prompt through unchanged', () => {
    const out = withForegroundPolicy('do the thing');
    expect(out.startsWith('do the thing\n\n<codey-runtime-policy>')).toBe(true);
  });
});
