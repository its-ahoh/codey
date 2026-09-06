import { describe, it, expect } from 'vitest';
import { parseWorkerMentions } from './worker-mentions';

const isWorker = (n: string) => ['alice', 'bob', 'Reviewer'].map(s => s.toLowerCase()).includes(n.toLowerCase());
const isTeam = (n: string) => ['release', 'alice'].includes(n.toLowerCase());

describe('parseWorkerMentions', () => {
  it('returns no workers for plain text', () => {
    expect(parseWorkerMentions('fix the tests', isWorker)).toEqual({ workers: [], teams: [], task: 'fix the tests' });
  });

  it('finds a single bare mention and strips the @', () => {
    expect(parseWorkerMentions('@alice fix the tests', isWorker)).toEqual({ workers: ['alice'], teams: [], task: 'alice fix the tests' });
  });

  it('accepts the namespaced worker: form the Mac composer inserts', () => {
    expect(parseWorkerMentions('@worker:alice fix it', isWorker)).toEqual({ workers: ['alice'], teams: [], task: 'alice fix it' });
  });

  it('collects several workers in order of first mention, deduped', () => {
    const r = parseWorkerMentions('@bob then @alice then @bob again', isWorker);
    expect(r.workers).toEqual(['bob', 'alice']);
    expect(r.task).toBe('bob then alice then bob again');
  });

  it('leaves unknown tokens, emails and files alone', () => {
    const r = parseWorkerMentions('@src/app.ts me@example.com @skill:browser @alice', isWorker);
    expect(r.workers).toEqual(['alice']);
    expect(r.task).toBe('@src/app.ts me@example.com @skill:browser alice');
  });

  it('matches case-insensitively and keeps the typed spelling in the task', () => {
    const r = parseWorkerMentions('@reviewer check @Alice', isWorker);
    expect(r.workers).toEqual(['reviewer', 'alice']);
    expect(r.task).toBe('reviewer check Alice');
  });

  it('strips trailing punctuation from the name but keeps it in the text', () => {
    const r = parseWorkerMentions('@alice, @bob: go', isWorker);
    expect(r.workers).toEqual(['alice', 'bob']);
    expect(r.task).toBe('alice, bob: go');
  });

  it('only matches at the start or after whitespace', () => {
    const r = parseWorkerMentions('foo@alice and\n@bob', isWorker);
    expect(r.workers).toEqual(['bob']);
    expect(r.task).toBe('foo@alice and\nbob');
  });

  it('finds a bare team mention when no worker owns the name', () => {
    const r = parseWorkerMentions('@release cut 1.2.0', isWorker, isTeam);
    expect(r.teams).toEqual(['release']);
    expect(r.workers).toEqual([]);
    expect(r.task).toBe('release cut 1.2.0');
  });

  it('accepts the namespaced team: form', () => {
    const r = parseWorkerMentions('@team:release ship it', isWorker, isTeam);
    expect(r.teams).toEqual(['release']);
    expect(r.task).toBe('release ship it');
  });

  it('prefers the worker when a bare name is both, and team: disambiguates', () => {
    expect(parseWorkerMentions('@alice go', isWorker, isTeam).workers).toEqual(['alice']);
    expect(parseWorkerMentions('@alice go', isWorker, isTeam).teams).toEqual([]);
    expect(parseWorkerMentions('@team:alice go', isWorker, isTeam).teams).toEqual(['alice']);
    expect(parseWorkerMentions('@team:alice go', isWorker, isTeam).workers).toEqual([]);
  });

  it('leaves an unknown team: token untouched', () => {
    const r = parseWorkerMentions('@team:nope go', isWorker, isTeam);
    expect(r.teams).toEqual([]);
    expect(r.task).toBe('@team:nope go');
  });

  it('collects teams and workers together, deduped and in order', () => {
    const r = parseWorkerMentions('@release with @bob and @team:release again', isWorker, isTeam);
    expect(r.teams).toEqual(['release']);
    expect(r.workers).toEqual(['bob']);
    expect(r.task).toBe('release with bob and release again');
  });
});
