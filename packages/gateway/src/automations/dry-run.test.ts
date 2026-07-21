import { describe, it, expect, vi } from 'vitest';
import { DryRunManager } from './dry-run';
import type { AutomationDraft } from '@codey/core';

const draft = (over: Partial<AutomationDraft> = {}): AutomationDraft => ({
  name: 'N',
  target: { kind: 'prompt', workspaceName: 'default' },
  brief: 'Post {{count}} items.',
  params: { count: '5' },
  ...over,
});

const flush = () => new Promise<void>(res => setTimeout(res, 0));

describe('DryRunManager', () => {
  it('executes the rendered no-act prompt in the target workspace and reports the verdict', async () => {
    const execute = vi.fn().mockResolvedValue('agent output');
    const classify = vi.fn().mockResolvedValue({ status: 'clean' as const });
    const onResult = vi.fn();
    const mgr = new DryRunManager({ execute, classify, teamContext: () => undefined, onResult });

    mgr.start('s1', draft());
    await flush();

    expect(execute).toHaveBeenCalledTimes(1);
    const [target, prompt] = execute.mock.calls[0];
    expect(target).toEqual({ kind: 'prompt', workspaceName: 'default' });
    expect(prompt).toMatch(/DRY RUN/);
    expect(prompt).toContain('Post 5 items.');
    expect(classify).toHaveBeenCalledWith('agent output');
    expect(onResult).toHaveBeenCalledWith('s1', { status: 'clean' });
  });

  it('inlines team context for team targets and never team-dispatches', async () => {
    const execute = vi.fn().mockResolvedValue('out');
    const teamContext = vi.fn(() => '{"members":["a"]}');
    const onResult = vi.fn();
    const mgr = new DryRunManager({
      execute, classify: vi.fn().mockResolvedValue({ status: 'clean' as const }), teamContext, onResult,
    });

    mgr.start('s1', draft({ target: { kind: 'team', teamName: 'news', workspaceName: 'blog' } }));
    await flush();

    expect(teamContext).toHaveBeenCalledWith('blog', 'news');
    expect(execute.mock.calls[0][0]).toEqual({ kind: 'team', teamName: 'news', workspaceName: 'blog' });
    expect(execute.mock.calls[0][1]).toContain('{"members":["a"]}');
  });

  it('passes prompt agent/model overrides through to execution', async () => {
    const execute = vi.fn().mockResolvedValue('out');
    const mgr = new DryRunManager({
      execute, classify: vi.fn().mockResolvedValue({ status: 'clean' as const }),
      teamContext: () => undefined, onResult: vi.fn(),
    });
    const target = { kind: 'prompt' as const, workspaceName: 'default', agent: 'codex' as const, model: 'gpt-x' };
    mgr.start('s1', draft({ target }));
    await flush();
    expect(execute.mock.calls[0][0]).toEqual(target);
  });

  it('maps execute/classify failures to an error verdict, never gaps', async () => {
    const onResult = vi.fn();
    const mgr = new DryRunManager({
      execute: vi.fn().mockRejectedValue(new Error('agent timed out')),
      classify: vi.fn().mockResolvedValue({ status: 'clean' as const }),
      teamContext: () => undefined,
      onResult,
    });
    mgr.start('s1', draft());
    await flush();
    expect(onResult).toHaveBeenCalledWith('s1', { status: 'error', message: 'agent timed out' });
  });

  it('an incomplete draft yields an error verdict', async () => {
    const onResult = vi.fn();
    const mgr = new DryRunManager({
      execute: vi.fn().mockResolvedValue('out'),
      classify: vi.fn().mockResolvedValue({ status: 'clean' as const }),
      teamContext: () => undefined,
      onResult,
    });
    mgr.start('s1', { name: 'N' }); // no target/brief
    await flush();
    expect(onResult).toHaveBeenCalledWith('s1', expect.objectContaining({ status: 'error' }));
  });

  it('a newer start supersedes an in-flight run - the stale verdict is dropped', async () => {
    let releaseFirst!: (v: string) => void;
    const execute = vi.fn()
      .mockImplementationOnce(() => new Promise<string>(res => { releaseFirst = res; }))
      .mockResolvedValueOnce('second output');
    const onResult = vi.fn();
    const mgr = new DryRunManager({
      execute,
      classify: vi.fn().mockImplementation(async (o: string) => ({ status: 'gaps' as const, questions: [o] })),
      teamContext: () => undefined, onResult,
    });

    mgr.start('s1', draft());
    mgr.start('s1', draft({ brief: 'v2' }));
    await flush();
    releaseFirst('first output');
    await flush();

    expect(onResult).toHaveBeenCalledTimes(1);
    expect(onResult).toHaveBeenCalledWith('s1', { status: 'gaps', questions: ['second output'] });
  });

  it('a run surviving a cancel-then-restart cannot deliver a stale verdict', async () => {
    let releaseFirst!: (v: string) => void;
    let releaseSecond!: (v: string) => void;
    const execute = vi.fn()
      .mockImplementationOnce(() => new Promise<string>(res => { releaseFirst = res; }))
      .mockImplementationOnce(() => new Promise<string>(res => { releaseSecond = res; }));
    const onResult = vi.fn();
    const mgr = new DryRunManager({
      execute,
      classify: vi.fn().mockImplementation(async (o: string) => ({ status: 'gaps' as const, questions: [o] })),
      teamContext: () => undefined, onResult,
    });
    mgr.start('s1', draft());
    mgr.cancel('s1');
    mgr.start('s1', draft({ brief: 'v2' }));
    releaseFirst('first output'); // stale run resolves while the new run is in flight
    await flush();
    releaseSecond('second output');
    await flush();
    expect(onResult).toHaveBeenCalledTimes(1);
    expect(onResult).toHaveBeenCalledWith('s1', { status: 'gaps', questions: ['second output'] });
  });

  it('cancel drops an in-flight result', async () => {
    let release!: (v: string) => void;
    const onResult = vi.fn();
    const mgr = new DryRunManager({
      execute: vi.fn().mockImplementation(() => new Promise<string>(res => { release = res; })),
      classify: vi.fn().mockResolvedValue({ status: 'clean' as const }),
      teamContext: () => undefined, onResult,
    });
    mgr.start('s1', draft());
    mgr.cancel('s1');
    release('out');
    await flush();
    expect(onResult).not.toHaveBeenCalled();
  });

  it('independent sessions do not interfere', async () => {
    const onResult = vi.fn();
    const mgr = new DryRunManager({
      execute: vi.fn().mockResolvedValue('out'),
      classify: vi.fn().mockResolvedValue({ status: 'clean' as const }),
      teamContext: () => undefined, onResult,
    });
    mgr.start('s1', draft());
    mgr.start('s2', draft());
    await flush();
    expect(onResult).toHaveBeenCalledTimes(2);
  });
});
