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
