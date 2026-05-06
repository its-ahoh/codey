// Run: npx ts-node packages/core/src/manager.test.ts
import * as assert from 'assert';
import { runManager, ManagerInput, ManagerTurn, ManagerRunner } from './manager';
import { AgentRequest, AgentResponse } from './types';

function makeRunner(replies: string[]): ManagerRunner {
  let i = 0;
  return async (_req: AgentRequest): Promise<AgentResponse> => {
    const output = replies[Math.min(i, replies.length - 1)];
    i++;
    return { success: true, output, agent: 'claude-code' } as AgentResponse;
  };
}

function failingRunner(error: string): ManagerRunner {
  return async () => ({ success: false, output: '', error, agent: 'claude-code' } as AgentResponse);
}

const baseInput: ManagerInput = {
  task: 'Audit and improve the auth flow',
  members: [
    { name: 'architect', hint: 'Designs systems' },
    { name: 'reviewer', hint: 'Critiques designs' },
  ],
  history: [],
  lastWorker: null,
  lastOutput: null,
};

async function testFirstTurnPicksWorker() {
  const runner = makeRunner([JSON.stringify({
    summary_of_last: '',
    next: 'architect',
    instruction: 'Draft the auth flow',
    reason: 'Architect should start',
    done: false,
  })]);
  const turn = await runManager(baseInput, { agent: 'claude-code', runner });
  assert.strictEqual(turn.fallback, false, 'should not fallback on valid response');
  assert.strictEqual(turn.next, 'architect');
  assert.strictEqual(turn.done, false);
  assert.strictEqual(turn.instruction, 'Draft the auth flow');
  assert.strictEqual(turn.summary_of_last, '');
}

async function testMidRunWithHistory() {
  const input: ManagerInput = {
    ...baseInput,
    history: [{ worker: 'architect', summary: 'Drafted v1 of auth flow' }],
    lastWorker: 'architect',
    lastOutput: 'Here is the v1 draft of the auth flow...',
  };
  const runner = makeRunner([JSON.stringify({
    summary_of_last: 'Architect drafted v1.',
    next: 'reviewer',
    instruction: 'Critique v1',
    reason: 'Need a review pass',
    done: false,
  })]);
  const turn = await runManager(input, { agent: 'claude-code', runner });
  assert.strictEqual(turn.next, 'reviewer');
  assert.strictEqual(turn.summary_of_last, 'Architect drafted v1.');
  assert.strictEqual(turn.done, false);
}

async function testDoneTermination() {
  const runner = makeRunner([JSON.stringify({
    summary_of_last: 'Reviewer signed off.',
    next: null,
    instruction: '',
    reason: 'Task complete',
    done: true,
    final_summary: 'Architect drafted, reviewer approved.',
  })]);
  const turn = await runManager(baseInput, { agent: 'claude-code', runner });
  assert.strictEqual(turn.done, true);
  assert.strictEqual(turn.next, null);
  assert.strictEqual(turn.final_summary, 'Architect drafted, reviewer approved.');
}

async function testFinalizeMode() {
  const runner = makeRunner([JSON.stringify({
    summary_of_last: '',
    next: null,
    instruction: '',
    reason: 'cap reached',
    done: true,
    final_summary: 'Final wrap-up.',
  })]);
  const turn = await runManager({ ...baseInput, finalize: true }, { agent: 'claude-code', runner });
  assert.strictEqual(turn.done, true);
  assert.strictEqual(turn.final_summary, 'Final wrap-up.');
}

async function testUnknownWorkerFallsBack() {
  const runner = makeRunner([JSON.stringify({
    summary_of_last: '',
    next: 'designer', // not in roster
    instruction: 'do design',
    reason: 'r',
    done: false,
  })]);
  const turn = await runManager(baseInput, { agent: 'claude-code', runner });
  assert.strictEqual(turn.fallback, true, 'unknown worker should fallback');
}

async function testMalformedJsonFallsBack() {
  const runner = makeRunner(['not json at all']);
  const turn = await runManager(baseInput, { agent: 'claude-code', runner });
  assert.strictEqual(turn.fallback, true);
  assert.ok(turn.fallbackReason && turn.fallbackReason.length > 0);
}

async function testRunnerErrorFallsBack() {
  const turn = await runManager(baseInput, {
    agent: 'claude-code',
    runner: failingRunner('boom'),
  });
  assert.strictEqual(turn.fallback, true);
  assert.ok(turn.fallbackReason!.includes('boom'));
}

async function testEmptyMembersReturnsDone() {
  const turn = await runManager(
    { ...baseInput, members: [] },
    { agent: 'claude-code', runner: makeRunner(['{}']) },
  );
  assert.strictEqual(turn.done, true);
  assert.strictEqual(turn.next, null);
  assert.strictEqual(turn.fallback, false);
}

async function testNullNextWithoutDoneFallsBack() {
  // Manager returned next:null but done:false — invalid, should fallback.
  const runner = makeRunner([JSON.stringify({
    summary_of_last: '',
    next: null,
    instruction: '',
    reason: 'r',
    done: false,
  })]);
  const turn = await runManager(baseInput, { agent: 'claude-code', runner });
  assert.strictEqual(turn.fallback, true);
}

async function run() {
  await testFirstTurnPicksWorker();
  await testMidRunWithHistory();
  await testDoneTermination();
  await testFinalizeMode();
  await testUnknownWorkerFallsBack();
  await testMalformedJsonFallsBack();
  await testRunnerErrorFallsBack();
  await testEmptyMembersReturnsDone();
  await testNullNextWithoutDoneFallsBack();
  console.log('manager.test.ts: all tests passed');
}

run().catch(err => { console.error(err); process.exit(1); });
