import { describe, it, expect } from 'vitest';
import {
  shapeOf, sameShape, stepsFrom, signatureOf, computeRarity, similarity, clusterProcedures,
  induceTemplate, renderTemplate, hasProcedureData,
  TEXT_LEN_MAX, MAX_STEPS, MAX_ARGS_PER_STEP, ProcedureInput,
} from './playbook-induction';

describe('shapeOf', () => {
  it('keeps only the host of a URL', () => {
    expect(shapeOf('https://x.com/someone/status/12345?s=20')).toEqual({ kind: 'url', host: 'x.com' });
    // Same host, wildly different path — the same shape, so a constant.
    expect(sameShape(shapeOf('https://x.com/a'), shapeOf('https://x.com/b/c/d'))).toBe(true);
    // Different host — a slot.
    expect(sameShape(shapeOf('https://x.com/a'), shapeOf('https://reddit.com/a'))).toBe(false);
  });

  it('falls back to string rules for a malformed URL', () => {
    expect(shapeOf('https://').kind).not.toBe('url');
  });

  it('describes paths by extension and depth', () => {
    expect(shapeOf('src/agents/claude-code.ts')).toEqual({ kind: 'path', ext: 'ts', depth: 3 });
    expect(shapeOf('/tmp/out.json')).toEqual({ kind: 'path', ext: 'json', depth: 2 });
  });

  it('compares short identifier-ish values literally', () => {
    expect(shapeOf('main')).toEqual({ kind: 'enum', value: 'main' });
    expect(sameShape(shapeOf('main'), shapeOf('main'))).toBe(true);
    expect(sameShape(shapeOf('main'), shapeOf('develop'))).toBe(false);
  });

  it('reduces free text to a bucketed length', () => {
    expect(shapeOf('x'.repeat(50))).toEqual({ kind: 'text', len: 100 });
    expect(shapeOf('x'.repeat(500))).toEqual({ kind: 'text', len: 1_000 });
    expect(shapeOf('x'.repeat(50_000))).toEqual({ kind: 'text', len: TEXT_LEN_MAX });
  });

  it('treats near-identical long text as the same shape', () => {
    // 300 vs 500 chars is the same step, not two different ones.
    expect(sameShape(shapeOf('a'.repeat(300)), shapeOf('b'.repeat(500)))).toBe(true);
  });

  it('handles non-strings and collapses structures', () => {
    expect(shapeOf(42)).toEqual({ kind: 'number' });
    expect(shapeOf(true)).toEqual({ kind: 'bool' });
    expect(shapeOf({ a: 1 })).toEqual({ kind: 'other' });
    expect(shapeOf([1, 2])).toEqual({ kind: 'other' });
    expect(shapeOf(null)).toEqual({ kind: 'other' });
  });
});

