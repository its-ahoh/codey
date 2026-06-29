import { describe, it, expect } from 'vitest';
import { filterBranches, defaultWorktreePath, partitionWorktrees } from './branchPickerModel';

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
