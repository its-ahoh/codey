import { describe, it, expect } from 'vitest';
import {
  piArgs,
  piToolEvent,
  piTextFromMessage,
  piTokensFrom,
  classifyPiRunResult,
  type PiEvent,
} from './pi';
import { piEffortArgs } from './effort';

// The shapes asserted here come from pi's documented JSON mode
// (packages/coding-agent/docs/json.md in earendil-works/pi-mono): a `session`
// header line, then AgentEvent records. Everything the adapter reads is
// pinned here so a wire change shows up as a test failure rather than a
// silently empty answer.

describe('piArgs', () => {
  const base = { prompt: 'hello', agent: 'pi' as const };

  it('always asks for the JSON event stream and puts the prompt last', () => {
    const args = piArgs(base);
    expect(args.slice(0, 2)).toEqual(['--mode', 'json']);
    expect(args[args.length - 1]).toBe('hello');
  });

  it('resumes a session by id', () => {
    expect(piArgs({ ...base, resumeSessionId: 'abc-123' })).toContain('--session');
    expect(piArgs({ ...base, resumeSessionId: 'abc-123' })).toContain('abc-123');
  });

  it('passes the model through', () => {
    const args = piArgs({ ...base, model: { model: 'anthropic/claude-opus-4', provider: 'anthropic' } });
    expect(args).toContain('--model');
    expect(args).toContain('anthropic/claude-opus-4');
  });

  it('maps effort onto --thinking', () => {
    expect(piArgs({ ...base, effort: 'high' })).toContain('--thinking');
    expect(piArgs({ ...base, effort: 'high' })).toContain('high');
    expect(piEffortArgs('max')).toEqual(['--thinking', 'max']);
    expect(piEffortArgs(undefined)).toEqual([]);
  });

  it('only overrides project trust when permissions are skipped', () => {
    expect(piArgs({ ...base, skipPermissions: true })).toContain('-a');
    expect(piArgs(base)).not.toContain('-a');
  });
});

describe('piToolEvent', () => {
  it('opens a tool on tool_execution_start', () => {
    const observed = piToolEvent({
      type: 'tool_execution_start',
      toolCallId: 'call_1',
      toolName: 'bash',
      args: { command: 'ls' },
    });
    expect(observed).toEqual({
      tool: 'bash',
      key: 'call_1',
      phase: 'start',
      input: { command: 'ls' },
    });
  });

  it('closes a tool on tool_execution_end and reports failure', () => {
    const ok = piToolEvent({ type: 'tool_execution_end', toolCallId: 'c', toolName: 'read', result: 'x', isError: false });
    expect(ok).toMatchObject({ phase: 'end', status: 'completed', output: 'x' });

    const bad = piToolEvent({ type: 'tool_execution_end', toolCallId: 'c', toolName: 'read', result: 'boom', isError: true });
    expect(bad).toMatchObject({ phase: 'end', status: 'failed' });
  });

  it('ignores events that are not tool execution', () => {
    expect(piToolEvent({ type: 'turn_start' })).toBeNull();
    // A tool event without a name carries nothing worth showing.
    expect(piToolEvent({ type: 'tool_execution_start', toolCallId: 'c' })).toBeNull();
  });
});

describe('piTextFromMessage', () => {
  it('keeps only the assistant text blocks', () => {
    const text = piTextFromMessage({
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'hmm' },
        { type: 'text', text: 'Hello ' },
        { type: 'toolCall', id: 't', name: 'bash', arguments: {} },
        { type: 'text', text: 'world' },
      ],
    });
    expect(text).toBe('Hello world');
  });

  it('ignores non-assistant messages', () => {
    expect(piTextFromMessage({ role: 'user', content: [{ type: 'text', text: 'hi' }] })).toBe('');
    expect(piTextFromMessage(undefined)).toBe('');
  });
});

describe('piTokensFrom', () => {
  it('sums usage across assistant messages and derives the total', () => {
    let tokens = piTokensFrom(undefined, {
      input: 10, output: 5, cacheRead: 2, cacheWrite: 1, totalTokens: 15,
    });
    tokens = piTokensFrom(tokens, {
      input: 20, output: 7, cacheRead: 3, cacheWrite: 0, reasoning: 4, totalTokens: 27,
    });
    expect(tokens).toEqual({
      input: 30,
      output: 12,
      total: 42,
      reasoning: 4,
      cache: { read: 5, write: 1 },
    });
  });

  it('leaves tokens unset when pi reports no usage', () => {
    expect(piTokensFrom(undefined, undefined)).toBeUndefined();
  });
});

describe('classifyPiRunResult', () => {
  it('prefers the final message over streamed deltas', () => {
    const cls = classifyPiRunResult({ code: 0, finalText: 'final', streamedText: 'partial', stderr: '' });
    expect(cls.success).toBe(true);
    expect(cls.output).toBe('final');
  });

  it('falls back to streamed text when no message_end arrived', () => {
    const cls = classifyPiRunResult({ code: 0, finalText: '', streamedText: 'partial', stderr: '' });
    expect(cls.success).toBe(true);
    expect(cls.output).toBe('partial');
  });

  it('fails on a provider error even when pi exits 0', () => {
    const cls = classifyPiRunResult({
      code: 0,
      finalText: '',
      streamedText: 'some text',
      stderr: '',
      errorMessage: 'API Error: 401 Unauthorized',
    });
    expect(cls.success).toBe(false);
    expect(cls.error).toContain('401');
  });

  it('reports a non-zero exit with stderr', () => {
    const cls = classifyPiRunResult({ code: 1, finalText: '', streamedText: '', stderr: 'pi: no such model' });
    expect(cls.success).toBe(false);
    expect(cls.error).toContain('no such model');
  });

  it('never claims success on an empty run', () => {
    const cls = classifyPiRunResult({ code: 0, finalText: '', streamedText: '', stderr: '' });
    expect(cls.success).toBe(false);
    expect(cls.error).toBeTruthy();
  });
});

describe('the session header', () => {
  it('is the line the adapter reads the resumable session id from', () => {
    const header: PiEvent = JSON.parse('{"type":"session","version":3,"id":"uuid-1","timestamp":"t","cwd":"/tmp"}');
    expect(header.type).toBe('session');
    expect(header.id).toBe('uuid-1');
  });
});
