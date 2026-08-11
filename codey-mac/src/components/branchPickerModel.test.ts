import { describe, it, expect } from 'vitest';
import { compactWorktreePath, currentFirst, describePullResult, filterBranches } from './branchPickerModel';

describe('describePullResult', () => {
  it('reports how many commits arrived', () => {
    expect(describePullResult({ ok: true, updated: 3, upstream: 'origin/main' }))
      .toBe('Pulled 3 commits from origin/main');
    expect(describePullResult({ ok: true, updated: 1, upstream: 'origin/main' }))
      .toBe('Pulled 1 commit from origin/main');
  });

  it('says up to date when nothing changed', () => {
    expect(describePullResult({ ok: true, updated: 0 })).toBe('Already up to date');
  });

  it('explains each blocked reason', () => {
    expect(describePullResult({ ok: false, reason: 'no-upstream' })).toMatch(/no upstream/i);
    expect(describePullResult({ ok: false, reason: 'dirty' })).toMatch(/commit or stash/i);
    expect(describePullResult({ ok: false, reason: 'diverged' })).toMatch(/diverged/i);
  });

  it('falls back to the first line of an unclassified error', () => {
    expect(describePullResult({ ok: false, error: 'fatal: could not read\nmore detail' }))
      .toBe('fatal: could not read');
    expect(describePullResult({ ok: false })).toBe('Could not sync');
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
