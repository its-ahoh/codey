/**
 * verify-gateway.ts
 * In-process gateway smoke test.
 *
 * Boots the Codey class with a minimal config, sends a fake prompt via
 * processPromptHttp(), and asserts the user turn was recorded in the
 * context manager — without needing a real coding agent.
 *
 * Agent execution will fail (no real agent binary), but the context
 * manager records the user turn regardless of whether the agent
 * succeeds, so the assertion still passes.
 */
import * as assert from 'assert';
import * as path from 'path';
import { GatewayConfig } from '@codey/core';

const repoRoot = path.resolve(__dirname, '..');
process.chdir(repoRoot);

async function run() {
  // Import Codey from the gateway package.
  const { Codey } = await import(path.join(repoRoot, 'packages', 'gateway', 'dist', 'gateway.js'));

  // Minimal config — no channels, so no network connections are attempted.
  const config: GatewayConfig = {
    port: 3099,
    channels: {},           // no Telegram / Discord / iMessage
    defaultAgent: 'claude-code',
    agents: {
      'claude-code': {
        enabled: true,
        provider: 'anthropic',
        defaultModel: 'claude-sonnet-4-20250514',
      },
    },
    rateLimitMs: 0,         // disable rate limiting
    planner: { enabled: false },  // disable planner to skip LLM call
    memory: { enabled: false, autoExtract: false },
    context: {
      maxTokenBudget: 12000,
      maxTurns: 30,
      ttlMinutes: 60,
    },
  };

  // Construct gateway without calling start() — avoids channel init + workspace.load()
  const gateway = new Codey(config);

  // Send a prompt via the public HTTP API handler.
  // The agent spawn will fail (no real claude-code binary), but that's fine.
  // processPromptHttp adds the user turn to the context manager regardless.
  const convId = 'smoke-test-conv';
  try {
    await gateway.processPromptHttp('hello smoke test', undefined, convId);
  } catch {
    // Ignore any errors from the agent spawn attempt.
  }

  // Introspect the private contextManager field.
  const contextManager = (gateway as any).contextManager;
  assert.ok(contextManager, 'contextManager field exists on gateway');

  const window = contextManager.getWindow(convId);
  assert.ok(window, `context window exists for conversationId "${convId}"`);
  assert.ok(window.turns.length >= 1, `context window has at least 1 turn (got ${window.turns.length})`);

  const userTurn = window.turns.find((t: any) => t.role === 'user');
  assert.ok(userTurn, 'at least one user turn recorded');

  console.log('✓ gateway records user turn keyed by conversationId');
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
