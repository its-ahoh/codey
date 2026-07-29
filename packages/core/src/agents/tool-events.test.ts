import { describe, it, expect } from 'vitest';
import { toolPhaseOf, isFailureStatus, ToolCallCollector } from './tool-events';
import { codexItemAsTool, CODEX_TOOL_ITEMS } from './codex';
import { opencodeToolEvent } from './opencode';
import { StatusUpdate } from '../types';
import { stepsFrom, signatureOf } from '../playbook-induction';

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

describe('codex item events, against a real captured stream', () => {
  // Verbatim from `codex exec --json` (codex-cli 0.145.0, 2026-07-28) for the
  // prompt "Run the shell command 'ls -la' and then read note.txt". Trimmed
  // only in aggregated_output length.
  const CAPTURED = [
    { type: 'thread.started', thread_id: '019fab77-6d2d-7690-927f-85d56a0f8816' },
    { type: 'turn.started' },
    { type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'I will inspect the directory.' } },
    { type: 'item.started', item: { id: 'item_1', type: 'command_execution', command: '/bin/zsh -lc "ls -la"', aggregated_output: '', exit_code: null, status: 'in_progress' } },
    { type: 'item.completed', item: { id: 'item_1', type: 'command_execution', command: '/bin/zsh -lc "ls -la"', aggregated_output: 'total 24\ndrwxr-xr-x 7 ...', exit_code: 0, status: 'completed' } },
    { type: 'item.completed', item: { id: 'item_2', type: 'agent_message', text: 'The directory contains seven entries.' } },
    { type: 'turn.completed', usage: { input_tokens: 40554, output_tokens: 139 } },
  ];

  it('yields exactly one paired tool call and ignores agent messages', () => {
    const updates: StatusUpdate[] = [];
    const tools = new ToolCallCollector(u => updates.push(u));
    for (const event of CAPTURED) {
      if (!event.type.startsWith('item.')) continue;
      const item = event.item!;
      if (!CODEX_TOOL_ITEMS.has(item.type ?? '')) continue;
      const asTool = codexItemAsTool(item);
      if (!asTool) continue;
      tools.record({
        ...asTool,
        key: item.id ?? asTool.tool,
        phase: event.type === 'item.started' ? 'start' : 'end',
        status: item.status,
      });
    }
    tools.finish();

    // Two agent_message items must not become tool calls.
    expect(updates.map(u => u.type)).toEqual(['tool_start', 'tool_end']);
    expect(updates[0].tool).toBe('command_execution');
    expect(updates[0].input).toEqual({ command: '/bin/zsh -lc "ls -la"' });
    expect(updates[1].output).toContain('total 24');
    expect(tools.states.map(s => s.status)).toEqual(['running', 'done']);
  });

  it('gives the trace a procedure the crystallizer can read', () => {
    // "in_progress" must resolve to a start, or the pairing collapses.
    expect(toolPhaseOf('in_progress')).toBe('start');
    expect(toolPhaseOf('completed')).toBe('end');
  });
});

describe('opencode tool_use events, against a real captured stream', () => {
  // Verbatim from `opencode run --format json` (opencode 1.14.18, 2026-07-28)
  // for the prompt "Read the file note.txt and tell me what it says."
  // Note what is NOT here: any event with a "running" status. opencode reports
  // a tool once, already completed.
  const CAPTURED_PARTS = [
    {
      type: 'tool', tool: 'read', callID: 'call_00_BaGBWjXewyuRz9fSIpJN6271',
      state: {
        status: 'completed',
        input: { filePath: '/private/tmp/oc-probe/note.txt' },
        output: '<path>/private/tmp/oc-probe/note.txt</path>\n<content>\n1: hello from probe\n',
      },
    },
    {
      type: 'tool', tool: 'glob', callID: 'call_01_7G7qL5AZ50oFOiauKKRZ6950',
      state: {
        status: 'completed',
        input: { pattern: '**/note.txt', path: '/private/tmp/oc-probe' },
        output: 'Found 1 file(s)\n\n/private/tmp/oc-probe/note.txt',
      },
    },
  ];

  it('reads the call identity, input and output off the part', () => {
    expect(opencodeToolEvent(CAPTURED_PARTS[0])).toEqual({
      tool: 'read',
      key: 'call_00_BaGBWjXewyuRz9fSIpJN6271',
      status: 'completed',
      input: { filePath: '/private/tmp/oc-probe/note.txt' },
      output: expect.stringContaining('hello from probe'),
    });
  });

  it('produces a two-step procedure the crystallizer can cluster on', () => {
    const updates: StatusUpdate[] = [];
    const tools = new ToolCallCollector(u => updates.push(u));
    for (const part of CAPTURED_PARTS) {
      const observed = opencodeToolEvent(part);
      if (observed) tools.record(observed);
    }
    tools.finish();

    // Two completed tools -> two synthesized starts, in order. Before this
    // fix the run contributed nothing at all.
    expect(updates.map(u => `${u.type}:${u.tool}`)).toEqual([
      'tool_start:read', 'tool_end:read', 'tool_start:glob', 'tool_end:glob',
    ]);
    expect(updates[0].input).toEqual({ filePath: '/private/tmp/oc-probe/note.txt' });
    expect(tools.states.map(s => `${s.source}:${s.status}`)).toEqual([
      'read:running', 'read:done', 'glob:running', 'glob:done',
    ]);
  });

  it('ignores a part with no state', () => {
    expect(opencodeToolEvent({ type: 'tool', tool: 'read' })).toBeNull();
  });

  it('reaches the crystallizer as a procedure with argument shapes', () => {
    // End to end: what the chat surface collects from onStatus is what
    // stepsFrom reads. This is the whole point of the fix — before it, an
    // opencode run produced an empty signature and could never cluster.
    const updates: StatusUpdate[] = [];
    const tools = new ToolCallCollector(u => updates.push(u));
    for (const part of CAPTURED_PARTS) {
      const observed = opencodeToolEvent(part);
      if (observed) tools.record(observed);
    }
    const steps = stepsFrom(updates.map(u => ({ tool: u.tool, type: u.type, input: u.input })));
    expect(signatureOf({ runId: 'r', steps })).toEqual(['read', 'glob']);
    expect(steps[0].args).toEqual({ filePath: { kind: 'path', ext: 'txt', depth: 4 } });
    expect(steps[1].args).toEqual({
      // A glob keeps its literal value: "**/note.txt" and "**/*.test.ts" are
      // different searches, and a length bucket would hide that.
      pattern: { kind: 'enum', value: '**/note.txt' },
      // An extensionless directory lands on 'enum', not 'path' — deliberately.
      // Only url and enum can be induced as CONSTANTS, so this is what lets
      // "always the same directory" be baked into a playbook step.
      path: { kind: 'enum', value: '/private/tmp/oc-probe' },
    });
  });
});
