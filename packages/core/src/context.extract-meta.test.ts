import { describe, it, expect } from 'vitest';
import { ContextManager } from './context';

describe('ContextManager.extractMeta', () => {
  it('pairs the running/done states adapters normalize to', () => {
    const meta = ContextManager.extractMeta({
      states: [
        { source: 'Read', status: 'running', input: { file_path: 'a.ts' } },
        { source: 'Read', status: 'done', output: 'contents' },
      ],
    }, 'claude-code');
    expect(meta.toolCalls).toEqual([
      { tool: 'Read', input: { file_path: 'a.ts' }, status: 'success', output: 'contents' },
    ]);
  });

  it('accepts a CLI dialect leaking through rather than dropping the call', () => {
    // opencode reports "completed"; before this it matched neither branch and
    // the tool call vanished, leaving the run looking like it did nothing.
    const meta = ContextManager.extractMeta({
      states: [
        { source: 'read', status: 'pending', input: { filePath: 'note.txt' } },
        { source: 'read', status: 'completed', output: 'hello' },
      ],
    }, 'opencode');
    expect(meta.toolCalls).toHaveLength(1);
    expect(meta.toolCalls![0].tool).toBe('read');
  });

  it('records a tool that never reported completion as an error', () => {
    const meta = ContextManager.extractMeta({
      states: [{ source: 'bash', status: 'running', input: { command: 'sleep 100' } }],
    }, 'codex');
    expect(meta.toolCalls).toEqual([
      { tool: 'bash', input: { command: 'sleep 100' }, status: 'error' },
    ]);
  });

  it('derives file changes from the tools that touch files', () => {
    const meta = ContextManager.extractMeta({
      states: [
        { source: 'Write', status: 'running', input: { file_path: 'out/post.md' } },
        { source: 'Write', status: 'completed' },
      ],
    }, 'claude-code');
    expect(meta.filesChanged).toEqual([{ path: 'out/post.md', action: 'create' }]);
  });

  it('leaves toolCalls unset when a run observed nothing', () => {
    expect(ContextManager.extractMeta({}, 'opencode').toolCalls).toBeUndefined();
    expect(ContextManager.extractMeta({ states: [] }, 'opencode').toolCalls).toBeUndefined();
  });
});