describe('stepsFrom', () => {
  it('abstracts arguments and keeps call order', () => {
    expect(stepsFrom([
      { type: 'tool_start', tool: 'browser_navigate', input: { url: 'https://x.com/home' } },
      { type: 'tool_end', tool: 'browser_navigate' },
      { type: 'tool_start', tool: 'Write', input: { file_path: 'out/post.md', content: 'x'.repeat(400) } },
    ])).toEqual([
      { tool: 'browser_navigate', args: { url: { kind: 'url', host: 'x.com' } } },
      { tool: 'Write', args: { file_path: { kind: 'path', ext: 'md', depth: 2 }, content: { kind: 'text', len: 1_000 } } },
    ]);
  });

  it('never retains a raw argument value', () => {
    const secret = 'https://internal.example.com/very/secret/path?token=abcdef';
    const json = JSON.stringify(stepsFrom([{ tool: 'fetch', input: { url: secret, body: 'hunter2 hunter2 hunter2 hunter2 hunter2' } }]));
    expect(json).not.toContain('secret');
    expect(json).not.toContain('abcdef');
    expect(json).not.toContain('hunter2');
    expect(json).toContain('internal.example.com'); // host is deliberate
  });

  it('accepts records with no type, collapses repeats, and caps', () => {
    expect(stepsFrom([{ tool: 'Read' }, { tool: 'Read' }, { tool: 'Edit' }]).map(s => s.tool))
      .toEqual(['Read', 'Edit']);
    const many = Array.from({ length: 40 }, (_, i) => ({ tool: `tool-${i}` }));
    expect(stepsFrom(many)).toHaveLength(MAX_STEPS);
  });

  it('caps arguments per step and skips info entries and missing names', () => {
    const wide: Record<string, number> = {};
    for (let i = 0; i < 20; i++) wide[`k${i}`] = i;
    expect(Object.keys(stepsFrom([{ tool: 'x', input: wide }])[0].args)).toHaveLength(MAX_ARGS_PER_STEP);
    expect(stepsFrom([{ type: 'info', tool: 'x' }, { tool: undefined }, { tool: 'Read' }]).map(s => s.tool))
      .toEqual(['Read']);
    expect(stepsFrom(undefined)).toEqual([]);
  });

  it('gives a step with no usable input an empty arg map', () => {
    expect(stepsFrom([{ tool: 'Bash', input: 'not-an-object' }])).toEqual([{ tool: 'Bash', args: {} }]);
  });
});

describe('signatureOf', () => {
  it('collapses consecutive repeats', () => {
    expect(signatureOf({ runId: 'r', steps: [
      { tool: 'Read', args: {} }, { tool: 'Read', args: {} }, { tool: 'Edit', args: {} }, { tool: 'Read', args: {} },
    ] })).toEqual(['Read', 'Edit', 'Read']);
  });

  it('falls back to worker names for team runs', () => {
    expect(signatureOf({ runId: 'r', workerSequence: ['researcher', 'writer'] }))
      .toEqual(['researcher', 'writer']);
  });

  it('is empty when a run observed nothing', () => {
    expect(signatureOf({ runId: 'r' })).toEqual([]);
  });
});

describe('similarity', () => {
  const flat = new Map<string, number>();

  it('is order-sensitive', () => {
    const forward = similarity(['a', 'b', 'c'], ['a', 'b', 'c'], flat);
    const reversed = similarity(['a', 'b', 'c'], ['c', 'b', 'a'], flat);
    expect(forward).toBe(1);
    expect(reversed).toBeLessThan(forward);
  });

  it('scores a shared prefix between 0 and 1', () => {
    const score = similarity(['a', 'b', 'c'], ['a', 'b', 'd'], flat);
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(1);
  });

  it('weights distinctive tools above ubiquitous ones', () => {
    const rarity = new Map([['common', 0.01], ['rare', 0.9]]);
    const rareMatch = similarity(['rare', 'common'], ['rare', 'other'], rarity);
    const commonMatch = similarity(['common', 'rare'], ['common', 'other'], rarity);
    expect(rareMatch).toBeGreaterThan(commonMatch);
  });

  it('returns 0 for an empty sequence', () => {
    expect(similarity([], ['a'], flat)).toBe(0);
  });
});

describe('computeRarity', () => {
  it('scores a tool in every run at zero and a rare tool high', () => {
    const rarity = computeRarity([['Read', 'Edit'], ['Read', 'Bash'], ['Read', 'browser_interact']], 3);
    expect(rarity.get('Read')).toBe(0);
    expect(rarity.get('browser_interact')).toBeCloseTo(2 / 3);
  });

  it('counts runs that observed no tools in the denominator', () => {
    // Two browser runs among ten is distinctive, even if the other eight
    // observed nothing at all.
    const rarity = computeRarity([['browser_navigate'], ['browser_navigate']], 10);
    expect(rarity.get('browser_navigate')).toBeCloseTo(0.8);
  });
});

function run(runId: string, tools: string[]): ProcedureInput {
  return { runId, steps: tools.map(tool => ({ tool, args: {} })) };
}

