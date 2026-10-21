// Check native SDK loading from an actual packaged app, without starting desktop control.
import { execFileSync } from 'node:child_process'
import { resolve, join } from 'node:path'
const bundle = resolve(process.argv[2] ?? 'release-local/mac-arm64/Codey.app')
const resources = join(bundle, 'Contents', 'Resources')
const source = `
  import { pathToFileURL } from 'node:url';
  const resources = process.argv[1];
  const sdk = await import(pathToFileURL(resources + '/app.asar.unpacked/node_modules/@trycua/cua-driver/dist/index.js'));
  const host = new sdk.EmbeddedCuaDriverHost(resources + '/cua-driver/cua-driver', 'com.codey.mac');
  try {
    if (host.state() !== sdk.EmbeddedDriverHostState.Stopped) throw new Error('Unexpected driver state');
    if (typeof sdk.requestMacOsPermissions !== 'function') throw new Error('Missing permission API');
    console.log('Packaged Cua SDK loaded; no desktop session started.');
  } finally { host.uniffiDestroy(); }
`
execFileSync(join(bundle, 'Contents', 'MacOS', 'Codey'), ['--input-type=module', '-e', source, resources], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'inherit', timeout: 30000,
})
const version = execFileSync(join(resources, 'cua-driver', 'cua-driver'), ['--version'], { encoding: 'utf8', timeout: 10000 }).trim()
if (version !== 'cua-driver 0.34.0') throw new Error(`Unexpected driver: ${version}`)
console.log(version)

const help = execFileSync(join(bundle, 'Contents', 'MacOS', 'Codey'), [join(resources, 'computer-agent-cli.cjs'), 'help'], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 10000,
})
if (!help.includes('Codey computer tools')) throw new Error('Missing Codey computer bridge CLI')
console.log('Packaged Codey computer CLI loaded.')
