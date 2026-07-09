import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SkillStore, RECENT_TRACES_MAX, HISTORY_MAX, REJECTED_MAX, distillCandidate, RunTrace, DistillDeps, matchSkill, confirmMatch, SkillEntry, applySkill, evolveSkill } from './skill-crystallizer';

describe('SkillStore', () => {
  let tmp: string;
  let store: SkillStore;

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-skills-test-'));
    store = new SkillStore(tmp);
    await store.load();
  });

  afterEach(async () => {
    await store.flush();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('adds a skill and persists to index.json', async () => {
    const entry = store.add({
      name: 'release-notes',
      description: 'Draft release notes from merged PRs',
      whenToUse: 'user asks for release notes or changelog',
      steps: '1. fetch merged PRs\n2. group by type\n3. format output',
      sourceRunId: 'run_001',
    });
    expect(entry.name).toBe('release-notes');
    expect(entry.version).toBe(1);
    expect(entry.history).toEqual([]);
    expect(entry.archived).toBe(false);
    expect(entry.useCount).toBe(0);
    await store.flush();
    const indexPath = path.join(tmp, 'skills', 'index.json');
    const raw = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
    expect(raw.entries.length).toBe(1);
    expect(raw.entries[0].name).toBe('release-notes');
  });

  it('loads existing skills from disk and defaults missing history/rejected', async () => {
    const skillsDir = path.join(tmp, 'skills');
    fs.mkdirSync(skillsDir, { recursive: true });
    fs.writeFileSync(path.join(skillsDir, 'index.json'), JSON.stringify({
      version: 1,
      entries: [{
        name: 'weekly-digest', description: 'Generate weekly summary',
        whenToUse: 'user asks for weekly report',
        steps: '1. gather\n2. format',
        version: 2, useCount: 3, lastUsedAt: Date.now() - 86400000,
        successSignals: { cleanRuns: 2, corrections: 1 },
        sourceRunIds: ['run_a'], createdAt: Date.now() - 604800000,
        archived: false,
      }],
    }));
    const store2 = new SkillStore(tmp);
    await store2.load();
    expect(store2.getAll().length).toBe(1);
    expect(store2.get('weekly-digest')!.version).toBe(2);
    expect(store2.get('weekly-digest')!.history).toEqual([]);
    expect(store2.getRejected()).toEqual([]);
  });

  it('add() on existing name updates in place', () => {
    store.add({ name: 'test', description: 'first', whenToUse: 'w', steps: 's' });
    store.add({ name: 'test', description: 'second', whenToUse: 'w2', steps: 's2' });
    expect(store.getAll().length).toBe(1);
    const u = store.get('test')!;
    expect(u.description).toBe('second');
    // Changed steps bump the version and retain the old steps in history.
    expect(u.version).toBe(2);
    expect(u.history).toEqual([{ version: 1, steps: 's' }]);
    // Re-adding with identical steps does NOT bump the version.
    store.add({ name: 'test', description: 'third', whenToUse: 'w3', steps: 's2' });
    const u2 = store.get('test')!;
    expect(u2.version).toBe(2);
    expect(u2.history).toEqual([{ version: 1, steps: 's' }]);
    expect(u2.description).toBe('third');
  });

  it('archive() and restore()', () => {
    store.add({ name: 's', description: 'd', whenToUse: 'w', steps: 'st' });
    expect(store.archive('s')).toBe(true);
    expect(store.get('s')!.archived).toBe(true);
    expect(store.getActive().length).toBe(0);
    expect(store.restore('s')).toBe(true);
    expect(store.get('s')!.archived).toBe(false);
    expect(store.getActive().length).toBe(1);
  });

  it('recordUse bumps useCount and lastUsedAt', () => {
    store.add({ name: 'test', description: 'd', whenToUse: 'w', steps: 's' });
    const before = Date.now();
    store.recordUse('test');
    const u = store.get('test')!;
    expect(u.useCount).toBe(1);
    expect(u.lastUsedAt).toBeGreaterThanOrEqual(before);
  });

  it('recordSuccessSignal tracks clean runs vs corrections', () => {
    store.add({ name: 'test', description: 'd', whenToUse: 'w', steps: 's' });
    store.recordSuccessSignal('test', true);
    store.recordSuccessSignal('test', false);
    const s = store.get('test')!.successSignals;
    expect(s.cleanRuns).toBe(1);
    expect(s.corrections).toBe(1);
  });

  it('bumpVersion retains prior steps in history', () => {
    store.add({ name: 'test', description: 'd', whenToUse: 'w', steps: 'old' });
    expect(store.bumpVersion('test', 'new')).toBe(true);
    const u = store.get('test')!;
    expect(u.version).toBe(2);
    expect(u.steps).toBe('new');
    expect(u.history).toEqual([{ version: 1, steps: 'old' }]);
  });

  it('history is capped at HISTORY_MAX', () => {
    store.add({ name: 'test', description: 'd', whenToUse: 'w', steps: 'v1' });
    for (let i = 2; i <= HISTORY_MAX + 3; i++) {
      store.bumpVersion('test', `v${i}`);
    }
    const u = store.get('test')!;
    expect(u.history.length).toBe(HISTORY_MAX);
    expect(u.history[u.history.length - 1].steps).toBe(`v${HISTORY_MAX + 2}`);
  });

  it('rollback restores the prior version and steps', () => {
    store.add({ name: 'test', description: 'd', whenToUse: 'w', steps: 'old' });
    store.bumpVersion('test', 'new');
    expect(store.rollback('test')).toBe(true);
    const u = store.get('test')!;
    expect(u.version).toBe(1);
    expect(u.steps).toBe('old');
    expect(u.history).toEqual([]);
  });

  it('rollback returns false with no history', () => {
    store.add({ name: 'test', description: 'd', whenToUse: 'w', steps: 's' });
    expect(store.rollback('test')).toBe(false);
  });

  it('rejectSuggestion records and caps at REJECTED_MAX', () => {
    for (let i = 0; i < REJECTED_MAX + 5; i++) {
      store.rejectSuggestion(`skill-${i}`, `desc ${i}`);
    }
    const rejected = store.getRejected();
    expect(rejected.length).toBe(REJECTED_MAX);
    expect(rejected[rejected.length - 1].name).toBe(`skill-${REJECTED_MAX + 4}`);
  });

  it('recordTrace stores traces and caps at RECENT_TRACES_MAX', () => {
    for (let i = 0; i < RECENT_TRACES_MAX + 5; i++) {
      store.recordTrace({
        runId: `run_${i}`, promptSummary: 'task', outputPreview: 'text',
        timestamp: Date.now() - i * 60000, mode: 'solo',
      });
    }
    const recent = store.getRecentTraces(100);
    expect(recent.length).toBe(RECENT_TRACES_MAX);
    expect(recent[0].runId).toBe(`run_${RECENT_TRACES_MAX + 4}`);
  });

  it('traces persist to disk and reload across store instances', async () => {
    store.recordTrace({ runId: 'r1', promptSummary: 'draft notes', outputPreview: 'md', timestamp: 1000, mode: 'solo' });
    store.recordTrace({ runId: 'r2', promptSummary: 'changelog', outputPreview: 'md', timestamp: 2000, mode: 'solo' });
    await store.flush();
    const store2 = new SkillStore(tmp);
    await store2.load();
    const traces = store2.getRecentTraces(10);
    expect(traces.length).toBe(2);
    expect(traces[0].runId).toBe('r2');
  });

  it('getRecentTraces returns most recent first', () => {
    store.recordTrace({ runId: 'older', promptSummary: 'o', outputPreview: 't', timestamp: 1000, mode: 'solo' });
    store.recordTrace({ runId: 'newer', promptSummary: 'n', outputPreview: 't', timestamp: 2000, mode: 'solo' });
    expect(store.getRecentTraces(10)[0].runId).toBe('newer');
  });

  it('logs a persist failure once per streak, backs off, and recovers', async () => {
    const warns: string[] = [];
    const infos: string[] = [];
    const logger = {
      info: (m: string) => { infos.push(m); },
      warn: (m: string) => { warns.push(m); },
      error: (_m: string) => {},
    };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-skills-fail-'));
    try {
      // A FILE where the skills/ directory belongs makes every persist fail.
      fs.writeFileSync(path.join(dir, 'skills'), 'not a directory');
      const failing = new SkillStore(dir, logger);
      failing.add({ name: 'test-skill', description: 'd', whenToUse: 'w', steps: 's' });
      await failing.flush(); // first attempt fails → logged
      failing.recordTrace({ runId: 'r', promptSummary: 'p', outputPreview: 'o', timestamp: 1, mode: 'solo' });
      await failing.flush(); // second attempt fails → same streak, NOT logged again
      expect(warns.length).toBe(1);
      expect(warns[0]).toContain('persist');
      // Repair the disk: the retry succeeds, logs recovery, resets the streak.
      fs.rmSync(path.join(dir, 'skills'));
      await failing.flush();
      expect(fs.existsSync(path.join(dir, 'skills', 'index.json'))).toBe(true);
      expect(infos.some(m => m.includes('recovered'))).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('runCollectGarbage archives stale and weak skills', () => {
    const old = Date.now() - 31 * 86_400_000;
    const s1 = store.add({ name: 'old', description: 'd', whenToUse: 'w', steps: 's', sourceRunId: 'r1' });
    s1.lastUsedAt = old;
    const s2 = store.add({ name: 'weak', description: 'd', whenToUse: 'w', steps: 's', sourceRunId: 'r2' });
    s2.createdAt = old;
    s2.lastUsedAt = old;
    const s3 = store.add({ name: 'active', description: 'd', whenToUse: 'w', steps: 's', sourceRunId: 'r3' });
    s3.useCount = 5;
    s3.lastUsedAt = Date.now() - 86_400_000;
    const archived = store.runCollectGarbage({ staleDays: 30, weakSkillDays: 7 });
    expect(archived).toBe(2);
    expect(store.get('old')!.archived).toBe(true);
    expect(store.get('weak')!.archived).toBe(true);
    expect(store.get('active')!.archived).toBe(false);
  });
});

function fakeDeps(runImpl: (req: any) => Promise<any>): DistillDeps {
  return {
    agent: 'claude-code' as any,
    model: { provider: 'anthropic', model: 'test' } as any,
    runner: (req: any) => runImpl(req),
  };
}

describe('distillCandidate', () => {
  it('returns null for empty traces', async () => {
    const result = await distillCandidate(null as any, [], [], [], 2);
    expect(result).toBeNull();
  });

  it('returns null when fewer traces than minRecurrence', async () => {
    const result = await distillCandidate(null as any,
      [{ runId: '1', promptSummary: 'x', outputPreview: 'y', timestamp: 0, mode: 'solo' }],
      [], [], 2);
    expect(result).toBeNull();
  });

  it('calls agent with traces and rejected list, parses JSON result', async () => {
    let calledPrompt = '';
    const deps = fakeDeps(async (req) => {
      calledPrompt = req.prompt;
      return { success: true, output: JSON.stringify({
        name: 'release-notes',
        description: 'Generate release notes from merged PRs',
        whenToUse: 'user asks for release notes or changelog',
        steps: '1. fetch PRs\n2. group by type\n3. format with links',
      }), error: null, tokens: { total: 100 } };
    });
    const traces: RunTrace[] = [
      { runId: '1', promptSummary: 'Draft release notes', outputPreview: 'markdown list', timestamp: 1, mode: 'solo' },
      { runId: '2', promptSummary: 'Generate changelog', outputPreview: 'markdown list', timestamp: 2, mode: 'solo' },
      { runId: '3', promptSummary: 'Write release announcement', outputPreview: 'markdown list', timestamp: 3, mode: 'solo' },
    ];
    const rejected = [{ name: 'weekly-digest', description: 'Weekly summary', rejectedAt: 1 }];
    const result = await distillCandidate(deps, traces, [], rejected, 2);
    expect(result).not.toBeNull();
    expect(result!.name).toBe('release-notes');
    expect(result!.steps).toContain('fetch PRs');
    expect(calledPrompt).toContain('Draft release notes');
    expect(calledPrompt).toContain('release announcement');
    expect(calledPrompt).toContain('weekly-digest');
  });

  it('returns null on "NONE" response', async () => {
    const deps = fakeDeps(async () => ({ success: true, output: 'NONE', error: null, tokens: { total: 10 } }));
    const traces: RunTrace[] = [
      { runId: '1', promptSummary: 'x', outputPreview: 'y', timestamp: 0, mode: 'solo' },
      { runId: '2', promptSummary: 'z', outputPreview: 'y', timestamp: 1, mode: 'solo' },
    ];
    const result = await distillCandidate(deps, traces, [], [], 2);
    expect(result).toBeNull();
  });

  it('returns null on unparseable output', async () => {
    const deps = fakeDeps(async () => ({ success: true, output: 'garbage', error: null, tokens: { total: 10 } }));
    const traces: RunTrace[] = [
      { runId: '1', promptSummary: 'x', outputPreview: 'y', timestamp: 0, mode: 'solo' },
      { runId: '2', promptSummary: 'z', outputPreview: 'y', timestamp: 1, mode: 'solo' },
    ];
    const result = await distillCandidate(deps, traces, [], [], 2);
    expect(result).toBeNull();
  });

  it('returns null when result fields are missing or not strings', async () => {
    const deps = fakeDeps(async () => ({
      success: true,
      output: JSON.stringify({ name: 'valid-name', steps: '1. x' }), // no description/whenToUse
      error: null, tokens: { total: 10 },
    }));
    const traces: RunTrace[] = [
      { runId: '1', promptSummary: 'x', outputPreview: 'y', timestamp: 0, mode: 'solo' },
      { runId: '2', promptSummary: 'z', outputPreview: 'y', timestamp: 1, mode: 'solo' },
    ];
    const result = await distillCandidate(deps, traces, [], [], 2);
    expect(result).toBeNull();
  });

  it('retries once on garbage then returns the valid second result', async () => {
    const prompts: string[] = [];
    const deps = fakeDeps(async (req) => {
      prompts.push(req.prompt);
      if (prompts.length === 1) {
        return { success: true, output: 'garbage', error: null, tokens: { total: 10 } };
      }
      return { success: true, output: JSON.stringify({
        name: 'release-notes',
        description: 'Generate release notes',
        whenToUse: 'user asks for release notes',
        steps: '1. fetch PRs\n2. format',
      }), error: null, tokens: { total: 100 } };
    });
    const traces: RunTrace[] = [
      { runId: '1', promptSummary: 'x', outputPreview: 'y', timestamp: 0, mode: 'solo' },
      { runId: '2', promptSummary: 'z', outputPreview: 'y', timestamp: 1, mode: 'solo' },
    ];
    const result = await distillCandidate(deps, traces, [], [], 2);
    expect(result).not.toBeNull();
    expect(result!.name).toBe('release-notes');
    expect(prompts.length).toBe(2);
    expect(prompts[1]).toContain('Reminder: return ONLY the JSON');
  });

  it('returns null when the name fails validation (bad chars or too short)', async () => {
    const traces: RunTrace[] = [
      { runId: '1', promptSummary: 'x', outputPreview: 'y', timestamp: 0, mode: 'solo' },
      { runId: '2', promptSummary: 'z', outputPreview: 'y', timestamp: 1, mode: 'solo' },
    ];
    const badName = fakeDeps(async () => ({
      success: true,
      output: JSON.stringify({
        name: 'Bad Name', description: 'd', whenToUse: 'w', steps: '1. x',
      }),
      error: null, tokens: { total: 10 },
    }));
    expect(await distillCandidate(badName, traces, [], [], 2)).toBeNull();

    const tooShort = fakeDeps(async () => ({
      success: true,
      output: JSON.stringify({
        name: 'ab', description: 'd', whenToUse: 'w', steps: '1. x',
      }),
      error: null, tokens: { total: 10 },
    }));
    expect(await distillCandidate(tooShort, traces, [], [], 2)).toBeNull();
  });
});

function makeSkill(over: Partial<SkillEntry>): SkillEntry {
  return {
    name: 'x', description: '', whenToUse: '', steps: 's',
    version: 1, history: [], useCount: 0, lastUsedAt: Date.now(),
    successSignals: { cleanRuns: 0, corrections: 0 },
    sourceRunIds: [], createdAt: Date.now(), archived: false,
    ...over,
  };
}

describe('matchSkill', () => {
  const skills: SkillEntry[] = [
    makeSkill({ name: 'release-notes', description: 'Generate release notes', whenToUse: 'user asks for release notes or changelog' }),
    makeSkill({ name: 'fix-lint', description: 'Fix lint errors', whenToUse: 'user reports lint errors or ESLint failures' }),
    makeSkill({ name: 'archived-x', description: 'Hidden', whenToUse: 'anything', archived: true }),
  ];

  it('high-confidence match for multi-keyword overlap', () => {
    const m = matchSkill('generate release notes from merged PRs', skills);
    expect(m?.skill.name).toBe('release-notes');
    expect(m?.confidence).toBe('high');
  });

  it('borderline match for single-keyword overlap', () => {
    const m = matchSkill('write a changelog for v2.1', skills);
    expect(m?.skill.name).toBe('release-notes');
    expect(m?.confidence).toBe('borderline');
  });

  it('matches fix-lint for ESLint task', () => {
    const m = matchSkill('eslint is failing on CI, can you fix?', skills);
    expect(m?.skill.name).toBe('fix-lint');
  });

  it('returns null for unrelated task', () => {
    expect(matchSkill('build a REST API for users', skills)).toBeNull();
  });

  it('never matches archived skills', () => {
    expect(matchSkill('do anything at all please', skills)).toBeNull();
  });

  it('duplicated words in skill text do not inflate confidence past borderline', () => {
    const dup = [makeSkill({ name: 'dup', description: 'changelog changelog changelog tool', whenToUse: '' })];
    const m = matchSkill('write a changelog for v2.1', dup);
    expect(m?.skill.name).toBe('dup');
    expect(m?.confidence).toBe('borderline');
  });

  it('two overlapping tokens diluted by a long description stay borderline (score gate)', () => {
    const verbose = [makeSkill({
      name: 'verbose',
      description: 'release notes alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma',
      whenToUse: '',
    })];
    const m = matchSkill('generate release notes', verbose);
    expect(m?.skill.name).toBe('verbose');
    expect(m?.confidence).toBe('borderline');
  });

  it('a two-token overlap is never high confidence (must pass the confirm gate)', () => {
    const changelog = [makeSkill({
      name: 'generate-changelog',
      description: 'Generates a changelog from merged PRs',
      whenToUse: 'user asks for a changelog or release notes',
    })];
    // Shares only {merged, prs} with the skill — an incidental overlap that
    // must NOT auto-apply the changelog procedure to an unrelated task.
    const m = matchSkill('list merged PRs from last week', changelog);
    expect(m?.skill.name).toBe('generate-changelog');
    expect(m?.confidence).toBe('borderline');
  });

  it('three shared tokens with a diluted Jaccard score stay borderline', () => {
    const verbose = [makeSkill({
      name: 'verbose3',
      description: 'generate release notes alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu',
      whenToUse: '',
    })];
    const m = matchSkill('generate release notes covering the quarterly summary report deck', verbose);
    expect(m?.skill.name).toBe('verbose3');
    expect(m?.confidence).toBe('borderline');
  });
});

describe('confirmMatch', () => {
  const skill = makeSkill({ name: 'release-notes', description: 'Generate release notes', whenToUse: 'release notes or changelog' });

  it('returns true on YES', async () => {
    const deps = fakeDeps(async () => ({ success: true, output: 'YES', error: null, tokens: { total: 5 } }));
    expect(await confirmMatch(deps, 'write a changelog', skill)).toBe(true);
  });

  it('returns false on NO', async () => {
    const deps = fakeDeps(async () => ({ success: true, output: 'NO', error: null, tokens: { total: 5 } }));
    expect(await confirmMatch(deps, 'build an API', skill)).toBe(false);
  });

  it('returns false on failed agent call', async () => {
    const deps = fakeDeps(async () => ({ success: false, output: '', error: 'crash', tokens: { total: 0 } }));
    expect(await confirmMatch(deps, 'write a changelog', skill)).toBe(false);
  });
});

describe('applySkill', () => {
  const skill = makeSkill({
    name: 'release-notes', description: 'Generate release notes',
    whenToUse: 'user asks for release notes',
    steps: '1. fetch merged PRs\n2. group by type\n3. format with links',
    version: 2,
  });

  it('prepends banner + steps before task', () => {
    const result = applySkill('generate release notes for v2.1', skill);
    expect(result).toContain('using skill: release-notes (v2)');
    expect(result).toContain('1. fetch merged PRs');
    expect(result).toContain('generate release notes for v2.1');
    const skillPos = result.indexOf('1. fetch merged PRs');
    const taskPos = result.indexOf('generate release notes for v2.1');
    expect(skillPos).toBeLessThan(taskPos);
  });

  it('handles empty task', () => {
    const result = applySkill('', skill);
    expect(result).toContain('using skill: release-notes');
  });
});

describe('evolveSkill', () => {
  const skill = makeSkill({
    name: 'release-notes', description: 'Release notes',
    whenToUse: 'release notes', steps: '1. fetch PRs\n2. group',
    useCount: 3, successSignals: { cleanRuns: 2, corrections: 1 },
  });
  const trace: RunTrace = {
    runId: 'r2', promptSummary: 'Draft release notes',
    outputPreview: 'markdown with sections', timestamp: Date.now(), mode: 'solo',
  };

  it('evolves when agent finds better steps', async () => {
    const deps = fakeDeps(async () => ({
      success: true,
      output: JSON.stringify({ improved: true, steps: '1. fetch\n2. group\n3. add links\n4. format' }),
      error: null, tokens: { total: 100 },
    }));
    const result = await evolveSkill(deps, skill, trace);
    expect(result).not.toBeNull();
    expect(result).toContain('add links');
  });

  it('returns null when no improvement needed', async () => {
    const deps = fakeDeps(async () => ({
      success: true, output: JSON.stringify({ improved: false }), error: null, tokens: { total: 50 },
    }));
    const result = await evolveSkill(deps, skill, trace);
    expect(result).toBeNull();
  });

  it('returns null on failed agent call', async () => {
    const deps = fakeDeps(async () => ({ success: false, output: '', error: 'crash', tokens: { total: 0 } }));
    const result = await evolveSkill(deps, skill, trace);
    expect(result).toBeNull();
  });

  it('returns null when improved is a string "true" instead of boolean', async () => {
    const deps = fakeDeps(async () => ({
      success: true,
      output: JSON.stringify({ improved: 'true', steps: 'x' }),
      error: null, tokens: { total: 50 },
    }));
    const result = await evolveSkill(deps, skill, trace);
    expect(result).toBeNull();
  });

  it('returns null when improved is true but steps is whitespace-only', async () => {
    const deps = fakeDeps(async () => ({
      success: true,
      output: JSON.stringify({ improved: true, steps: '   ' }),
      error: null, tokens: { total: 50 },
    }));
    const result = await evolveSkill(deps, skill, trace);
    expect(result).toBeNull();
  });
});
