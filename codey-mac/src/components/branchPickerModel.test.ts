import { describe, it, expect } from 'vitest';
import { compactWorktreePath, currentFirst, defaultWorktreePath, filterBranches, partitionWorktrees } from './branchPickerModel';

describe('filterBranches', () => {
  it('returns all when query empty', () => {
    expect(filterBranches(['main', 'dev'], '')).toEqual(['main', 'dev']);
  });
  it('is case-insensitive substring match', () => {
    expect(filterBranches(['Main', 'feature/x', 'dev'], 'fe')).toEqual(['feature/x']);
  });
});

describe('defaultWorktreePath', () => {
  it('builds an in-repo .codey/worktrees path with sanitized branch', () => {
    expect(defaultWorktreePath('/home/u/repo', 'feat/cool thing'))
      .toBe('/home/u/repo/.codey/worktrees/feat-cool-thing');
  });
  it('strips a trailing slash from the repo path', () => {
    expect(defaultWorktreePath('/home/u/repo/', 'x'))
      .toBe('/home/u/repo/.codey/worktrees/x');
  });
});

describe('partitionWorktrees', () => {
  it('splits main from the rest', () => {
    const { main, others } = partitionWorktrees([
      { branch: 'main', path: '/r', isMain: true },
      { branch: 'feat', path: '/r2', isMain: false },
    ]);
    expect(main?.branch).toBe('main');
    expect(others.map(w => w.branch)).toEqual(['feat']);
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
