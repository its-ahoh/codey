import { describe, it, expect } from 'vitest';
import {
  applyClaudeForegroundGuard,
  classifyClaudeRunResult,
  extractClaudeBackgroundTask,
  extractClaudeToolResults,
} from './claude-code';

// The claude CLI reports API-level failures (402 Insufficient Balance, session
// limits, unknown models) as a stream-json `result` event with `is_error: true`
// and the message in `result`. Some of those (session limits, billing errors)
// still exit with code 0, so the adapter must treat the `is_error` flag as the
// authoritative failure signal — otherwise the gateway's runWithFallback chain
// never engages and the user just sees the raw API error as a "success".

describe('classifyClaudeRunResult', () => {
  it('classifies an API error result as failure even when the CLI exits 0', () => {
    const cls = classifyClaudeRunResult({
      code: 0,
      result: 'API Error: 402 Insufficient Balance',
      streamedText: '',
      stderr: '',
      resultIsError: true,
      hasUserQuestion: false,
    });

    expect(cls.success).toBe(false);
    expect(cls.error).toContain('402 Insufficient Balance');
  });

  it('keeps a clean result a success', () => {
    const cls = classifyClaudeRunResult({
      code: 0,
      result: 'ok',
      streamedText: '',
      stderr: '',
      resultIsError: false,
      hasUserQuestion: false,
    });

    expect(cls.success).toBe(true);
    expect(cls.output).toBe('ok');
  });

  it('falls back to streamed text when there is no result event', () => {
    const cls = classifyClaudeRunResult({
      code: 0,
      result: '',
      streamedText: 'ok',
      stderr: '',
      resultIsError: false,
      hasUserQuestion: false,
    });

    expect(cls.success).toBe(true);
    expect(cls.output).toBe('ok');
  });

  it('prefers the API error message over stderr noise for a flagged error', () => {
    const cls = classifyClaudeRunResult({
      code: 1,
      result: 'API Error: 402 Insufficient Balance',
      streamedText: '',
      stderr: '⚠ claude.ai connectors are disabled…',
      resultIsError: true,
      hasUserQuestion: false,
    });

    expect(cls.success).toBe(false);
    expect(cls.error).toContain('402 Insufficient Balance');
    expect(cls.error).not.toContain('connectors');
  });

  it('still treats a non-zero exit without an is_error flag as a failure', () => {
    const cls = classifyClaudeRunResult({
      code: 2,
      result: 'partial output',
      streamedText: '',
      stderr: '',
      resultIsError: false,
      hasUserQuestion: false,
    });

    expect(cls.success).toBe(false);
    expect(cls.error).toContain('code 2');
  });

  it('keeps an AskUserQuestion result a success', () => {
    const cls = classifyClaudeRunResult({
      code: 0,
      result: '{"question":"Continue?"}',
      streamedText: '',
      stderr: '',
      resultIsError: false,
      hasUserQuestion: true,
    });

    expect(cls.success).toBe(true);
  });
});

describe('extractClaudeToolResults', () => {
  it('extracts current CLI user-message tool_result blocks', () => {
    expect(extractClaudeToolResults({
      type: 'user',
      message: {
        content: [{
          type: 'tool_result',
          tool_use_id: 'tool-1',
          content: 'build passed',
        }],
      },
    })).toEqual([{
      toolUseId: 'tool-1', text: 'build passed', isError: undefined, backgroundTask: undefined,
    }]);
  });

  it('joins structured result content and preserves failures', () => {
    expect(extractClaudeToolResults({
      type: 'user',
      message: {
        content: [{
          type: 'tool_result',
          tool_use_id: 'tool-2',
          is_error: true,
          content: [
            { type: 'text', text: 'exit code 1' },
            { type: 'text', text: 'compile failed' },
          ],
        }],
      },
    })).toEqual([{
      toolUseId: 'tool-2',
      text: 'exit code 1\ncompile failed',
      isError: true,
      backgroundTask: undefined,
    }]);
  });

  it('retains support for legacy top-level tool_result events', () => {
    expect(extractClaudeToolResults({
      type: 'tool_result',
      tool_use_id: 'tool-3',
      content: [{ type: 'text', text: 'ok' }],
    })).toEqual([{ toolUseId: 'tool-3', text: 'ok', isError: undefined, backgroundTask: undefined }]);
  });

  it('retains support for user events with top-level result fields', () => {
    expect(extractClaudeToolResults({
      type: 'user',
      tool_use_id: 'tool-4',
      content: [{ type: 'text', text: 'ok' }],
    })).toEqual([{ toolUseId: 'tool-4', text: 'ok', isError: undefined, backgroundTask: undefined }]);
  });

  it('ignores ordinary user messages', () => {
    expect(extractClaudeToolResults({
      type: 'user',
      message: { content: [{ type: 'text', text: 'hello' }] },
    })).toEqual([]);
  });
});

describe('applyClaudeForegroundGuard', () => {
  it('disables background tasks and aligns Bash with the owning turn', () => {
    const env: NodeJS.ProcessEnv = {};
    applyClaudeForegroundGuard(env, 60_000);
    expect(env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS).toBe('1');
    expect(env.BASH_DEFAULT_TIMEOUT_MS).toBe('54000');
    expect(env.BASH_MAX_TIMEOUT_MS).toBe('54000');
  });

  it('does not allow extraEnv to bypass the lifecycle guard', () => {
    const env: NodeJS.ProcessEnv = { CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '0' };
    applyClaudeForegroundGuard(env);
    expect(env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS).toBe('1');
  });

  it('preserves explicit foreground Bash timeout tuning', () => {
    const env: NodeJS.ProcessEnv = {
      BASH_DEFAULT_TIMEOUT_MS: '300000',
      BASH_MAX_TIMEOUT_MS: '600000',
    };
    applyClaudeForegroundGuard(env, 60_000);
    expect(env.BASH_DEFAULT_TIMEOUT_MS).toBe('300000');
    expect(env.BASH_MAX_TIMEOUT_MS).toBe('600000');
  });
});

describe('extractClaudeBackgroundTask', () => {
  it('parses a timeout-driven background task and output path', () => {
    expect(extractClaudeBackgroundTask(
      'Command did not complete within its 120s timeout and was moved to the background (ID: b4mm0k9c7). Output is being written to: /private/tmp/claude/tasks/b4mm0k9c7.output. You will be notified when it completes.',
    )).toEqual({ id: 'b4mm0k9c7', outputPath: '/private/tmp/claude/tasks/b4mm0k9c7.output' });
  });

  it('parses an explicitly backgrounded command', () => {
    expect(extractClaudeBackgroundTask('Command running in background with ID: abc123.'))
      .toEqual({ id: 'abc123' });
  });

  it('ignores ordinary tool output', () => {
    expect(extractClaudeBackgroundTask('build passed')).toBeUndefined();
  });

  it('marks normalized tool results that detached', () => {
    const output = 'Command running in background with ID: task-7.';
    expect(extractClaudeToolResults({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'tool-7', content: output }] },
    })).toEqual([{
      toolUseId: 'tool-7',
      text: output,
      isError: undefined,
      backgroundTask: { id: 'task-7' },
    }]);
  });
});
