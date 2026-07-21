import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Explicit allowlist of vitest test files. Other `*.test.ts` files in src/
    // (advisor, context, etc.) are legacy ts-node/node:test scripts and would
    // crash vitest's collection phase. New vitest tests must be added here.
    include: [
      'src/workspace.test.ts',
      'src/workers.test.ts',
      'src/team-display.test.ts',
      'src/discussion/files.test.ts',
      'src/discussion/control.test.ts',
      'src/discussion/parallel-advisor.test.ts',
      'src/task-brief.test.ts',
      'src/aide-tasks.test.ts',
      'src/agents/thinking-stream.test.ts',
      'src/agents/browser-mcp.test.ts',
      'src/solo-advisor.test.ts',
      'src/team-graph.test.ts',
      'src/judge.test.ts',
      'src/skill-crystallizer.test.ts',
      'src/aide-automation.test.ts',
    ],
    exclude: ['dist/**', 'node_modules/**'],
  },
});
