import * as assert from 'assert';
import { AgentRequest, AgentResponse } from '../../packages/core/src/types';
import { runDispatcher, extractJsonObject, buildDispatcherPrompt } from '../../packages/core/src/dispatcher';

function makeRunner(output: string, success = true): (r: AgentRequest) => Promise<AgentResponse> {
  return async () => ({ success, output, error: success ? undefined : output });
}

async function main() {
  const members = [
    { name: 'architect', hint: 'designs systems' },
    { name: 'frontend',  hint: 'builds UI' },
    { name: 'reviewer',  hint: 'audits code' },
  ];

  // 1. Happy path: pure JSON
  let r = await runDispatcher({ task: 't', members },
    { agent: 'claude-code', runner: makeRunner('{"selected":["frontend","reviewer"],"reason":"UI change"}') });
  assert.deepStrictEqual(r.selected, ['frontend', 'reviewer']);
  assert.strictEqual(r.fallback, false);
  assert.strictEqual(r.reason, 'UI change');

  // 2. Reorder to input order
  r = await runDispatcher({ task: 't', members },
    { agent: 'claude-code', runner: makeRunner('{"selected":["reviewer","architect"],"reason":""}') });
  assert.deepStrictEqual(r.selected, ['architect', 'reviewer'], 'reorder to input order');

  // 3. Markdown-wrapped JSON
  r = await runDispatcher({ task: 't', members },
    { agent: 'claude-code', runner: makeRunner('Sure, here:\n```json\n{"selected":["architect"],"reason":"x"}\n```\n') });
  assert.deepStrictEqual(r.selected, ['architect']);
  assert.strictEqual(r.fallback, false);

  // 4. Filter unknown names
  r = await runDispatcher({ task: 't', members },
    { agent: 'claude-code', runner: makeRunner('{"selected":["frontend","ghost"],"reason":""}') });
  assert.deepStrictEqual(r.selected, ['frontend']);
  assert.strictEqual(r.fallback, false);

  // 5. Empty selection → fallback (all members)
  r = await runDispatcher({ task: 't', members },
    { agent: 'claude-code', runner: makeRunner('{"selected":[],"reason":""}') });
  assert.strictEqual(r.fallback, true);
  assert.deepStrictEqual(r.selected, ['architect', 'frontend', 'reviewer']);

  // 6. Non-JSON → fallback
  r = await runDispatcher({ task: 't', members },
    { agent: 'claude-code', runner: makeRunner('I cannot do that') });
  assert.strictEqual(r.fallback, true);

  // 7. Runner non-success → fallback
  r = await runDispatcher({ task: 't', members },
    { agent: 'claude-code', runner: makeRunner('boom', false) });
  assert.strictEqual(r.fallback, true);

  // 8. extractJsonObject edge cases
  assert.deepStrictEqual(extractJsonObject('{"a":1}'), { a: 1 });
  assert.deepStrictEqual(extractJsonObject('noise {"a":{"b":2}} more'), { a: { b: 2 } });
  assert.strictEqual(extractJsonObject(''), null);
  assert.strictEqual(extractJsonObject('no braces here'), null);
  assert.strictEqual(extractJsonObject('{ broken'), null);

  // 9. Prompt builder includes role + member lines
  const prompt = buildDispatcherPrompt({ task: 'do thing', members });
  assert.ok(prompt.includes('Task router'));
  assert.ok(prompt.includes('do thing'));
  assert.ok(prompt.includes('- architect: designs systems'));

  console.log('OK dispatcher-parse');
}
main().catch(e => { console.error(e); process.exit(1); });