describe('clusterProcedures', () => {
  it('clusters runs that executed the same distinctive procedure', () => {
    const report = clusterProcedures([
      run('a', ['browser_navigate', 'browser_read', 'browser_interact']),
      run('b', ['browser_navigate', 'browser_read', 'browser_interact']),
      run('c', ['Read', 'Edit', 'Bash']),
      run('d', ['Grep', 'Read', 'Write']),
    ], { minMembers: 2 });
    expect(report.clusters).toHaveLength(1);
    expect(report.clusters[0].runIds.sort()).toEqual(['a', 'b']);
    expect(report.clusters[0].signature).toEqual(['browser_navigate', 'browser_read', 'browser_interact']);
  });

  it('does not crystallize a procedure made of ubiquitous tools', () => {
    // Read -> Edit -> Bash in every run: recurring, but meaningless.
    const report = clusterProcedures([
      run('a', ['Read', 'Edit', 'Bash']),
      run('b', ['Read', 'Edit', 'Bash']),
      run('c', ['Read', 'Edit', 'Bash']),
      run('d', ['Read', 'Edit', 'Bash']),
    ], { minMembers: 2 });
    expect(report.clusters).toHaveLength(0);
    expect(report.rejectedByDistinctiveness).toBe(1);
  });

  it('rejects procedures that are too short to mean anything', () => {
    const report = clusterProcedures([
      run('a', ['Read', 'Edit']),
      run('b', ['Read', 'Edit']),
    ], { minMembers: 2 });
    expect(report.clusters).toHaveLength(0);
    expect(report.tooShort).toBe(2);
  });

  it('counts runs with no procedure data separately', () => {
    const report = clusterProcedures([
      { runId: 'a' }, { runId: 'b' },
      run('c', ['browser_navigate', 'browser_read', 'browser_interact']),
      run('d', ['browser_navigate', 'browser_read', 'browser_interact']),
    ], { minMembers: 2 });
    expect(report.withoutSteps).toBe(2);
    expect(report.clusters).toHaveLength(1);
  });

  it('reports a distinctive procedure that has not recurred yet', () => {
    const report = clusterProcedures([
      run('a', ['browser_navigate', 'browser_read', 'browser_interact']),
      run('b', ['Grep', 'Read', 'Write']),
      run('c', ['Bash', 'Read', 'Edit']),
    ], { minMembers: 2 });
    expect(report.clusters).toHaveLength(0);
    expect(report.tooFewMembers).toBeGreaterThan(0);
  });

  it('prefers a small distinctive cluster over a larger generic one', () => {
    const report = clusterProcedures([
      run('a', ['Read', 'browser_navigate', 'browser_interact', 'browser_files']),
      run('b', ['Read', 'browser_navigate', 'browser_interact', 'browser_files']),
      run('c', ['Read', 'Edit', 'Write', 'Bash']),
      run('d', ['Read', 'Edit', 'Write', 'Bash']),
      run('e', ['Read', 'Edit', 'Write', 'Bash']),
      run('f', ['Read', 'Edit', 'Write', 'Grep']),
      run('g', ['Read', 'Edit', 'Write', 'Grep']),
    ], { minMembers: 2 });
    // The Read/Edit/Write group is bigger, but it is what almost every run
    // does — it must not outrank the browser procedure by size alone.
    expect(report.clusters[0].runIds.sort()).toEqual(['a', 'b']);
    expect(report.rejectedByDistinctiveness).toBeGreaterThan(0);
  });

  it('scores a cluster as members * distinctiveness', () => {
    const report = clusterProcedures([
      run('a', ['browser_navigate', 'browser_read', 'browser_interact']),
      run('b', ['browser_navigate', 'browser_read', 'browser_interact']),
      run('c', ['Grep', 'Bash', 'Write']),
      run('d', ['Curl', 'Deploy', 'Notify']),
    ], { minMembers: 2 });
    const cluster = report.clusters[0];
    expect(cluster.score).toBeCloseTo(cluster.runIds.length * cluster.distinctiveness);
  });

  it('returns an empty report when there is nothing to compare', () => {
    expect(clusterProcedures([], { minMembers: 2 }).clusters).toEqual([]);
    expect(clusterProcedures([run('a', ['x', 'y', 'z'])], { minMembers: 2 }).clusters).toEqual([]);
  });

  it('clusters team runs on their worker sequence', () => {
    const report = clusterProcedures([
      { runId: 'a', workerSequence: ['scout', 'writer', 'editor'] },
      { runId: 'b', workerSequence: ['scout', 'writer', 'editor'] },
      { runId: 'c', workerSequence: ['auditor', 'fixer', 'verifier'] },
      run('d', ['Read', 'Edit', 'Bash']),
      run('e', ['Grep', 'Write', 'Bash']),
    ], { minMembers: 2 });
    expect(report.clusters).toHaveLength(1);
    expect(report.clusters[0].runIds.sort()).toEqual(['a', 'b']);
  });
});

