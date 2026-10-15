// Controlled first-step experiment; consumes CLI quota, no worker execution.
const fs = require('fs');
const path = require('path');
const { runAdvisor } = require('../../packages/core/dist/advisor');
const { CodexAdapter } = require('../../packages/core/dist/agents/codex');
const { ClaudeCodeAdapter } = require('../../packages/core/dist/agents/claude-code');
const { routeAutomaticFirst, canUseAideForFirstRoute } = require('../../packages/gateway/dist/automatic-first-route');
const out = path.resolve(process.argv[2] || path.join(__dirname, 'results/first-route.json'));
if (fs.existsSync(out)) throw Error('Refusing to overwrite results');
const cfg = JSON.parse(fs.readFileSync(process.env.HOME + '/.codey/gateway.json', 'utf8'));
const identities = Object.fromEntries(['aide', 'advisor'].map(role => [role, { agent: cfg[role]?.agent, model: cfg[role]?.model }]));
const cwd = fs.mkdtempSync('/tmp/codey-first-route-');
const data = { model: 'gpt-5.6-terra', effort: 'medium', configured: identities,
  design: 'Six synthetic first-step pairs, alternating order. Both sides use the same available Codex model to isolate prompt/routing overhead. No worker calls. Configured Advisor availability is checked separately. Full-run and pricing savings are not measured.', calls: [], scenarios: [] };
const save = () => fs.writeFileSync(out, JSON.stringify(data, null, 2));
async function live(req, tag) {
  const adapter = new CodexAdapter(); const start = performance.now();
  let response;
  try {
    response = await adapter.run({ ...req, agent: 'codex', model: { model: data.model, apiType: 'openai' },
      effort: 'medium', context: { workingDir: cwd } });
  } finally { adapter.dispose?.(); }
  data.calls.push({ ...tag, prompt: req.prompt, output: response.output, tokens: response.tokens ?? null,
    success: response.success, ms: performance.now() - start }); save(); return response;
}
const base = { history: [], lastBot: null, lastOutput: null,
  members: [{ name: 'coder', hint: 'Programming concepts and implementation' },
    { name: 'writer', hint: 'Language translation and user documentation' }, { name: 'reviewer', hint: 'Code review and tests' }] };
const cases = [
  { id: 'explain', task: 'Explain a hash table in plain language.', expected: 'coder', aide: true },
  { id: 'translate', task: 'Translate to French: Good morning.', expected: 'writer', aide: true },
  { id: 'chinese', task: '请解释闭包的含义。', expected: 'coder', aide: true }, // lint-allow-non-english: Chinese routing patterns and synthetic multilingual cases.
  { id: 'implement', task: 'Implement a hash table and have the reviewer verify the tests.', expected: 'coder', aide: false },
  { id: 'compound', task: 'Explain the cache, then fix the eviction bug and review it.', expected: 'coder', aide: false },
  { id: 'uncertain', task: 'Explain Sanskrit grammar.', members: [{ name: 'billing', hint: 'Only invoice accounting; cannot answer language questions' }, { name: 'release', hint: 'Only software deployment; cannot answer language questions' }], aide: true, abstain: true },
];
(async () => {
  if (identities.advisor.agent === 'claude-code') {
    const adapter = new ClaudeCodeAdapter();
    const response = await adapter.run({ agent: 'claude-code', model: { model: identities.advisor.model, apiType: 'anthropic' },
      prompt: 'Return exactly {"ready":true}. No tools.', context: { workingDir: cwd }, signal: AbortSignal.timeout(30000) });
    data.advisorCanary = { success: response.success, tokens: response.tokens ?? null, output: response.success ? response.output : null };
    adapter.dispose?.(); save();
  }
  for (const [i, c] of cases.entries()) for (const variant of i % 2 ? ['optimized', 'baseline'] : ['baseline', 'optimized']) {
    const input = { ...base, task: c.task, members: c.members || base.members };
    const start = data.calls.length; let turn = null; let usedAide = false; let aideResolved = false;
    if (variant === 'optimized' && canUseAideForFirstRoute(input)) {
      usedAide = true;
      turn = await routeAutomaticFirst(input, { agent: 'codex', runner: req => live(req, { case: c.id, variant, role: 'aide' }) });
      aideResolved = !!turn;
    }
    turn ??= await runAdvisor(input, { agent: 'codex', runner: req => live(req, { case: c.id, variant, role: 'advisor' }) });
    const correct = c.abstain ? (variant === 'baseline' || (usedAide && !aideResolved))
      : !turn.fallback && turn.next === c.expected && !!turn.instruction && !!turn.reason
        && (variant === 'baseline' || (usedAide === c.aide && (!c.aide || aideResolved)))
        && (!aideResolved || turn.instruction === c.task);
    data.scenarios.push({ case: c.id, variant, correct, usedAide, aideResolved, turn, calls: data.calls.length - start }); save();
    console.log(`${c.id} ${variant}: ${correct ? 'PASS' : 'FAIL'}, ${data.calls.length - start} calls`);
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
