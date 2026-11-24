import { defineConfig } from '@playwright/test'

// Drives the real Electron app (main process + built renderer) in an isolated
// test home. Run with `npm run test:e2e`; see e2e/README.md.
export default defineConfig({
  testDir: 'e2e',
  outputDir: 'test-results',
  // Each test launches its own Codey; one at a time keeps them independent.
  workers: 1,
  timeout: 90_000,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
})
