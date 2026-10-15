// Live model experiment. Synthetic data only. Never changes production configuration.
const fs = require('fs'), path = require('path');
const { execFileSync } = require('child_process');
const Module = require('module'), ts = require('typescript');
const root = path.resolve(__dirname, '../..');
const core = require('../../packages/core/dist');
const { CodexAdapter } = require('../../packages/core/dist/agents/codex');
const { TaskBriefCache } = require('../../packages/gateway/dist/task-brief-cache');
const { openingChatTitle } = require('../../packages/gateway/dist/chat-title');
const finalizer = require('../../packages/gateway/dist/team-finalizer');
const out = path.resolve(process.argv[2] || path.join(__dirname, 'results'));
fs.mkdirSync(out, { recursive: true });
if (fs.existsSync(path.join(out, 'calls.json'))) throw new Error('Refusing to overwrite results');
const baseRef = process.env.CODEY_EVAL_BASE_REF || '80071d138e6e65b63fff758663576d56ca2fe040';
function baseline(file) {
 const src = execFileSync('git', ['show', `${baseRef}:${file}`], { cwd: root, encoding: 'utf8' });
 fs.writeFileSync(path.join(out, path.basename(file)+'.baseline'), src);
 const filename = path.join(root, file.replace('/src/', '/dist/').replace(/\.ts$/, '.js'));
 const mod = new Module(filename, module); mod.filename = filename; mod.paths = Module._nodeModulePaths(path.dirname(filename));
 mod._compile(ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText, filename);
 return mod.exports;
}
const oldJudge = baseline('packages/core/src/judge.ts');
const oldFinal = baseline('packages/gateway/src/team-finalizer.ts');
const workingDir = fs.mkdtempSync('/tmp/codey-coordination-eval-');
const data = { baseRef, model: 'gpt-5.6-terra', agent: 'codex', effort: 'medium', startedAt: new Date().toISOString(),
 design: 'Controlled synthetic workload replay. Actual CodexAdapter calls and reported tokens; no production chats or worker execution. Same model/effort, no fallback/retry, fresh sessions. Alternating before/after order. Parallel polling and closing are explicit workload replays; cache/judge/title/finalizer execute their production functions. Baseline modules frozen from baseRef; current build captures uncommitted optimizations.', calls: [], scenarios: [] };
