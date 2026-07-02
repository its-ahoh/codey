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
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const pkg = require('../package.json');
const PRODUCT = pkg.build.productName; // "Codey"
const VERSION = pkg.version;
const RELEASE = path.join(__dirname, '..', 'release');

const { APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID } = process.env;
if (!APPLE_ID || !APPLE_APP_SPECIFIC_PASSWORD || !APPLE_TEAM_ID) {
  console.error(
    'ERROR: set APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD and APPLE_TEAM_ID before running notarize:mac.\n' +
      'e.g. APPLE_APP_SPECIFIC_PASSWORD=$(security find-generic-password -s codey-notarize -w)',
  );
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
  // merge stderr -> stdout (spctl/codesign write assessment to stderr)
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function developerIdIdentity() {
  const out = capture('security', ['find-identity', '-v', '-p', 'codesigning']);
  const m = out.match(/"(Developer ID Application: [^"]+)"/);
  if (!m) throw new Error('no "Developer ID Application" identity found in keychain');
  return m[1];
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
  const zip = path.join(os.tmpdir(), `notar-${path.basename(path.dirname(appPath))}-${VERSION}.zip`);
  fs.rmSync(zip, { force: true });
  console.log(`  • zipping ${appPath}`);
  run('ditto', ['-c', '-k', '--keepParent', appPath, zip]);

  console.log('  • submitting app to Apple notary service (this can take a few minutes)…');
  submitToNotary(zip);
  fs.rmSync(zip, { force: true });

  console.log('  • stapling ticket onto app');
  run('xcrun', ['stapler', 'staple', appPath]);

  // Hard gate: the app must now be accepted by Gatekeeper.
  const out = capture('spctl', ['-a', '-vvv', '--type', 'execute', appPath]);
  console.log('  • spctl:', out.trim().replace(/\n/g, ' | '));
}

function repackageZip(appPath, zipSuffix) {
  const zipName = `${PRODUCT}-${VERSION}${zipSuffix}.zip`;
  const dest = path.join(RELEASE, zipName);
  console.log(`  • repackaging ${zipName} from stapled app`);
  fs.rmSync(dest, { force: true });
  run('ditto', ['-c', '-k', '--keepParent', appPath, dest]);
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
  const out = capture('spctl', ['-a', '-vvv', '-t', 'open', '--context', 'context:primary-signature', dmg]);
  console.log(`  • spctl(dmg): ${out.trim().replace(/\n/g, ' | ')}`);
}

let did = 0;
for (const arch of ARCHES) {
  const appPath = path.join(RELEASE, arch.stage, `${PRODUCT}.app`);
  if (!fs.existsSync(appPath)) continue;
  console.log(`\n=== ${arch.stage} ===`);
  notarizeAndStapleApp(appPath);
  repackageZip(appPath, arch.zip);
  stapleDmg(arch.dmg);
  did++;
}

if (did === 0) {
  console.error(`ERROR: no built apps found under ${RELEASE}/mac* — run build:mac:signed first.`);
  process.exit(1);
}
console.log(`\n✓ notarized + stapled ${did} arch(es).`);
