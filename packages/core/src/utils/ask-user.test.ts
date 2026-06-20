import { describe, it, expect } from 'vitest';
import { parseAskUser, parseAsk, normalizeWorkerOutput } from './ask-user';

describe('parseAskUser', () => {
  it('returns null when no marker is present', () => {
    expect(parseAskUser('hello world\nno marker here')).toBeNull();
  });

  it('parses a standalone marker line', () => {
    const out = parseAskUser('[ASK_USER]: should I use postgres or sqlite?');
    expect(out).toEqual({
      preamble: '',
      question: 'should I use postgres or sqlite?',
    });
  });

  it('parses a marker after preamble content', () => {
    const text = [
      'I started looking at the schema.',
      'Two options exist.',
      '[ASK_USER]: which database should I target?',
      'I will wait.',
    ].join('\n');
    const out = parseAskUser(text);
    expect(out).toEqual({
      preamble: 'I started looking at the schema.\nTwo options exist.',
      question: 'which database should I target?',
    });
  });

  it('uses the first marker when multiple exist', () => {
    const text = '[ASK_USER]: first?\n[ASK_USER]: second?';
    const out = parseAskUser(text);
    expect(out?.question).toBe('first?');
  });

  it('tolerates leading whitespace before the marker', () => {
    const out = parseAskUser('   [ASK_USER]:   trim me  ');
    expect(out).toEqual({ preamble: '', question: 'trim me' });
  });

  it('returns null when the question is empty after trim', () => {
    expect(parseAskUser('[ASK_USER]:    ')).toBeNull();
  });
});

describe('parseAsk', () => {
  it('parses [ASK_USER]: as kind="user"', () => {
    const out = parseAsk('[ASK_USER]: foo?');
    expect(out).toEqual({ kind: 'user', preamble: '', question: 'foo?' });
  });

  it('parses [ASK: name]: as kind="team" with target', () => {
    const out = parseAsk('[ASK: alice]: did you finish the schema?');
    expect(out).toEqual({
      kind: 'team',
      target: 'alice',
      preamble: '',
      question: 'did you finish the schema?',
    });
  });

  it('preserves preamble before a team marker', () => {
    const text = 'looked at the code\n[ASK: bob]: what about TLS?';
    const out = parseAsk(text);
    expect(out).toEqual({
      kind: 'team',
      target: 'bob',
      preamble: 'looked at the code',
      question: 'what about TLS?',
    });
  });

  it('returns the earlier of two markers', () => {
    const out = parseAsk('[ASK: alice]: q1\n[ASK_USER]: q2');
    expect(out?.kind).toBe('team');
    expect((out as any).target).toBe('alice');
  });

  it('skips a malformed [ASK: ]: line and finds a later valid one', () => {
    const out = parseAsk('[ASK: ]: blank target\n[ASK_USER]: real question');
    expect(out?.kind).toBe('user');
  });

  it('returns null when no marker is present', () => {
    expect(parseAsk('plain output, no markers')).toBeNull();
  });

  it('tolerates whitespace inside the [ASK: name] brackets', () => {
    const out = parseAsk('[ASK :  carol  ]:  hello?');
    expect(out).toEqual({
      kind: 'team',
      target: 'carol',
      preamble: '',
      question: 'hello?',
    });
  });
});

