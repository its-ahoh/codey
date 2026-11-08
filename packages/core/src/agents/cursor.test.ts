import { describe, it, expect } from 'vitest';
import {
  cursorArgs,
  cursorModelEnv,
  isCursorModel,
  cursorToolEvent,
  cursorToolFromCall,
  cursorChecklistFromEvent,
  cursorTextFromEvent,
  cursorTokensFrom,
  classifyCursorRunResult,
  type CursorEvent,
} from './cursor';
import { CODING_AGENTS, isApiType, modelFitsApiType } from '../types';
import { AgentFactory } from './index';

// Event shapes below mirror what cursor-agent 2026.05.01 writes in
// `--output-format stream-json` mode, read from the shipped CLI bundle. They
// are pinned so a wire change shows up here rather than as an empty answer.

describe('cursorArgs', () => {
  const base = { prompt: 'hello' };

  it('runs headless, streams JSON, trusts the workspace, prompt last', () => {
    const args = cursorArgs(base);
    expect(args.slice(0, 4)).toEqual(['-p', '--output-format', 'stream-json', '--trust']);
    expect(args[args.length - 1]).toMatch(/^hello\n\n<codey-runtime-policy>/);
  });

  it('never asks for partial output, which would double every word', () => {
    expect(cursorArgs(base)).not.toContain('--stream-partial-output');
  });

  it('resumes by chat id', () => {
    const args = cursorArgs({ ...base, resumeSessionId: 'chat-1' });
    expect(args[args.indexOf('--resume') + 1]).toBe('chat-1');
  });

  it('passes the model and workspace through', () => {
    const args = cursorArgs({
      ...base,
      model: { model: 'sonnet-4', provider: 'cursor' },
      context: { workingDir: '/tmp/proj' } as never,
    });
    expect(args[args.indexOf('--model') + 1]).toBe('sonnet-4');
    expect(args[args.indexOf('--workspace') + 1]).toBe('/tmp/proj');
  });

  it('forces approvals only when permissions are skipped', () => {
    expect(cursorArgs({ ...base, skipPermissions: true })).toContain('--force');
    expect(cursorArgs(base)).not.toContain('--force');
  });

  it('a tool policy means read-only ask mode and never --force', () => {
    const args = cursorArgs({ ...base, toolPolicy: 'read-only', skipPermissions: true });
    expect(args[args.indexOf('--mode') + 1]).toBe('ask');
    expect(args).not.toContain('--force');
  });
});

describe('cursor models and keys', () => {
  const cursorModel = { model: 'gpt-5', provider: 'cursor', apiType: 'cursor' as const, apiKey: 'key_test_123' };

  it('passes a cursor model name and its key', () => {
    expect(cursorArgs({ prompt: 'x', model: cursorModel })).toContain('gpt-5');
    expect(cursorModelEnv(cursorModel)).toEqual({ CURSOR_API_KEY: 'key_test_123' });
  });

  it('never puts the key on the command line', () => {
    expect(cursorArgs({ prompt: 'x', model: cursorModel }).join(' ')).not.toContain('key_test_123');
  });

  it('trusts a bare typed model name but sends no key', () => {
    const bare = { model: 'sonnet-4', provider: 'cursor' };
    expect(isCursorModel(bare)).toBe(true);
    expect(cursorModelEnv(bare)).toEqual({});
  });

  it('ignores a model meant for another CLI', () => {
    for (const apiType of ['anthropic', 'openai', 'all'] as const) {
      const other = { model: 'claude-sonnet-4-5', provider: 'anthropic', apiType, apiKey: 'sk-other' };
      expect(cursorArgs({ prompt: 'x', model: other })).not.toContain('--model');
      expect(cursorModelEnv(other)).toEqual({});
    }
  });
});

describe('modelFitsApiType with cursor', () => {
  it('cursor models and the cursor agent only fit each other', () => {
    expect(isApiType('cursor')).toBe(true);
    expect(modelFitsApiType('cursor', 'cursor')).toBe(true);
    expect(modelFitsApiType('all', 'cursor')).toBe(false);
    expect(modelFitsApiType('anthropic', 'cursor')).toBe(false);
    expect(modelFitsApiType('cursor', 'all')).toBe(false);
    expect(modelFitsApiType('cursor', 'anthropic')).toBe(false);
    expect(modelFitsApiType('cursor', undefined)).toBe(false);
  });

  it('leaves the other rules as they were', () => {
    expect(modelFitsApiType('all', 'anthropic')).toBe(true);
    expect(modelFitsApiType('openai', 'all')).toBe(true);
    expect(modelFitsApiType('openai', 'anthropic')).toBe(false);
    expect(modelFitsApiType('anthropic', undefined)).toBe(true);
  });
});

describe('cursorToolFromCall', () => {
  it('reads the JSON oneof form and shortens the name', () => {
    expect(cursorToolFromCall({ shellToolCall: { args: { command: 'ls' } } }))
      .toEqual({ key: 'shellToolCall', name: 'shell', args: { command: 'ls' }, result: undefined });
  });

  it('reads the raw protobuf form', () => {
    expect(cursorToolFromCall({ tool: { case: 'readToolCall', value: { args: { path: 'a.ts' } } } }))
      .toMatchObject({ key: 'readToolCall', name: 'read', args: { path: 'a.ts' } });
  });

  it('reads the generic function form with string arguments', () => {
    expect(cursorToolFromCall({ function: { name: 'custom', arguments: '{"x":1}' } }))
      .toMatchObject({ name: 'custom', args: { x: 1 } });
  });

  it('keeps an MCP tool its own identity', () => {
    const tool = cursorToolFromCall({
      mcpToolCall: { args: { providerIdentifier: 'github', toolName: 'list_prs', args: { repo: 'x' } } },
    });
    expect(tool).toMatchObject({ name: 'github.list_prs', args: { repo: 'x' } });
  });

  it('returns null for nothing', () => {
    expect(cursorToolFromCall(undefined)).toBeNull();
    expect(cursorToolFromCall({})).toBeNull();
  });
});

