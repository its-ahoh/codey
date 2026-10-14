// Focused follow-up: replace the general instructions rather than append a budget.
const fs=require('fs'),path=require('path');
const {CodexAdapter}=require('../../packages/core/dist/agents/codex');
const core=require('../../packages/core/dist');
const source=require('./results/calls.json');
const cases=source.calls.filter(c=>c.suite==='output'&&c.variant==='baseline'&&c.round===0&&c.case.startsWith('first-'));
const output=path.join(__dirname,'results/first-turn.json');
if(fs.existsSync(output))throw Error('Refusing to overwrite');
const cwd=fs.mkdtempSync('/tmp/codey-first-turn-');
const data={model:source.model,effort:'medium',calls:[],design:'Two first-turn fixtures, each repeated twice, freshly paired alternating order. Only the Instructions section changes. General task/history/roster sections remain identical. Not applicable to mid-run routing, completion, pending questions or resume.'};
const instructions=`You coordinate the first step of this team; never execute the task yourself.
Choose exactly one Bot from the roster to start the user's task. Respect explicit assignments and ordering. Do not invent names. Give a concrete instruction preserving the user's constraints and a short reason for the UI.
Return JSON only: {"next":"exact bot name","instruction":"one sentence, at most 35 words","reason":"at most 10 words"}.
This is the first turn, so omit summary_of_last, done:false, null fields and empty fields. If no work is needed, return {"done":true,"final_summary":"explain why"} instead. Do not omit meaningful task requirements to fit the word target.`;
(async()=>{
for(let round=0;round<2;round++)for(let i=0;i<cases.length;i++)for(const variant of (i+round)%2?['specialized','baseline']:['baseline','specialized']){
 const c=cases[i];const prompt=variant==='baseline'?c.prompt:c.prompt.replace(/## Instructions\n\n[\s\S]*?\n\n## Task/,`## Instructions\n\n${instructions}\n\n## Task`);
 const adapter=new CodexAdapter(),started=performance.now();
 const r=await adapter.run({agent:'codex',model:{model:data.model,apiType:'openai'},effort:'medium',prompt,context:{workingDir:cwd},signal:AbortSignal.timeout(30000)});adapter.dispose?.();
 const parsed=core.extractJsonObject(r.output),expected=c.case==='first-implementation'?'coder':'writer';
 const instruction=typeof parsed?.instruction==='string'?parsed.instruction:'';
 data.calls.push({case:c.case,variant,round,prompt,output:r.output,tokens:r.tokens??null,latencyMs:performance.now()-started,success:r.success,correct:r.success&&parsed?.next===expected&&instruction.toLowerCase().includes('search')&&!!parsed?.reason&&(!parsed.done),expected});
 fs.writeFileSync(output,JSON.stringify(data,null,2));console.log(`${c.case} ${variant} ${round}: ${r.tokens?.total??'unknown'} tokens`);
}
data.completedAt=new Date().toISOString();fs.writeFileSync(output,JSON.stringify(data,null,2));
})().catch(e=>{console.error(e.message);process.exitCode=1});
