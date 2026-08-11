import { describe, it, expect } from 'vitest';
import {
  claudeEffortArgs,
  codexEffortArgs,
  opencodeEffortArgs,
  isEffortRejection,
  shouldDegradeEffort,
  withDegradeNotice,
} from './effort';
import type { AgentResponse } from '../types';

// The real error text codex emits when the API rejects the level. Captured from
// `codex exec -c model_reasoning_effort="bogus"` against codex v0.145.0.
const REAL_REJECTION =
  `ERROR: {"type":"error","error":{"type":"invalid_request_error","message":` +
  `"[ReasoningEffortParam] [reasoning.effort] [invalid_enum_value] Invalid value: 'max'. ` +
  `Supported values are: 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', and 'max'."}}`;

describe('argv builders', () => {
  it('emits nothing when effort is unset', () => {
    expect(claudeEffortArgs(undefined)).toEqual([]);
    expect(codexEffortArgs(undefined)).toEqual([]);
    expect(opencodeEffortArgs(undefined)).toEqual([]);
  });

  it('emits each agent flag verbatim', () => {
    expect(claudeEffortArgs('xhigh')).toEqual(['--effort', 'xhigh']);
    expect(codexEffortArgs('xhigh')).toEqual(['-c', 'model_reasoning_effort="xhigh"']);
    expect(opencodeEffortArgs('xhigh')).toEqual(['--variant', 'xhigh']);
  });
});

describe('isEffortRejection', () => {
  it('detects the real codex rejection for the effort that was passed', () => {
    expect(isEffortRejection(REAL_REJECTION, 'max')).toBe(true);
  });

  it('does not fire when the rejected value is a different effort', () => {
    // The run passed 'low' but the error quotes 'max' — this is some other
    // request's error text, not ours.
    expect(isEffortRejection(REAL_REJECTION, 'low')).toBe(false);
  });

  it('does not fire on invalid_enum_value alone', () => {
    expect(isEffortRejection("[invalid_enum_value] Invalid value: 'max'.", 'max')).toBe(false);
  });

  it('does not fire on reasoning.effort alone', () => {
    expect(isEffortRejection('adjusting reasoning.effort for max throughput', 'max')).toBe(false);
  });

  it('does not fire on empty text', () => {
    expect(isEffortRejection('', 'max')).toBe(false);
  });
});

describe('shouldDegradeEffort', () => {
  it('is false when no effort was passed', () => {
    // Nothing to degrade to — a run that never sent the flag can't have been
    // rejected for it, whatever the output happens to contain.
    expect(shouldDegradeEffort({ effort: undefined }, REAL_REJECTION)).toBe(false);
  });

  it('is false when this is already the retry', () => {
    // The guard that makes the degrade at most one hop deep.
    expect(shouldDegradeEffort({ effort: 'max', __effortRetried: true }, REAL_REJECTION)).toBe(false);
  });

  it('is false when the text is not a rejection', () => {
    expect(shouldDegradeEffort({ effort: 'max' }, 'All done. Wrote 3 files.')).toBe(false);
  });

  it('is true on the real rejection text for the effort that was passed', () => {
    expect(shouldDegradeEffort({ effort: 'max' }, REAL_REJECTION)).toBe(true);
  });
});

describe('withDegradeNotice', () => {
  const failed: AgentResponse = {
    success: false,
    output: 'connection reset by peer',
    error: 'connection reset by peer',
    duration: 4,
  };

  it('leaves a FAILED retry completely untouched', () => {
    // Prepending "reran successfully with the default effort" on top of a
    // failure would tell the user the opposite of what happened.
    const result = withDegradeNotice('max', failed);
    expect(result).toEqual(failed);
    expect(result.output).toBe('connection reset by peer');
    expect(result.output).not.toContain('default effort');
  });

  it('prepends the notice on a successful retry and preserves the other fields', () => {
    const succeeded: AgentResponse = {
      success: true,
      output: 'Refactored the parser.',
      duration: 12,
      tokens: { input: 100, output: 50, total: 150 },
      sessionId: 'thread-abc',
    };

    const result = withDegradeNotice('max', succeeded);

    expect(result.output).toBe(
      "> Effort `max` isn't accepted by the current codex model — reran with the model's default effort.\n\n"
      + 'Refactored the parser.',
    );
    expect(result.success).toBe(true);
    expect(result.duration).toBe(12);
    expect(result.tokens).toEqual({ input: 100, output: 50, total: 150 });
    expect(result.sessionId).toBe('thread-abc');
    // The input response is not mutated in place.
    expect(succeeded.output).toBe('Refactored the parser.');
  });
});