describe('parseAskUser (choice variant)', () => {
  it('parses two options', () => {
    const out = parseAskUser('[ASK_USER:choice]: merge into main? | yes | no');
    expect(out).toEqual({
      preamble: '',
      question: 'merge into main?',
      options: ['yes', 'no'],
    });
  });

  it('parses many options and trims whitespace', () => {
    const out = parseAskUser('[ASK_USER:choice]: pick db?  |  postgres  | sqlite |  mysql ');
    expect(out?.options).toEqual(['postgres', 'sqlite', 'mysql']);
  });

  it('caps at 8 options', () => {
    const opts = Array.from({ length: 12 }, (_, i) => `o${i}`).join(' | ');
    const out = parseAskUser(`[ASK_USER:choice]: q? | ${opts}`);
    expect(out?.options).toHaveLength(8);
    expect(out?.options?.[0]).toBe('o0');
    expect(out?.options?.[7]).toBe('o7');
  });

  it('skips empty option segments', () => {
    const out = parseAskUser('[ASK_USER:choice]: q? | a | | b |   ');
    expect(out?.options).toEqual(['a', 'b']);
  });

  it('degrades to plain text when fewer than 2 valid options remain', () => {
    const out = parseAskUser('[ASK_USER:choice]: only one? | yes');
    expect(out).toEqual({ preamble: '', question: 'only one? | yes' });
    expect((out as any).options).toBeUndefined();
  });

  it('degrades when no pipe present', () => {
    const out = parseAskUser('[ASK_USER:choice]: just a question');
    expect(out).toEqual({ preamble: '', question: 'just a question' });
  });

  it('preserves preamble for choice marker', () => {
    const text = 'I looked into it.\n[ASK_USER:choice]: which? | a | b';
    const out = parseAskUser(text);
    expect(out?.preamble).toBe('I looked into it.');
    expect(out?.options).toEqual(['a', 'b']);
  });
});

describe('normalizeWorkerOutput', () => {
  const INVOKE_BLOCK = `<invoke name="AskUserQuestion">
<parameter name="questions">[{"question": "How do you want to integrate?", "header": "Integrate", "multiSelect": false, "label": "false", "options": [{"label": "Merge into my branch", "description": "Merge and rebuild."}, {"label": "Run from the worktree", "description": "Build in isolation."}, {"label": "Open a PR", "description": "Review first."}]}]</parameter>
</invoke>`;

  it('converts an invoke block with multiple options into [ASK_USER:choice]', () => {
    const result = normalizeWorkerOutput(INVOKE_BLOCK);
    expect(result).toBe('[ASK_USER:choice]: How do you want to integrate? | Merge into my branch | Run from the worktree | Open a PR');
  });

  it('passes through output that has no invoke block unchanged', () => {
    const plain = 'Just some plain text with no XML.';
    expect(normalizeWorkerOutput(plain)).toBe(plain);
  });

  it('is picked up by parseAsk when embedded in preamble text', () => {
    const output = `Some preamble.\n${INVOKE_BLOCK}`;
    const result = parseAsk(output);
    expect(result?.kind).toBe('user');
    expect(result?.question).toBe('How do you want to integrate?');
    if (result?.kind === 'user') {
      expect(result.options).toEqual(['Merge into my branch', 'Run from the worktree', 'Open a PR']);
    }
  });

  it('degrades to [ASK_USER] when only one option is present', () => {
    const block = `<invoke name="AskUserQuestion">
<parameter name="questions">[{"question": "Continue?", "options": [{"label": "Yes"}]}]</parameter>
</invoke>`;
    expect(normalizeWorkerOutput(block)).toBe('[ASK_USER]: Continue?');
  });

  it('returns empty string when JSON is missing question field', () => {
    const block = `<invoke name="AskUserQuestion">
<parameter name="questions">[{"options": [{"label": "a"}, {"label": "b"}]}]</parameter>
</invoke>`;
    expect(normalizeWorkerOutput(block)).toBe('');
  });
});

describe('parseAsk (choice variant)', () => {
  it('returns user kind with options', () => {
    const out = parseAsk('[ASK_USER:choice]: q? | a | b');
    expect(out).toEqual({ kind: 'user', preamble: '', question: 'q?', options: ['a', 'b'] });
  });

  it('does not treat [ASK: name:choice] as a team-choice variant', () => {
    const out = parseAsk('[ASK: alice:choice]: q? | a | b');
    expect(out?.kind).toBe('team');
    if (out?.kind === 'team') {
      expect(out.target).toBe('alice:choice');
      expect(out.question).toBe('q? | a | b');
      expect((out as any).options).toBeUndefined();
    }
  });
});
