// Live paired check of production scenario-specific instructions. Uses CLI quota.
const fs = require('fs');
const path = require('path');
const Module = require('module');
const ts = require('typescript');
const { execFileSync } = require('child_process');
const { CodexAdapter } = require('../../packages/core/dist/agents/codex');
const current = require('../../packages/core/dist/advisor');
const root = path.resolve(__dirname, '../..');
const out = path.resolve(process.argv[2] || path.join(__dirname, 'results/scenario-json.json'));
if (fs.existsSync(out)) throw Error('Refusing to overwrite results');
const baseRef = '9cff31c6';
function oldModule(file, personality) {
  const filename = path.join(root, 'packages/core/dist', file + '.js');
  const source = execFileSync('git', ['show', `${baseRef}:packages/core/src/${file}.ts`], { cwd: root, encoding: 'utf8' });
  const mod = new Module(filename, module);
  mod.filename = filename; mod.paths = Module._nodeModulePaths(path.dirname(filename));
  const nativeRequire = mod.require.bind(mod);
  mod.require = id => id === './advisor-personality' && personality ? personality : nativeRequire(id);
  mod._compile(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, filename);
  return mod.exports;
}
const baseline = oldModule('advisor', oldModule('advisor-personality'));
const base = { task: 'Implement search and have the reviewer verify it.', history: [], lastBot: null, lastOutput: null,
  members: [{ name: 'coder', hint: 'Implements code and fixes defects' }, { name: 'reviewer', hint: 'Reviews and tests' }, { name: 'writer', hint: 'Writes user documentation' }] };
const cases = [
  { id: 'first', input: base, next: 'coder', terms: ['search'] },
  { id: 'docs', input: { ...base, task: 'Write a user guide for existing search. No code changes.' }, next: 'writer', terms: ['search'] },
  { id: 'review', input: { ...base, lastBot: 'coder', lastOutput: 'Search implemented. Independent review and tests are still required.' }, next: 'reviewer', terms: ['test'] },
  { id: 'revision', input: { ...base, lastBot: 'reviewer', lastOutput: 'Null queries crash. Coder must fix this and add regression tests.' }, next: 'coder', terms: ['null', 'test'] },
  { id: 'escalate', input: { ...base, lastBot: 'coder', lastOutput: 'Blocked on a private deployment destination only the user knows.', pendingQuestion: { bot: 'coder', question: 'Which private deployment destination?' } }, next: 'user' },
  { id: 'teammate', input: { ...base, lastBot: 'coder', lastOutput: 'Reviewer has the test results.', pendingQuestion: { bot: 'coder', question: 'Reviewer, did search tests pass?' } }, next: 'reviewer', terms: ['test'] },
  { id: 'resume', input: { ...base, lastBot: 'coder', lastOutput: 'Need the tenant name to finish search.', userClarification: { bot: 'coder', question: 'Which tenant?', answer: 'Use staging only; never production.' } }, next: 'coder', terms: ['staging'] },
  { id: 'complete', input: { ...base, lastBot: 'reviewer', lastOutput: 'Independent review and tests passed. Search works. All requested work is complete.' }, next: 'done' },
  { id: 'finalize', input: { ...base, lastBot: 'coder', lastOutput: 'Search draft exists; tests have not run and review is pending.', finalize: true }, next: 'done', summary: /pending|not|untested|unverified|remain/i },
];
const selectedCases = process.argv[3] ? cases.filter(c => process.argv[3].split(',').includes(c.id)) : cases;
const rounds = Number(process.argv[4] || 1);
if (!selectedCases.length || !Number.isInteger(rounds) || rounds < 1 || rounds > 3) throw Error('Invalid cases or rounds');
const workingDir = fs.mkdtempSync('/tmp/codey-scenario-json-');
const data = { baseRef, model: 'gpt-5.6-terra', effort: 'medium', cases: selectedCases.map(c => c.id), rounds, design: 'Authored scenarios with paired alternating order; fresh sessions, no retries. Checks are limited semantic smoke checks, not general model-quality proof.', calls: [] };
(async () => {
  for (let round = 0; round < rounds; round++) for (const [i, c] of selectedCases.entries()) for (const variant of (i + round) % 2 ? ['specialized', 'baseline'] : ['baseline', 'specialized']) {
    const impl = variant === 'baseline' ? baseline : current;
    const adapter = new CodexAdapter(); let response; const started = performance.now();
    let prompt;
    const turn = await impl.runAdvisor(c.input, { agent: 'codex', runner: async req => {
      prompt = req.prompt;
      response = await adapter.run({ ...req, agent: 'codex', model: { model: data.model, apiType: 'openai' },
        effort: data.effort, context: { workingDir } });
      return response;
    } });
    adapter.dispose?.();
    const predicted = turn.fallback ? 'invalid' : turn.escalateToUser ? 'user' : turn.done ? 'done' : turn.next;
    const correct = predicted === c.next && (c.terms || []).every(t => turn.instruction.toLowerCase().includes(t))
      && (c.next === 'done' ? !!turn.final_summary : !!turn.reason)
      && (!c.summary || c.summary.test(turn.final_summary || ''))
      && (!c.input.lastBot || c.input.finalize || !!turn.summary_of_last);
    data.calls.push({ case: c.id, round, variant, prompt, output: response?.output, tokens: response?.tokens ?? null,
      ms: performance.now() - started, turn, correct });
    fs.writeFileSync(out, JSON.stringify(data, null, 2));
    console.log(`${c.id} ${variant}: ${correct ? 'PASS' : 'FAIL'} ${response?.tokens?.total ?? 'unknown'} tokens`);
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
