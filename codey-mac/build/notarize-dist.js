#!/usr/bin/env node
//
// Decoupled notarization for the macOS distributable.
//
// Why this exists instead of electron-builder's built-in notarize / an
// afterSign hook: notarization takes minutes, and running it *inside*
// electron-builder's pipeline races with electron-builder's own signing —
// the hash Apple notarizes ends up different from the hash that ships, so
// `stapler` fails with "Record not found". This script runs AFTER the build
// is completely finished, when nothing else is touching the bundle, so the
// notarized hash and the on-disk hash are guaranteed identical.
//
// Flow per architecture that was actually built:
//   1. zip the signed .app and submit to Apple (notarytool, --wait)
//   2. staple the ticket onto the .app
//   3. repackage the distributable zip from the now-stapled .app
//   4. staple the .dmg
//   5. verify everything with spctl / stapler
//
// Requires APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID in env.
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const pkg = require('../package.json');
const { regenerateLatestYml } = require('./latest-yml.js');
const PRODUCT = pkg.build.productName; // "Codey"
const VERSION = pkg.version;
const RELEASE = path.join(__dirname, '..', 'release');
const EXPECTED_TEAM_ID = 'N59NN58KB2';

const { APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID } = process.env;
if (!APPLE_ID || !APPLE_APP_SPECIFIC_PASSWORD || !APPLE_TEAM_ID) {
  console.error(
    'ERROR: set APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD and APPLE_TEAM_ID before running notarize:mac.\n' +
      'e.g. APPLE_APP_SPECIFIC_PASSWORD=$(security find-generic-password -s codey-notarize -w)',
  );
  process.exit(1);
}
if (APPLE_TEAM_ID !== EXPECTED_TEAM_ID) {
  console.error(`ERROR: APPLE_TEAM_ID must be ${EXPECTED_TEAM_ID}.`);
  process.exit(1);
}

// staging dir -> distributable artifact suffixes (electron-builder defaults)
const ARCHES = [
  { stage: 'mac-arm64', dmg: `-arm64`, zip: `-arm64-mac` },
  { stage: 'mac', dmg: ``, zip: `-mac` }, // x64 (only if built)
];

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { stdio: 'inherit', ...opts });
}
function capture(cmd, args) {
  // spctl and codesign write successful assessments to stderr, so preserve both.
  const result = spawnSync(cmd, args, { encoding: 'utf8' });
  const output = `${result.stdout || ''}${result.stderr || ''}${result.error ? `${result.error.message}\n` : ''}`;
  if (result.status !== 0) {
    const error = new Error(`${cmd} ${args.join(' ')} failed${result.signal ? ` (${result.signal})` : ''}:\n${output.trim()}`);
    error.commandOutput = output;
    throw error;
  }
  return output;
}

function assessGatekeeper(args) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return capture('/usr/sbin/spctl', args);
    } catch (error) {
      lastError = error;
      // macOS can transiently return a non-zero spctl status with no rejection
      // reason immediately after stapling. Never retry an explicit rejection.
      if (error.commandOutput?.trim() || attempt === 3) throw error;
      console.log(`  • Gatekeeper returned no result; retrying (${attempt}/3)…`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
    }
  }
  throw lastError;
}

function developerIdIdentity() {
  const out = capture('security', ['find-identity', '-v', '-p', 'codesigning']);
  const identities = [...out.matchAll(/"(Developer ID Application: [^"]+)"/g)].map(match => match[1]);
  const identity = identities.find(name => name.includes(`(${EXPECTED_TEAM_ID})`));
  if (!identity) throw new Error(`no valid Developer ID Application identity for team ${EXPECTED_TEAM_ID} found in keychain`);
  return identity;
}

function submitToNotary(filePath) {
  run('xcrun', [
    'notarytool', 'submit', filePath,
    '--apple-id', APPLE_ID,
    '--team-id', APPLE_TEAM_ID,
    '--password', APPLE_APP_SPECIFIC_PASSWORD,
    '--wait',
  ]);
}

