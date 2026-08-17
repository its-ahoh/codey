import { describe, expect, it } from 'vitest';
import type { ChatWorkspace, DisposableWorktreeOutcome } from '../chat-worktree';
import { closeSandbox, openSandbox, sandboxLogLine, sandboxWorktreeName, SandboxOps } from './sandbox';

const AT = Date.parse('2026-08-17T09:30:05');
const RUN = '2f6c1b90-8b1e-4f0e-9f0a-1c2d3e4f5a6b';

const workspace = (over: Partial<ChatWorkspace> = {}): ChatWorkspace => ({
  name: 'auto-triage-20260817-093005-2f6c1b',
  repositoryRoot: '/repo',
  worktreePath: '/repo/.worktrees/auto-triage-20260817-093005-2f6c1b',
  workingDir: '/repo/.worktrees/auto-triage-20260817-093005-2f6c1b',
  baseCommit: 'abcdef1234567890',
  createdAt: AT,
  ...over,
});

function makeOps(over: Partial<SandboxOps> = {}) {
  const logs: string[] = [];
  let bound: ChatWorkspace | undefined;
  const ops: SandboxOps = {
    provision: async () => workspace(),
    bind: (w) => { bound = w; },
    current: () => bound,
    discard: async () => 'removed',
    unbind: () => { bound = undefined; },
    log: (detail) => { logs.push(detail); },
    now: () => AT,
    ...over,
  };
  return { ops, logs, bound: () => bound };
}

describe('sandboxWorktreeName', () => {
  it('combines the automation name, local time and a run token', () => {
    expect(sandboxWorktreeName('Issue Triage', RUN, AT)).toBe('auto-Issue-Triage-20260817-093005-2f6c1b');
  });

  it('stays unique for same-second runs of same-named automations', () => {
    const a = sandboxWorktreeName('Nightly', 'aaaaaa11-0000-0000-0000-000000000000', AT);
    const b = sandboxWorktreeName('Nightly', 'bbbbbb22-0000-0000-0000-000000000000', AT);
    expect(a).not.toBe(b);
  });

  it('truncates a long name but keeps the timestamp and token intact', () => {
    const name = sandboxWorktreeName('A'.repeat(120), RUN, AT);
    expect(name).toBe(`auto-${'A'.repeat(24)}-20260817-093005-2f6c1b`);
  });

  it('still produces a usable name for an automation titled in non-ASCII', () => {
    // The slug collapses to nothing, so the stamp and token carry the name.
    expect(sandboxWorktreeName('每日巡检', RUN, AT)).toBe('auto-20260817-093005-2f6c1b'); // lint-allow-non-english
  });
});

describe('openSandbox', () => {
  it('binds the provisioned checkout and logs its base commit', async () => {
    const provisioned: string[] = [];
    const { ops, logs, bound } = makeOps({
      provision: async (name) => { provisioned.push(name); return workspace(); },
    });

    const result = await openSandbox(ops, 'Issue Triage', RUN);

    expect(provisioned).toEqual(['auto-Issue-Triage-20260817-093005-2f6c1b']);
    expect(bound()).toBe(result);
    expect(logs[0]).toContain('created /repo/.worktrees/auto-triage-20260817-093005-2f6c1b at abcdef12');
  });

  it('fails the run when the checkout cannot be created', async () => {
    // Falling back to the shared checkout would silently run unisolated.
    const { ops, logs } = makeOps({ provision: async () => { throw new Error('Isolated worktrees require a Git workspace'); } });
    await expect(openSandbox(ops, 'Issue Triage', RUN)).rejects.toThrow(/Git workspace/);
    expect(logs).toEqual([]);
  });
});

describe('closeSandbox', () => {
  it('unbinds the chat after the checkout is removed', async () => {
    const { ops, logs, bound } = makeOps();
    await openSandbox(ops, 'Issue Triage', RUN);

    await closeSandbox(ops);

    expect(bound()).toBeUndefined();
    expect(logs[1]).toContain('removed');
    expect(logs[1]).toContain('no changes');
  });

  it('reports a retained branch when the run committed', async () => {
    const { ops, logs, bound } = makeOps({ discard: async () => 'branch-kept' as DisposableWorktreeOutcome });
    await openSandbox(ops, 'Issue Triage', RUN);

    await closeSandbox(ops);

    expect(bound()).toBeUndefined();
    expect(logs[1]).toContain('branch "auto-triage-20260817-093005-2f6c1b" kept');
  });

  it('keeps the binding when uncommitted changes were left behind', async () => {
    const { ops, logs, bound } = makeOps({ discard: async () => 'kept' as DisposableWorktreeOutcome });
    const opened = await openSandbox(ops, 'Issue Triage', RUN);

    await closeSandbox(ops);

    // Nothing was removed, so forgetting it would strand the user's changes.
    expect(bound()).toBe(opened);
    expect(logs[1]).toContain('uncommitted changes were left in place');
  });

  it('reports a teardown failure without throwing at the run', async () => {
    const { ops, logs, bound } = makeOps({ discard: async () => { throw new Error('git worktree remove failed'); } });
    const opened = await openSandbox(ops, 'Issue Triage', RUN);

    await expect(closeSandbox(ops)).resolves.toBeUndefined();

    expect(bound()).toBe(opened);
    expect(logs[1]).toContain('could not remove');
    expect(logs[1]).toContain('git worktree remove failed');
  });

  it('does nothing when no checkout is bound', async () => {
    const { ops, logs } = makeOps();
    await closeSandbox(ops);
    expect(logs).toEqual([]);
  });
});

describe('sandboxLogLine', () => {
  it('matches the shape of the run log event lines', () => {
    expect(sandboxLogLine(Date.parse('2026-08-17T01:30:05.000Z'), 'removed /tmp/x — no changes'))
      .toBe('[2026-08-17T01:30:05.000Z] sandbox removed /tmp/x — no changes');
  });
});
