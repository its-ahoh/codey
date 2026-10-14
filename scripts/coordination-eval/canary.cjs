const fs=require('fs');
const {CodexAdapter}=require('../../packages/core/dist/agents/codex');
const {ClaudeCodeAdapter}=require('../../packages/core/dist/agents/claude-code');
(async()=>{
 const cfg=JSON.parse(fs.readFileSync(process.env.HOME+'/.codey/gateway.json','utf8'));
 const rows=[]; const cwd=fs.mkdtempSync('/tmp/codey-coordination-canary-');
 for(const role of ['advisor','aide']) {
  const conf=cfg[role]; const C=conf.agent==='codex'?CodexAdapter:ClaudeCodeAdapter; const adapter=new C();
  const started=Date.now();const response=await adapter.run({agent:conf.agent,model:{model:conf.model,apiType:conf.agent==='codex'?'openai':'anthropic'},effort:'medium',prompt:'Return exactly the JSON object {"ready":true}. No tools.',context:{workingDir:cwd},signal:AbortSignal.timeout(30000)});
  rows.push({role,agent:conf.agent,model:conf.model,success:response.success,tokens:response.tokens??null,ms:Date.now()-started,output:response.success?response.output:null,failure:response.success?null:'adapter_error_or_timeout'}); adapter.dispose?.();
  fs.writeFileSync(__dirname+'/canary.json',JSON.stringify(rows,null,2));console.log(JSON.stringify(rows.at(-1)));
 }
})().catch(e=>{console.error(e.message);process.exitCode=1});
