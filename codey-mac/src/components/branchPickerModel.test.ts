import { describe, it, expect } from 'vitest';
import { compactWorktreePath, currentFirst, describePullResult, filterBranches } from './branchPickerModel';

describe('describePullResult', () => {
  it('reports how many commits arrived', () => {
    expect(describePullResult({ ok: true, updated: 3, upstream: 'origin/main' }))
      .toEqual({ tone: 'ok', text: 'Pulled 3 commits from origin/main' });
    expect(describePullResult({ ok: true, updated: 1, upstream: 'origin/main' }))
      .toEqual({ tone: 'ok', text: 'Pulled 1 commit from origin/main' });
  });

  it('says up to date when nothing changed', () => {
    expect(describePullResult({ ok: true, updated: 0 })).toEqual({ tone: 'ok', text: 'Already up to date' });
  });

  it('explains each blocked reason as a warning', () => {
    expect(describePullResult({ ok: false, reason: 'no-upstream' }))
      .toEqual({ tone: 'warn', text: expect.stringMatching(/no upstream/i) });
    expect(describePullResult({ ok: false, reason: 'dirty' }))
      .toEqual({ tone: 'warn', text: expect.stringMatching(/commit or stash/i) });
    expect(describePullResult({ ok: false, reason: 'diverged' }))
      .toEqual({ tone: 'warn', text: expect.stringMatching(/diverged/i) });
  });

  it('falls back to the first line of an unclassified error', () => {
    expect(describePullResult({ ok: false, error: 'fatal: could not read\nmore detail' }))
      .toEqual({ tone: 'error', text: 'fatal: could not read' });
    expect(describePullResult({ ok: false })).toEqual({ tone: 'error', text: 'Could not sync' });
  });
});

describe('filterBranches', () => {
  it('returns all when query empty', () => {
    expect(filterBranches(['main', 'dev'], '')).toEqual(['main', 'dev']);
  });
  it('is case-insensitive substring match', () => {
    expect(filterBranches(['Main', 'feature/x', 'dev'], 'fe')).toEqual(['feature/x']);
  });
});

describe('workspace identity labels', () => {
  it('keeps the identifying tail of a long worktree path', () => {
    expect(compactWorktreePath('/Users/jack/.codey/worktrees/chat-1842'))
      .toBe('…/.codey/worktrees/chat-1842');
  });

  it('drops the opaque chat-<uuid> directory of a legacy worktree path', () => {
    expect(compactWorktreePath('/Users/jack/projects/demo/.worktrees/chat-00000000-0000-4000-8000-000000000000/feature-auth'))
      .toBe('…/demo/.worktrees/feature-auth');
  });

  it('leaves short paths intact and handles an empty path', () => {
    expect(compactWorktreePath('/repo/worktree')).toBe('/repo/worktree');
    expect(compactWorktreePath('')).toBe('—');
  });
});

describe('currentFirst', () => {
  it('puts the current item first and preserves the remaining order', () => {
    expect(currentFirst(['main', 'feature', 'release'], item => item === 'feature'))
      .toEqual(['feature', 'main', 'release']);
  });

  it('leaves the list unchanged when the current item is already first or absent', () => {
    const list = ['main', 'feature'];
    expect(currentFirst(list, item => item === 'main')).toBe(list);
    expect(currentFirst(list, item => item === 'missing')).toBe(list);
  });
});
