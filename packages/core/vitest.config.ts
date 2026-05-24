import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Explicit allowlist of vitest test files. Other `*.test.ts` files in src/
    // (advisor, context, etc.) are legacy ts-node/node:test scripts and would
    // crash vitest's collection phase. New vitest tests must be added here.
    include: [
      'src/workspace.test.ts',
      'src/workers.test.ts',
      'src/discussion/files.test.ts',
      'src/discussion/control.test.ts',
      'src/discussion/parallel-advisor.test.ts',
    ],
    exclude: ['dist/**', 'node_modules/**'],
  },
});