function member(runId: string, calls: { tool: string; input?: Record<string, unknown> }[]): ProcedureInput {
  return { runId, steps: stepsFrom(calls) };
}

describe('induceTemplate', () => {
  it('splits constants from slots across a cluster', () => {
    const template = induceTemplate([
      member('a', [
        { tool: 'browser_navigate', input: { url: 'https://x.com/alice/status/1' } },
        { tool: 'browser_interact', input: { text: 'a'.repeat(200) } },
      ]),
      member('b', [
        { tool: 'browser_navigate', input: { url: 'https://x.com/bob/status/2' } },
        { tool: 'browser_interact', input: { text: 'b'.repeat(240) } },
      ]),
    ])!;
    // Same host every run -> constant. Same text bucket -> still a slot.
    expect(template.steps[0]).toEqual({ tool: 'browser_navigate', constants: { url: 'x.com' }, slots: [] });
    expect(template.steps[1]).toEqual({ tool: 'browser_interact', constants: {}, slots: ['text'] });
    expect(template.parameters).toEqual([{ name: 'text', kind: 'text' }]);
  });

  it('makes a differing host a slot', () => {
    const template = induceTemplate([
      member('a', [{ tool: 'fetch', input: { url: 'https://x.com/a' } }, { tool: 'Write', input: { n: 1 } }]),
      member('b', [{ tool: 'fetch', input: { url: 'https://reddit.com/b' } }, { tool: 'Write', input: { n: 2 } }]),
    ])!;
    expect(template.steps[0].slots).toEqual(['url']);
    expect(template.steps[0].constants).toEqual({});
    expect(template.parameters.map(p => p.name)).toEqual(['url', 'n']);
  });

  it('never treats same-length text or same-extension paths as constant', () => {
    const template = induceTemplate([
      member('a', [{ tool: 'Write', input: { file_path: 'src/one.ts', content: 'x'.repeat(50) } }]),
      member('b', [{ tool: 'Write', input: { file_path: 'src/two.ts', content: 'y'.repeat(60) } }]),
    ])!;
    expect(template.steps[0].constants).toEqual({});
    expect(template.steps[0].slots.sort()).toEqual(['content', 'file_path']);
    expect(template.parameters.find(p => p.name === 'file_path')).toEqual({ name: 'file_path', kind: 'path', ext: 'ts' });
  });

  it('drops a step where members called different tools', () => {
    const template = induceTemplate([
      member('a', [{ tool: 'Read' }, { tool: 'Edit' }, { tool: 'Bash' }]),
      member('b', [{ tool: 'Read' }, { tool: 'Grep' }, { tool: 'Bash' }]),
    ])!;
    expect(template.steps.map(s => s.tool)).toEqual(['Read', 'Bash']);
  });

  it('ignores arguments only some members supplied', () => {
    const template = induceTemplate([
      member('a', [{ tool: 'Bash', input: { command: 'x'.repeat(50), timeout: 1000 } }]),
      member('b', [{ tool: 'Bash', input: { command: 'y'.repeat(50) } }]),
    ])!;
    expect(template.steps[0].slots).toEqual(['command']);
  });

  it('disambiguates repeated slot names', () => {
    const template = induceTemplate([
      member('a', [{ tool: 'fetch', input: { url: 'https://one.com/x' } }, { tool: 'post', input: { url: 'https://two.com/y' } }]),
      member('b', [{ tool: 'fetch', input: { url: 'https://three.com/x' } }, { tool: 'post', input: { url: 'https://four.com/y' } }]),
    ])!;
    expect(template.parameters.map(p => p.name)).toEqual(['url', 'url_2']);
  });

  it('returns null without at least two members or any steps', () => {
    expect(induceTemplate([member('a', [{ tool: 'Read' }])])).toBeNull();
    expect(induceTemplate([{ runId: 'a' }, { runId: 'b' }])).toBeNull();
  });

  it('renders a template without any user content', () => {
    const template = induceTemplate([
      member('a', [{ tool: 'browser_navigate', input: { url: 'https://x.com/secret-handle/status/1' } }]),
      member('b', [{ tool: 'browser_navigate', input: { url: 'https://x.com/other-handle/status/2' } }]),
    ])!;
    const rendered = renderTemplate(template);
    expect(rendered).toBe('1. browser_navigate(url=x.com)');
    expect(rendered).not.toContain('secret-handle');
  });
});

