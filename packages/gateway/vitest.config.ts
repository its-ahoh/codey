import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Explicit allowlist of vitest test files. The other `*.test.ts` files in
    // src/ (chats, pairings, turn-queue) are legacy scripts run via
    // `npx ts-node ...` — some use node:test, some use top-level IIFE patterns
    // — and they crash vitest's collection phase. New vitest tests must be
    // added to this list.
    include: [
      'src/config.test.ts',
      'src/digit-mapping.test.ts',
      'src/team-pause.test.ts',
      'src/chats.discussion.test.ts',
      'src/chats.taskBrief.test.ts',
      'src/chats.fallbackHeal.test.ts',
      'src/chats.updateMessage.test.ts',
      'src/parallel-team.test.ts',
      'src/team-emitter.test.ts',
    ],
    exclude: ['dist/**', 'node_modules/**'],
  },
})
