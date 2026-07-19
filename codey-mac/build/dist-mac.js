#!/usr/bin/env node
'use strict'

const { execFileSync, spawnSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const RELEASE = path.join(ROOT, 'release')
const EXPECTED_TEAM_ID = 'N59NN58KB2'

function capture(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' })
  return {
    status: result.status,
    output: `${result.stdout || ''}${result.stderr || ''}`,
  }
}

function run(command, args, options = {}) {
  execFileSync(command, args, { cwd: ROOT, stdio: 'inherit', ...options })
}

function cleanRelease() {
  fs.rmSync(RELEASE, { recursive: true, force: true })
}

function validDeveloperIdIdentity() {
  const result = capture('security', ['find-identity', '-v', '-p', 'codesigning'])
  const identities = [...result.output.matchAll(/"(Developer ID Application: [^"]+)"/g)].map(match => match[1])
  const identity = identities.find(name => name.includes(`(${EXPECTED_TEAM_ID})`))
  if (!identity) {
    throw new Error(
      `No valid Developer ID Application certificate for team ${EXPECTED_TEAM_ID} was found.\n` +
      'Install or renew the certificate and its private key in the login keychain, then confirm that\n' +
      '`security find-identity -v -p codesigning` lists it as valid.',
    )
  }
  return identity
}

function preflight() {
  const majorNode = Number(process.versions.node.split('.')[0])
  if (!Number.isFinite(majorNode) || majorNode < 20) {
    throw new Error(`Node.js 20 or newer is required for dist:mac (current: ${process.versions.node})`)
  }

  const identity = validDeveloperIdIdentity()
  if (!process.env.APPLE_ID || !process.env.APPLE_APP_SPECIFIC_PASSWORD || !process.env.APPLE_TEAM_ID) {
    throw new Error('Set APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, and APPLE_TEAM_ID before running dist:mac')
  }
  if (process.env.APPLE_TEAM_ID !== EXPECTED_TEAM_ID) {
    throw new Error(`APPLE_TEAM_ID must be ${EXPECTED_TEAM_ID}`)
  }

  for (const file of ['entitlements.mac.plist', 'entitlements.mac.inherit.plist']) {
    run('plutil', ['-lint', path.join(__dirname, file)], { stdio: 'pipe' })
  }
  return identity
}

function entitlementText(appPath) {
  const result = capture('codesign', ['-d', '--entitlements', '-', appPath])
  if (result.status !== 0) throw new Error(`Unable to read entitlements from ${appPath}: ${result.output.trim()}`)
  return result.output
}

function verifySignedApp(appPath) {
  run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath])
  const details = capture('codesign', ['-dv', '--verbose=4', appPath]).output
  if (!details.includes(`TeamIdentifier=${EXPECTED_TEAM_ID}`)) {
    throw new Error(`Codey.app is not signed by team ${EXPECTED_TEAM_ID}`)
  }

  const mainEntitlements = entitlementText(appPath)
  if (mainEntitlements.includes('com.apple.security.inherit')) {
    throw new Error('Codey.app incorrectly contains com.apple.security.inherit')
  }
  if (mainEntitlements.includes('keychain-access-groups')) {
    const profile = path.join(appPath, 'Contents', 'embedded.provisionprofile')
    if (!fs.existsSync(profile)) {
      throw new Error('Codey.app has restricted keychain-access-groups but no embedded provisioning profile')
    }
  }

  const helper = path.join(appPath, 'Contents', 'Frameworks', 'Codey Helper.app')
  const helperEntitlements = entitlementText(helper)
  if (helperEntitlements.includes('keychain-access-groups')) {
    throw new Error('Codey Helper.app must not inherit the main app keychain access groups')
  }
}

function verifyAppLaunch(appPath) {
  const executable = path.join(appPath, 'Contents', 'MacOS', 'Codey')
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-dist-smoke-'))
  try {
    const result = spawnSync(executable, [
      `--user-data-dir=${userDataDir}`,
      '--codey-distribution-smoke',
    ], {
      encoding: 'utf8',
      timeout: 15000,
      env: process.env,
    })
    const output = `${result.stdout || ''}${result.stderr || ''}${result.error ? `${result.error.message}\n` : ''}`
    if (result.status !== 0 || !output.includes('CODEY_DIST_SMOKE_OK')) {
      throw new Error(
        `macOS could not launch ${appPath}${result.signal ? ` (${result.signal})` : ''}:\n${output.trim()}`,
      )
    }
  } finally {
    fs.rmSync(userDataDir, { recursive: true, force: true })
  }
}

function builtApps() {
  return ['mac-arm64', 'mac']
    .map(stage => path.join(RELEASE, stage, 'Codey.app'))
    .filter(appPath => fs.existsSync(appPath))
}

function runNpmScript(script, extraEnv) {
  const npmCli = process.env.npm_execpath
  if (npmCli && fs.existsSync(npmCli)) {
    run(process.execPath, [npmCli, 'run', script], { env: { ...process.env, ...extraEnv } })
    return
  }
  run('npm', ['run', script], { env: { ...process.env, ...extraEnv } })
}

cleanRelease()
try {
  const identity = preflight()
  console.log(`✓ signing preflight passed: ${identity}`)

  runNpmScript('build:mac:signed', {
    // electron-builder expects the common name without the certificate-class prefix.
    CSC_NAME: identity.replace(/^Developer ID Application:\s*/, ''),
    CSC_IDENTITY_AUTO_DISCOVERY: 'true',
  })

  const apps = builtApps()
  if (apps.length === 0) throw new Error('electron-builder did not produce Codey.app')
  for (const appPath of apps) {
    verifySignedApp(appPath)
    verifyAppLaunch(appPath)
  }
  console.log(`✓ verified signing and macOS launch for ${apps.length} app bundle(s) before notarization`)

  run(process.execPath, [path.join(__dirname, 'notarize-dist.js')])
  for (const appPath of apps) verifySignedApp(appPath)
  console.log('\n✓ dist:mac produced signed, notarized, stapled, and verified artifacts in codey-mac/release')
} catch (error) {
  cleanRelease()
  console.error(`\nERROR: dist:mac failed; no distributable artifacts were kept.\n${error instanceof Error ? error.message : error}`)
  process.exit(1)
}