describe('shapeOf, glob and directory values', () => {
  it('keeps a glob pattern literal instead of bucketing it', () => {
    // From a real opencode run: glob(pattern: "**/note.txt"). As bucketed text
    // every glob of similar length looks identical.
    expect(shapeOf('**/note.txt')).toEqual({ kind: 'enum', value: '**/note.txt' });
    expect(sameShape(shapeOf('**/note.txt'), shapeOf('**/*.test.ts'))).toBe(false);
    expect(shapeOf('src/**/{a,b}.ts').kind).toBe('enum');
  });

  it('treats an extensionless directory as a comparable value', () => {
    // 'enum' rather than 'path' on purpose: only url and enum can be induced
    // as constants, so this is what lets "always this directory" be baked in.
    expect(shapeOf('/tmp/oc-probe')).toEqual({ kind: 'enum', value: '/tmp/oc-probe' });
    expect(sameShape(shapeOf('/tmp/a'), shapeOf('/tmp/b'))).toBe(false);
  });
});

describe('hasProcedureData', () => {
  it('is false only when nothing in the window observed a tool', () => {
    const nothing = clusterProcedures([{ runId: 'a' }, { runId: 'b' }], { minMembers: 2 });
    expect(nothing.considered).toBe(2);
    expect(nothing.withoutSteps).toBe(2);
    expect(hasProcedureData(nothing)).toBe(false);
  });

  it('is true when procedures were observed but declined', () => {
    // The distinction the distill fallback turns on: these runs DID something,
    // clustering just refused to crystallize it. Falling back to prose
    // distillation here would re-propose what the gates rejected.
    const tooGeneric = clusterProcedures([
      run('a', ['Read', 'Edit', 'Bash']),
      run('b', ['Read', 'Edit', 'Bash']),
      run('c', ['Read', 'Edit', 'Bash']),
    ], { minMembers: 2 });
    expect(tooGeneric.clusters).toHaveLength(0);
    expect(hasProcedureData(tooGeneric)).toBe(true);

    const tooShort = clusterProcedures([run('a', ['Read', 'Edit'])], { minMembers: 2 });
    expect(tooShort.clusters).toHaveLength(0);
    expect(hasProcedureData(tooShort)).toBe(true);
  });

  it('is true when a mixed window has any observable run', () => {
    const mixed = clusterProcedures([
      { runId: 'a' },
      run('b', ['browser_navigate', 'browser_read', 'browser_interact']),
    ], { minMembers: 2 });
    expect(hasProcedureData(mixed)).toBe(true);
  });

  it('is false for an empty window', () => {
    expect(hasProcedureData(clusterProcedures([], { minMembers: 2 }))).toBe(false);
  });
});