describe('cursorToolEvent', () => {
  it('pairs started and completed by call_id', () => {
    const start: CursorEvent = {
      type: 'tool_call', subtype: 'started', call_id: 'c1',
      tool_call: { readToolCall: { args: { path: 'a.ts' } } },
    };
    const end: CursorEvent = {
      type: 'tool_call', subtype: 'completed', call_id: 'c1',
      tool_call: { readToolCall: { args: { path: 'a.ts' }, result: { success: { content: 'x' } } } },
    };
    expect(cursorToolEvent(start)).toEqual({ tool: 'read', key: 'c1', phase: 'start', input: { path: 'a.ts' } });
    expect(cursorToolEvent(end)).toMatchObject({ tool: 'read', key: 'c1', phase: 'end', status: 'completed' });
  });

  it('marks an error result as failed', () => {
    const end: CursorEvent = {
      type: 'tool_call', subtype: 'completed', call_id: 'c2',
      tool_call: { shellToolCall: { args: { command: 'false' }, result: { error: { message: 'boom' } } } },
    };
    expect(cursorToolEvent(end)?.status).toBe('failed');
  });

  it('ignores non-tool events', () => {
    expect(cursorToolEvent({ type: 'assistant' })).toBeNull();
  });
});

describe('cursorChecklistFromEvent', () => {
  it('normalizes proto status names and drops cancelled items', () => {
    const event: CursorEvent = {
      type: 'tool_call', subtype: 'started', call_id: 't1',
      tool_call: {
        updateTodosToolCall: {
          args: {
            todos: [
              { id: '1', content: 'Write parser', status: 'TODO_STATUS_COMPLETED' },
              { id: '2', content: 'Add tests', status: 'TODO_STATUS_IN_PROGRESS' },
              { id: '3', content: 'Ship it', status: 'TODO_STATUS_PENDING' },
              { id: '4', content: 'Old idea', status: 'TODO_STATUS_CANCELLED' },
            ],
          },
        },
      },
    };
    expect(cursorChecklistFromEvent(event)).toEqual([
      { text: 'Write parser', status: 'completed' },
      { text: 'Add tests', status: 'in_progress' },
      { text: 'Ship it', status: 'pending' },
    ]);
  });

  it('accepts numeric enum values', () => {
    const event: CursorEvent = {
      type: 'tool_call', subtype: 'started',
      tool_call: { updateTodosToolCall: { args: { todos: [{ content: 'A', status: 2 }] } } },
    };
    expect(cursorChecklistFromEvent(event)).toEqual([{ text: 'A', status: 'in_progress' }]);
  });

  it('is null for other tools and for the completed echo', () => {
    expect(cursorChecklistFromEvent({ type: 'tool_call', subtype: 'started', tool_call: { readToolCall: { args: {} } } })).toBeNull();
    expect(cursorChecklistFromEvent({
      type: 'tool_call', subtype: 'completed',
      tool_call: { updateTodosToolCall: { args: { todos: [{ content: 'A' }] } } },
    })).toBeNull();
  });
});

describe('cursorTextFromEvent / cursorTokensFrom', () => {
  it('joins text blocks of an assistant line', () => {
    expect(cursorTextFromEvent({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Hi ' }, { type: 'text', text: 'there' }] },
    })).toBe('Hi there');
    expect(cursorTextFromEvent({ type: 'user', message: { content: 'x' } })).toBe('');
  });

  it('maps usage with cache split out', () => {
    expect(cursorTokensFrom({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 50, cacheWriteTokens: 0 }))
      .toEqual({ input: 100, output: 20, total: 120, cache: { read: 50, write: 0 } });
    expect(cursorTokensFrom(undefined)).toBeUndefined();
  });
});

describe('classifyCursorRunResult', () => {
  it('prefers the result text', () => {
    expect(classifyCursorRunResult({ code: 0, finalText: 'final', streamedText: 'partial', stderr: '' }))
      .toEqual({ success: true, output: 'final', error: undefined });
  });

  it('falls back to streamed segments when no result line came', () => {
    expect(classifyCursorRunResult({ code: 0, streamedText: 'partial', stderr: '' }).output).toBe('partial');
  });

  it('a reported error wins over text', () => {
    const r = classifyCursorRunResult({ code: 0, finalText: 'half', streamedText: '', stderr: '', errorMessage: 'bad' });
    expect(r.success).toBe(false);
    expect(r.error).toBe('bad');
  });

  it('a non-zero exit uses stderr, e.g. not logged in', () => {
    const r = classifyCursorRunResult({ code: 1, streamedText: '', stderr: 'Not logged in\n' });
    expect(r).toMatchObject({ success: false, error: 'Not logged in' });
  });
});

describe('registration', () => {
  it('cursor is a known agent with an adapter', () => {
    expect(CODING_AGENTS).toContain('cursor');
    expect(new AgentFactory().get('cursor')?.name).toBe('cursor');
  });
});
