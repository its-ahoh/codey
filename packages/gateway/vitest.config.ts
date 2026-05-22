import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Explicit allowlist of files that use vitest (describe/it/expect).
    // Other .test.ts files in this package are legacy `npx ts-node` scripts
    // that use node:assert with no describe/it blocks — they crash vitest's
    // discovery. Compiled dist/ artifacts are also excluded.
    // To add a new vitest test, append its path here.
    include: [
      'src/config.test.ts',
      'src/digit-mapping.test.ts',
      'src/team-pause.test.ts',
    ],
    exclude: ['dist/**', 'node_modules/**'],
  },
})
