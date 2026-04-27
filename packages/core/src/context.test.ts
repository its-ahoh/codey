// Run: npx ts-node packages/core/src/context.test.ts
import * as assert from 'assert';
import { ContextManager } from './context';

async function run() {
  const cm = new ContextManager({ maxTokenBudget: 50000, maxTurns: 10, ttlMs: 60000 });

  // Two distinct conversations within the same "channel": state must not leak.
  await cm.addUserTurn('conv-a', 'hello from A');
  await cm.addUserTurn('conv-b', 'hello from B');

  const a = cm.getWindow('conv-a');
  const b = cm.getWindow('conv-b');

  assert.ok(a, 'conv-a window should exist');
  assert.ok(b, 'conv-b window should exist');
  assert.strictEqual(a!.turns.length, 1, 'conv-a should have 1 turn');
  assert.strictEqual(a!.turns[0].text, 'hello from A');
  assert.strictEqual(b!.turns.length, 1, 'conv-b should have 1 turn');
  assert.strictEqual(b!.turns[0].text, 'hello from B');

  // Two senders can append to the same conversation — shared history.
  await cm.addUserTurn('conv-a', 'second message');
  const a2 = cm.getWindow('conv-a');
  assert.strictEqual(a2!.turns.length, 2);

  // listConversationIds includes both
  const ids = cm.listConversationIds();
  assert.ok(ids.includes('conv-a'), 'conv-a should be listed');
  assert.ok(ids.includes('conv-b'), 'conv-b should be listed');

  console.log('✓ context keyed by conversationId');

  // Session anchors are scoped per-window and survive setSessionAnchor /
  // clearSessionAnchor / clearAllSessionAnchors as expected.
  await cm.setSessionAnchor('conv-a', { agent: 'claude-code', sessionId: 'sid-a' });
  await cm.setSessionAnchor('conv-b', { agent: 'claude-code', sessionId: 'sid-b' });
  assert.strictEqual(cm.getWindow('conv-a')!.sessionAnchor?.sessionId, 'sid-a');
  assert.strictEqual(cm.getWindow('conv-b')!.sessionAnchor?.sessionId, 'sid-b');

  await cm.clearSessionAnchor('conv-a');
  assert.strictEqual(cm.getWindow('conv-a')!.sessionAnchor, undefined);
  assert.strictEqual(cm.getWindow('conv-b')!.sessionAnchor?.sessionId, 'sid-b');

  cm.clearAllSessionAnchors();
  assert.strictEqual(cm.getWindow('conv-b')!.sessionAnchor, undefined);

  console.log('✓ session anchors set/clear/clearAll');
}

run().catch((err) => { console.error(err); process.exit(1); });