function persist() { fs.writeFileSync(path.join(out, 'calls.json'), JSON.stringify(data, null, 2)); }
async function live(req, tag) {
 const adapter = new CodexAdapter(), start = performance.now();
 let res;
 try { res = await adapter.run({ ...req, agent:'codex', model:{model:data.model,apiType:'openai'}, effort:'medium', context:{workingDir}, signal: AbortSignal.timeout(30000) }); }
 catch { res = {success:false, output:'', error:'adapter failure'}; }
 adapter.dispose?.();
 data.calls.push({ ...tag, prompt:req.prompt, latencyMs:performance.now()-start, success:res.success, output:res.output,
 tokens:res.tokens??null, failure:res.success?null:'adapter_error_or_timeout' }); persist();
 console.log(`${tag.case} ${tag.variant} ${tag.round??0}: ${res.success?'ok':'FAILED'} ${res.tokens?.total??'unknown'} tokens`);
 return res;
}
const members = [{name:'coder',hint:'Implements code and fixes defects'}, {name:'reviewer',hint:'Reviews changes and verifies tests'}, {name:'writer',hint:'Writes user documentation'}];
const baseInput = { task:'Implement search and have the reviewer verify it.', members, history:[], lastBot:null, lastOutput:null };
const chat = () => ({id:'demo',title:'Search',messages:[
 {id:'u',role:'user',timestamp:1,content:'Implement search and verify the tests.'},
 {id:'a',role:'assistant',timestamp:2,content:'Search implemented. All search tests passed. No remaining work.',toolCalls:[]}
]});
const bot = (extra={}) => ({id:'a',role:'assistant',timestamp:2,bot:'coder',botStatus:'done',teamTurnId:'t',content:'Search implemented.',...extra});
const finalInput = {teamTurnId:'t',task:baseInput.task,messages:[bot(),bot({id:'b',bot:'reviewer',content:'Reviewed search. All tests passed. No remaining work.'})]};
const cases = [
 ['single-edge', async (variant, run) => (variant==='before'?oldJudge:core).runJudge({task:baseInput.task,bot:'coder',botOutput:'Search implemented.',blackboardSummary:'',edges:[{id:'review',targetBot:'reviewer'}]}, {agent:'codex',runner:run}), value=>value.edgeId==='review'&&!value.fallback],
 ['title-reuse', async (variant, run) => variant==='before'?core.generateChatTitle('Prepare release notes for search.',{agent:'codex',runner:run}):openingChatTitle('Search release notes',()=>core.generateChatTitle('Prepare release notes for search.',{agent:'codex',runner:run})), value=>typeof value==='string'&&value.length>0&&value.length<=41],
 ['overview-three-reads', async (variant,run)=>{
   const c=chat(), cache=new TaskBriefCache(); const generate=s=>core.generateTaskBrief(s,{agent:'codex',runner:run}); const values=[];
   for(let i=0;i<3;i++) values.push(variant==='before'?await generate(c):await cache.get('demo',()=>c,b=>{c.taskBrief=b},generate)); return values;
 }, values=>values.every(v=>v?.state.status==='done'&&v.goal?.length>0)],
 ['clean-team-summary', async (variant,run)=>{
   const input={...baseInput,history:[{bot:'coder',summary:'Search implemented.'}],lastBot:'reviewer',lastOutput:'Reviewed search. All tests passed. No remaining work.'};
   const decision=await core.runAdvisor(input,{agent:'codex',runner:run});
   const message=await (variant==='before'?oldFinal:finalizer).composeTeamFinal({...finalInput,advisorSummary:decision.final_summary,run:async prompt=>{const r=await run({prompt});if(!r.success)throw Error('failed');return r.output}});
   return {decision,message};
 }, v=>v.decision.done&&!v.decision.fallback&&v.message?.teamFinal.outcome==='completed'&&/search/i.test(v.message.content)],
 ['failed-team-summary', async (variant,run)=>(variant==='before'?oldFinal:finalizer).composeTeamFinal({...finalInput,
   messages:[bot(),bot({id:'b',bot:'reviewer',botStatus:'failed',content:'Could not run checks.',botFailureReason:'Missing sandbox access',botNextUserAction:{text:'Grant sandbox access'}})],advisorSummary:'Finished.',
   run:async prompt=>{const r=await run({prompt});if(!r.success)throw Error('failed');return r.output}}), v=>v?.teamFinal.outcome==='failed'&&/access/i.test(v.content)],
 ['unchanged-three-polls',async (variant,run)=>{
   const prompt=core.buildParallelAdvisorPrompt({topic:'Compare two search designs; wait for both reviewers to finish before deciding.',summary:'Reviews still running.',opinions:[{name:'coder',text:'Still working; no conclusion yet.'},{name:'reviewer',text:'Checks running; no conclusion yet.'}],pendingAsks:[],idleMs:0,revision:1});
   const results=[];for(let i=0;i<(variant==='before'?3:1);i++){const r=await run({prompt});results.push(r.success?core.parseParallelAdvisorTurn(r.output):null)}return results;
 },values=>values.every(v=>v?.action==='continue')],
 ['unused-closing',async (variant,run)=>{
   if(variant==='after')return {skipped:true};
   return core.runAdvisor({...baseInput,history:[{bot:'coder',summary:'Implementation incomplete after step limit.'}],lastBot:'coder',lastOutput:'Implementation is unfinished; do not claim completion.',finalize:true},{agent:'codex',runner:run});
 },v=>v.skipped||(!v.fallback&&v.done&&!!v.final_summary)],
];
const outputCases = [
 {id:'first-implementation', input:baseInput, expected:'coder', terms:['search']},
 {id:'first-docs',input:{...baseInput,task:'Write a user guide for the existing search feature. No code changes.'},expected:'writer',terms:['guide','search']},
 {id:'review-next',input:{...baseInput,lastBot:'coder',lastOutput:'Implemented search. Please have reviewer independently verify the tests.',history:[]},expected:'reviewer',terms:['test','verify']},
 {id:'revision',input:{...baseInput,lastBot:'reviewer',lastOutput:'Found a null-query crash. Coder must fix it and add a regression test before review can pass.',history:[{bot:'coder',summary:'Search implemented.'}]},expected:'coder',terms:['null','crash']},
 {id:'human-question',input:{...baseInput,lastBot:'coder',lastOutput:'Need the private deployment destination.',pendingQuestion:{bot:'coder',question:'Which private deployment destination should be used? Only the user knows.'}},expected:'user',terms:[]},
 {id:'complete',input:{...baseInput,lastBot:'reviewer',lastOutput:'Independent review and tests passed. Search works. All requested work completed.',history:[{bot:'coder',summary:'Implemented search.'}]},expected:'done',terms:[]}
];
function compact(prompt) {
 return prompt+'\n\n## Output budget (overrides redundant field requirements above)\nKeep all routing and safety decisions unchanged. Return JSON only. For a next-bot decision, return next, instruction, reason, and summary_of_last only when there is a previous output. Omit done:false, empty strings, null fields and final_summary while routing. Keep instruction concrete and within 35 words, reason within 10 words, and summary_of_last within 25 words; preserve defects, constraints and required verification. On completion or escalation keep done:true and all applicable final_summary/escalate_to_user fields and sufficient evidence; do not shorten away unfinished work or user actions. No prose outside JSON.';
}
function decision(turn){return turn.fallback?'invalid':turn.escalateToUser?'user':turn.done?'done':turn.next;}
(async()=>{
 for(let i=0;i<cases.length;i++)for(const variant of i%2?['after','before']:['before','after']){
  const [id,work,validate]=cases[i], start=data.calls.length;
  let value, error;
  try{value=await work(variant,req=>live(req,{suite:'elimination',case:id,variant}));}catch{error='scenario_failed';}
  data.scenarios.push({suite:'elimination',case:id,variant,calls:data.calls.length-start,correct:!error&&validate(value),value:value??null,error});persist();
 }
 for(let round=0;round<2;round++)for(let i=0;i<outputCases.length;i++)for(const variant of (i+round)%2?['compact','baseline']:['baseline','compact']){
  const c=outputCases[i],start=data.calls.length;
  const turn=await core.runAdvisor(c.input,{agent:'codex',runner:req=>live({...req,prompt:variant==='compact'?compact(req.prompt):req.prompt},{suite:'output',case:c.id,variant,round})});
  const predicted=decision(turn), text=turn.instruction.toLowerCase();
  const preservesInstruction=!['coder','reviewer','writer'].includes(c.expected)||(text.length>0&&c.terms.some(t=>text.includes(t)));
  data.scenarios.push({suite:'output',case:c.id,variant,round,calls:data.calls.length-start,expected:c.expected,predicted,correct:predicted===c.expected&&preservesInstruction,preservesInstruction,turn});persist();
 }
 data.completedAt=new Date().toISOString();persist();
})().catch(e=>{console.error(e.message);process.exitCode=1});
