import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Point CODEY_HOME at a throwaway directory for the whole suite.
 *
 * `SecretStore` and `ApiTokenStore` default to `~/.codey/`. A test that builds
 * one without an explicit path would otherwise read — and write — the
 * developer's real credentials: a config fixture containing `sk-1` would be
 * "migrated" straight into their actual secret store.
 */
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-test-home-'));
process.env.CODEY_HOME = home;

process.on('exit', () => {
  try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ }
});

/**
 * Report macOS to the whole suite, and record what the runner really is.
 *
 * `ApiServer` refuses every `/voice/*` request off darwin, and CI runs on
 * Linux — so without this the voice endpoint tests fail wholesale on the one
 * machine whose result anybody looks at. Skipping them there was the
 * alternative, and it means CI never runs them at all.
 *
 * Safe to do suite-wide because `process.platform` is read in exactly one
 * place in this package: that guard. Anything added later that branches on
 * the platform has to restore `CODEY_REAL_PLATFORM` itself, the way
 * health.polish.test.ts does to cover the guard.
 */
process.env.CODEY_REAL_PLATFORM = process.platform;
Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
