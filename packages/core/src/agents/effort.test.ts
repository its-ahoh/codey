import { describe, it, expect } from 'vitest';
import {
  claudeEffortArgs,
  codexEffortArgs,
  opencodeEffortArgs,
  isEffortRejection,
} from './effort';

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
