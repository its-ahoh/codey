const fs=require('fs'),path=require('path');
const d=require('./results/calls.json');
const lines=['# Coordination token experiment','',`Model: ${d.agent} / ${d.model}, effort ${d.effort}. Baseline: ${d.baseRef}.`,'',
'This is a synthetic coordination workload, not the percentage saved across the whole application. All usage values below were returned by real model calls.', '', '## Call elimination','', '| Scenario | Before calls | After calls | Before input / output | After input / output | Total-token reduction | Checks before / after |','|---|---:|---:|---:|---:|---:|---|'];
function totals(calls){return {input:calls.reduce((n,c)=>n+(c.tokens?.input??0),0),output:calls.reduce((n,c)=>n+(c.tokens?.output??0),0),total:calls.reduce((n,c)=>n+(c.tokens?.total??0),0),known:calls.every(c=>c.tokens!=null)};}
function cell(x){return x.known?`${x.input} / ${x.output}`:'unavailable';}
function percent(a,b){return a.known&&b.known&&a.total?((1-b.total/a.total)*100).toFixed(1)+'%':'unavailable';}
for(const id of [...new Set(d.scenarios.filter(s=>s.suite==='elimination').map(s=>s.case))]){
 const b=d.calls.filter(c=>c.suite==='elimination'&&c.case===id&&c.variant==='before'),a=d.calls.filter(c=>c.suite==='elimination'&&c.case===id&&c.variant==='after');
 const checks=['before','after'].map(v=>d.scenarios.find(s=>s.suite==='elimination'&&s.case===id&&s.variant===v)?.correct===undefined?'pending':d.scenarios.find(s=>s.suite==='elimination'&&s.case===id&&s.variant===v).correct?'pass':'FAIL');
 lines.push(`| ${id} | ${b.length} | ${a.length} | ${cell(totals(b))} | ${cell(totals(a))} | ${percent(totals(b),totals(a))} | ${checks.join(' / ')} |`);
}
const b=d.calls.filter(c=>c.suite==='elimination'&&c.variant==='before'),a=d.calls.filter(c=>c.suite==='elimination'&&c.variant==='after');
lines.push(`| **Total** | **${b.length}** | **${a.length}** | **${cell(totals(b))}** | **${cell(totals(a))}** | **${percent(totals(b),totals(a))}** | |`);
lines.push('','## Compact output (same effort and transport)','', '| Variant | Calls | Input | Output | Total | Correct routing + required instruction | Median ms |','|---|---:|---:|---:|---:|---:|---:|');
for(const variant of ['baseline','compact']){
 const calls=d.calls.filter(c=>c.suite==='output'&&c.variant===variant), t=totals(calls), s=d.scenarios.filter(s=>s.suite==='output'&&s.variant===variant);
 const ms=calls.map(c=>c.latencyMs).sort((a,b)=>a-b);
 lines.push(`| ${variant} | ${calls.length} | ${t.input} | ${t.output} | ${t.total} | ${s.filter(s=>s.correct).length}/${s.length} | ${ms.length?Math.round(ms[Math.floor(ms.length/2)]):'n/a'} |`);
}
lines.push('','| Case | Baseline input / output | Compact input / output | Correct baseline / compact |','|---|---:|---:|---|');
for(const id of [...new Set(d.scenarios.filter(s=>s.suite==='output').map(s=>s.case))]){
 const cells=['baseline','compact'].map(v=>cell(totals(d.calls.filter(c=>c.suite==='output'&&c.case===id&&c.variant===v))));
 const checks=['baseline','compact'].map(v=>{const s=d.scenarios.filter(s=>s.suite==='output'&&s.case===id&&s.variant===v);return s.filter(s=>s.correct).length+'/'+s.length});
 lines.push(`| ${id} | ${cells.join(' | ')} | ${checks.join(' / ')} |`);
}
lines.push('','## Scope and interpretation','',
'- Counts are actual Codey adapter invocations in this synthetic replay, not production telemetry or provider-internal inference round trips. The workload intentionally exercises repeated reads/polls; savings depend on how frequently those occur in real chats.',
'- Workers are represented by fixed synthetic results. Worker coding tokens, production task classification, and end-to-end desktop interactions are not measured. The common task classification call that supplied the reused title is outside this comparison.',
'- Parallel polling replays three unchanged observations versus one; the production change-trigger behavior is verified separately by regression tests. Unused closing replays one former summary request versus zero.',
'- Baseline judge and finalizer run frozen original source. Cache/title use current production helpers versus their former unconditional calls. Same configured Aide model is deliberately used for every scenario to isolate the code changes.',
'- The configured Advisor (Claude Code / claude-fable-5-1) failed its canary without reported usage. Advisor figures here use the controlled Codex model and cannot establish savings or correctness on that unavailable model.',
'- Tokens are CLI-reported input/output, including CLI context overhead. Cached input/reasoning breakdown is not retained by this adapter. These are not a dollar-cost estimate; missing usage is unknown, not zero.',
'- All requests use fresh sessions, medium effort, no cross-model fallback or retry, and 30-second per-call limits. Global CLI context/cache/service variation remains; observed input overhead sometimes changes by roughly 1,756 tokens, larger than the compact-output savings. Variant order alternates. Output cases repeat six authored examples twice, not twelve independent examples.',
'- Compact candidate only changes output instructions and omitted empty/default fields. It is not a hard token cap and has NOT been enabled in production. Instruction, summary, completion and escalation semantics are scored as well as the Bot name.',
'- Runtime: codex-cli 0.160.1; Claude Code 2.1.299. Existing CLI configuration/global instructions apply. No production model configuration was changed.',
'- Files: results/calls.json contains raw prompts/answers/usage; canary.json records model availability; results/evaluated/ freezes the compiled modules under test; *.baseline freezes original source.',
'', '## Verification', '',
'Core: 713 tests; Gateway: 649 tests. Initial full runs had only sandbox permission failures (5 + 22); rerunning their affected files with required permissions passed all 8 + 22 tests. This combines full-suite results with targeted environment retries, not a single unrestricted full run.',
'Additional cache validation regression: malformed model output must not be cached as a permanent successful overview. Strict validation added for the Gateway cache path; legacy display-fallback behavior remains available. Three new Core cases and one Gateway cache integration case pass; Core/Gateway rebuild and desktop typecheck also pass.',
'', '## Decision', '', 'Keep call elimination. The measured coordination replay saves 66.8% of reported tokens (12 adapter calls become 4), with all seven scenario checks passing on both sides. This is workload-specific, not an application-wide percentage.', '', 'Do not enable the appended compact-output candidate: output falls from 1,152 to 968 tokens (16.0%), but total only falls from 223,064 to 222,732 (0.15%). Round 0 saves 2.5% while round 1 costs 2.3% more. Both variants pass all 12 scored cases; correctness on this small authored set does not establish general reliability. CLI input overhead and variation dominate. Hard token truncation was not tested and is not recommended for structured routing JSON because it can destroy the required fields.');
const followupFile=path.join(__dirname,'results/first-turn.json');
if(fs.existsSync(followupFile)) {
 const f=JSON.parse(fs.readFileSync(followupFile,'utf8'));
 lines.push('', '## First-turn-only specialized instructions', '', 'A separate fresh paired experiment replaces the general Instructions section with a first-turn-specific schema; it does not append a second instruction block. Same task and roster, same model/effort. Two unique tasks repeated twice. Not enabled in production.', '', '| Variant | Calls | Input | Output | Total | Correct |', '|---|---:|---:|---:|---:|---:|');
 for(const v of ['baseline','specialized']) {
  const c=f.calls.filter(c=>c.variant===v),t=totals(c);
  lines.push(`| ${v} | ${c.length} | ${t.input} | ${t.output} | ${t.total} | ${c.filter(c=>c.correct).length}/${c.length} |`);
 }
 if(f.completedAt) {
  const b=totals(f.calls.filter(c=>c.variant==='baseline')),a=totals(f.calls.filter(c=>c.variant==='specialized'));
  lines.push('',`Total-token reduction: ${percent(b,a)}. Raw evidence: results/first-turn.json. Treat this as a pilot for the first routing step only; no conclusion about revising workers, finalizing tasks, or escalating questions.`);
 }
}
fs.writeFileSync(path.join(__dirname,'REPORT.md'),lines.join('\n')+'\n');console.log(lines.slice(0,30).join('\n'));
