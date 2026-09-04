import { describe, it, expect } from 'vitest';
import { parseWorkerMentions } from './worker-mentions';

const isWorker = (n: string) => ['alice', 'bob', 'Reviewer'].map(s => s.toLowerCase()).includes(n.toLowerCase());

describe('parseWorkerMentions', () => {
  it('returns no workers for plain text', () => {
    expect(parseWorkerMentions('fix the tests', isWorker)).toEqual({ workers: [], task: 'fix the tests' });
  });

  it('finds a single bare mention and strips the @', () => {
    expect(parseWorkerMentions('@alice fix the tests', isWorker)).toEqual({ workers: ['alice'], task: 'alice fix the tests' });
  });

  it('accepts the namespaced worker: form the Mac composer inserts', () => {
    expect(parseWorkerMentions('@worker:alice fix it', isWorker)).toEqual({ workers: ['alice'], task: 'alice fix it' });
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
});