function notarizeAndStapleApp(appPath) {
  console.log('  • verifying signed app before submission');
  run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath]);
  const zip = path.join(os.tmpdir(), `notar-${path.basename(path.dirname(appPath))}-${VERSION}.zip`);
  fs.rmSync(zip, { force: true });
  console.log(`  • zipping ${appPath}`);
  run('ditto', ['-c', '-k', '--keepParent', appPath, zip]);

  console.log('  • submitting app to Apple notary service (this can take a few minutes)…');
  submitToNotary(zip);
  fs.rmSync(zip, { force: true });

  console.log('  • stapling ticket onto app');
  run('xcrun', ['stapler', 'staple', appPath]);
  run('xcrun', ['stapler', 'validate', appPath]);
  run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath]);

  // Hard gate: the app must now be accepted by Gatekeeper.
  const out = assessGatekeeper(['-a', '-vvv', '--type', 'execute', appPath]);
  console.log('  • spctl:', out.trim().replace(/\n/g, ' | '));
}

function repackageZip(appPath, zipSuffix) {
  const zipName = `${PRODUCT}-${VERSION}${zipSuffix}.zip`;
  const dest = path.join(RELEASE, zipName);
  const tempDest = path.join(RELEASE, `.${zipName}.${process.pid}.tmp`);
  console.log(`  • repackaging ${zipName} from stapled app`);
  fs.rmSync(dest, { force: true });
  fs.rmSync(tempDest, { force: true });
  try {
    run('ditto', ['-c', '-k', '--keepParent', appPath, tempDest]);
    fs.renameSync(tempDest, dest);
  } finally {
    fs.rmSync(tempDest, { force: true });
  }
  // Packaging must be read-only with respect to the signed source bundle.
  run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath]);
}

function stapleDmg(dmgSuffix) {
  const dmgName = `${PRODUCT}-${VERSION}${dmgSuffix}.dmg`;
  const dmg = path.join(RELEASE, dmgName);
  if (!fs.existsSync(dmg)) {
    console.log(`  • (no ${dmgName} to staple, skipping)`);
    return;
  }
  // A dmg needs its OWN notary ticket — notarizing the app's zip does not
  // create one. Apple's order is sign -> notarize -> staple: electron-builder
  // leaves the dmg container unsigned, so sign it first or `spctl` reports
  // "no usable signature".
  console.log(`  • signing ${dmgName}`);
  run('codesign', ['--force', '--sign', developerIdIdentity(), '--timestamp', dmg]);
  console.log(`  • submitting ${dmgName} to notary service…`);
  submitToNotary(dmg);
  console.log(`  • stapling ${dmgName}`);
  run('xcrun', ['stapler', 'staple', dmg]);
  run('xcrun', ['stapler', 'validate', dmg]);

  // Hard gate: the dmg must be accepted by Gatekeeper.
  const out = assessGatekeeper(['-a', '-vvv', '-t', 'open', '--context', 'context:primary-signature', dmg]);
  console.log(`  • spctl(dmg): ${out.trim().replace(/\n/g, ' | ')}`);
}

let did = 0;
for (const arch of ARCHES) {
  const appPath = path.join(RELEASE, arch.stage, `${PRODUCT}.app`);
  if (!fs.existsSync(appPath)) continue;
  console.log(`\n=== ${arch.stage} ===`);
  notarizeAndStapleApp(appPath);
  repackageZip(appPath, arch.zip);
  run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath]);
  stapleDmg(arch.dmg);
  run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath]);
  did++;
}

if (did === 0) {
  console.error(`ERROR: no built apps found under ${RELEASE}/mac* — run build:mac:signed first.`);
  process.exit(1);
}

// Repackaging/stapling above changed the artifact bytes, so the sha512/size
// electron-builder wrote into latest-mac.yml no longer match. Rewrite them
// from the final files or the updater fails with a checksum mismatch right
// after the download completes.
const rehashed = regenerateLatestYml(RELEASE, 'latest-mac.yml');
if (rehashed.length === 0) {
  console.error(`ERROR: no latest-mac.yml artifacts found under ${RELEASE} to re-hash — auto-update metadata would be stale.`);
  process.exit(1);
}
console.log(`  • refreshed latest-mac.yml hashes for: ${rehashed.join(', ')}`);
console.log(`\n✓ notarized + stapled ${did} arch(es).`);
