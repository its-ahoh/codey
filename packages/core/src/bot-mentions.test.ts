import { describe, it, expect } from 'vitest';
import { parseBotMentions } from './bot-mentions';

const isBot = (n: string) => ['alice', 'bob', 'Reviewer'].map(s => s.toLowerCase()).includes(n.toLowerCase());
const isTeam = (n: string) => ['release', 'alice'].includes(n.toLowerCase());

describe('parseBotMentions', () => {
  it('returns no bots for plain text', () => {
    expect(parseBotMentions('fix the tests', isBot)).toEqual({ bots: [], teams: [], task: 'fix the tests' });
  });

  it('finds a single bare mention and strips the @', () => {
    expect(parseBotMentions('@alice fix the tests', isBot)).toEqual({ bots: ['alice'], teams: [], task: 'alice fix the tests' });
  });

  it('accepts the namespaced bot: form the Mac composer inserts', () => {
    expect(parseBotMentions('@bot:alice fix it', isBot)).toEqual({ bots: ['alice'], teams: [], task: 'alice fix it' });
  });

  it('collects several bots in order of first mention, deduped', () => {
    const r = parseBotMentions('@bob then @alice then @bob again', isBot);
    expect(r.bots).toEqual(['bob', 'alice']);
    expect(r.task).toBe('bob then alice then bob again');
  });

  it('leaves unknown tokens, emails and files alone', () => {
    const r = parseBotMentions('@src/app.ts me@example.com @skill:browser @alice', isBot);
    expect(r.bots).toEqual(['alice']);
    expect(r.task).toBe('@src/app.ts me@example.com @skill:browser alice');
  });

  it('matches case-insensitively and keeps the typed spelling in the task', () => {
    const r = parseBotMentions('@reviewer check @Alice', isBot);
    expect(r.bots).toEqual(['reviewer', 'alice']);
    expect(r.task).toBe('reviewer check Alice');
  });

  it('strips trailing punctuation from the name but keeps it in the text', () => {
    const r = parseBotMentions('@alice, @bob: go', isBot);
    expect(r.bots).toEqual(['alice', 'bob']);
    expect(r.task).toBe('alice, bob: go');
  });

  it('only matches at the start or after whitespace', () => {
    const r = parseBotMentions('foo@alice and\n@bob', isBot);
    expect(r.bots).toEqual(['bob']);
    expect(r.task).toBe('foo@alice and\nbob');
  });

  it('finds a bare team mention when no bot owns the name', () => {
    const r = parseBotMentions('@release cut 1.2.0', isBot, isTeam);
    expect(r.teams).toEqual(['release']);
    expect(r.bots).toEqual([]);
    expect(r.task).toBe('release cut 1.2.0');
  });

  it('accepts the namespaced team: form', () => {
    const r = parseBotMentions('@team:release ship it', isBot, isTeam);
    expect(r.teams).toEqual(['release']);
    expect(r.task).toBe('release ship it');
  });

  it('prefers the bot when a bare name is both, and team: disambiguates', () => {
    expect(parseBotMentions('@alice go', isBot, isTeam).bots).toEqual(['alice']);
    expect(parseBotMentions('@alice go', isBot, isTeam).teams).toEqual([]);
    expect(parseBotMentions('@team:alice go', isBot, isTeam).teams).toEqual(['alice']);
    expect(parseBotMentions('@team:alice go', isBot, isTeam).bots).toEqual([]);
  });

  it('leaves an unknown team: token untouched', () => {
    const r = parseBotMentions('@team:nope go', isBot, isTeam);
    expect(r.teams).toEqual([]);
    expect(r.task).toBe('@team:nope go');
  });

  it('collects teams and bots together, deduped and in order', () => {
    const r = parseBotMentions('@release with @bob and @team:release again', isBot, isTeam);
    expect(r.teams).toEqual(['release']);
    expect(r.bots).toEqual(['bob']);
    expect(r.task).toBe('release with bob and release again');
  });
});
