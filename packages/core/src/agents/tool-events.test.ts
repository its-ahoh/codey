import { describe, it, expect } from 'vitest';
import { toolPhaseOf, isFailureStatus, ToolCallCollector } from './tool-events';
import { codexItemAsTool, CODEX_TOOL_ITEMS } from './codex';
import { StatusUpdate } from '../types';

describe('toolPhaseOf', () => {
  it('maps the dialects the three CLIs actually use', () => {
    for (const status of ['running', 'pending', 'in_progress', 'started']) {
      expect(toolPhaseOf(status), status).toBe('start');
    }
    for (const status of ['done', 'completed', 'success', 'failed', 'error', 'cancelled']) {
      expect(toolPhaseOf(status), status).toBe('end');
    }
  });

  it('is case- and whitespace-insensitive', () => {
    expect(toolPhaseOf(' Running ')).toBe('start');
    expect(toolPhaseOf('COMPLETED')).toBe('end');
  });

  it('treats an unknown status as terminal and no status as nothing', () => {
    // A tool heard about exactly once is likelier finished than still running.
    expect(toolPhaseOf('weird-new-word')).toBe('end');
    expect(toolPhaseOf(undefined)).toBeNull();
  });

  it('recognizes failure separately from completion', () => {
    expect(isFailureStatus('failed')).toBe(true);
    expect(isFailureStatus('error')).toBe(true);
    expect(isFailureStatus('completed')).toBe(false);
    expect(isFailureStatus(undefined)).toBe(false);
  });
});

describe('ToolCallCollector', () => {
  function collect(): { updates: StatusUpdate[]; tools: ToolCallCollector } {
    const updates: StatusUpdate[] = [];
    return { updates, tools: new ToolCallCollector(u => updates.push(u)) };
  }

  it('synthesizes a start for a CLI that only reports finished tools', () => {
    // This is the opencode/codex case, and the whole reason induction saw
    // nothing from them: consumers key a procedure off tool_start.
    const { updates, tools } = collect();
    tools.record({ tool: 'read', status: 'completed', input: { filePath: 'note.txt' }, output: 'hello' });
    expect(updates.map(u => u.type)).toEqual(['tool_start', 'tool_end']);
    expect(updates[0].tool).toBe('read');
    expect(updates[0].input).toEqual({ filePath: 'note.txt' });
    expect(tools.states.map(s => s.status)).toEqual(['running', 'done']);
  });

  it('does not double-count a tool reported at both ends', () => {
    const { updates, tools } = collect();
    tools.record({ tool: 'bash', status: 'running', key: 'call-1', input: { command: 'ls' } });
    tools.record({ tool: 'bash', status: 'completed', key: 'call-1', output: 'note.txt' });
    expect(updates.map(u => u.type)).toEqual(['tool_start', 'tool_end']);
    expect(tools.states).toHaveLength(2);
  });

  it('keeps concurrent calls to the same tool apart by key', () => {
    const { updates, tools } = collect();
    tools.record({ tool: 'read', status: 'running', key: 'a' });
    tools.record({ tool: 'read', status: 'running', key: 'b' });
    tools.record({ tool: 'read', status: 'completed', key: 'a' });
    tools.record({ tool: 'read', status: 'completed', key: 'b' });
    expect(updates.map(u => u.type)).toEqual(['tool_start', 'tool_start', 'tool_end', 'tool_end']);
  });

  it('respects an explicit phase over the status word', () => {
    const { updates, tools } = collect();
    // codex item.started can carry status "in_progress" or nothing at all.
    tools.record({ tool: 'command_execution', phase: 'start', key: 'i1' });
    expect(updates.map(u => u.type)).toEqual(['tool_start']);
  });

  it('marks a failed tool in the end message', () => {
    const { updates, tools } = collect();
    tools.record({ tool: 'bash', status: 'failed', output: 'boom' });
    expect(updates[1].message).toContain('failed');
  });

  it('summarizes scalar input into the start message and skips structures', () => {
    const { updates, tools } = collect();
    tools.record({ tool: 'edit', status: 'completed', input: { path: 'a.ts', nested: { x: 1 }, n: 3 } });
    expect(updates[0].message).toBe('edit(path=a.ts, n=3)');
  });

  it('stringifies a non-string output for the status update but keeps states raw', () => {
    const { updates, tools } = collect();
    tools.record({ tool: 'fetch', status: 'completed', output: { ok: true } });
    expect(updates[1].output).toBe('{"ok":true}');
    expect(tools.states[1].output).toEqual({ ok: true });
  });

  it('closes tools still open when the process exits', () => {
    const { tools } = collect();
    tools.record({ tool: 'sleep', status: 'running', key: 'x' });
    tools.finish();
    expect(tools.states.map(s => s.status)).toEqual(['running', 'done']);
  });

  it('works with no onStatus listener (the channel surface)', () => {
    const tools = new ToolCallCollector();
    expect(() => tools.record({ tool: 'read', status: 'completed' })).not.toThrow();
    expect(tools.states).toHaveLength(2);
  });
});

describe('codexItemAsTool', () => {
  it('maps the item types that represent doing something', () => {
    expect([...CODEX_TOOL_ITEMS].sort())
      .toEqual(['command_execution', 'file_change', 'mcp_tool_call', 'web_search']);

    expect(codexItemAsTool({ type: 'command_execution', command: 'ls -la', aggregated_output: 'a\nb' }))
      .toEqual({ tool: 'command_execution', input: { command: 'ls -la' }, output: 'a\nb' });

    expect(codexItemAsTool({ type: 'file_change', path: 'src/x.ts', changes: [{ kind: 'edit' }] }))
      .toEqual({ tool: 'file_change', input: { path: 'src/x.ts' }, output: [{ kind: 'edit' }] });

    expect(codexItemAsTool({ type: 'web_search', query: 'codex json events' }))
      .toEqual({ tool: 'web_search', input: { query: 'codex json events' } });
  });

  it('keeps an MCP tool call\'s own identity', () => {
    // "server.tool" is the distinctive name; collapsing every MCP call to
    // "mcp_tool_call" would erase what makes the procedure recognizable.
    expect(codexItemAsTool({ type: 'mcp_tool_call', server: 'browser', tool: 'navigate', arguments: { url: 'https://x.com' } }))
      .toEqual({ tool: 'browser.navigate', input: { url: 'https://x.com' }, output: undefined });
    expect(codexItemAsTool({ type: 'mcp_tool_call', tool: 'navigate' })!.tool).toBe('navigate');
    expect(codexItemAsTool({ type: 'mcp_tool_call' })!.tool).toBe('mcp_tool_call');
  });

  it('ignores items that are not tool activity', () => {
    expect(codexItemAsTool({ type: 'agent_message' })).toBeNull();
    expect(codexItemAsTool({ type: 'reasoning' })).toBeNull();
    expect(codexItemAsTool({})).toBeNull();
  });
});
