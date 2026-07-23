const fs = require('fs')
const path = require('path')

// node-pty's macOS prebuilt helper can lose its executable bit when restored
// from some npm caches or copied into an Electron bundle. PTY creation then
// fails with the opaque `posix_spawnp failed` error. Normalize every helper
// available to this workspace after install; chmod is intentionally a no-op on
// Windows and missing architecture folders are ignored.
if (process.platform === 'darwin') {
  const packageRoot = path.dirname(require.resolve('node-pty/package.json'))
  const candidates = [
    path.join(packageRoot, 'prebuilds', 'darwin-arm64', 'spawn-helper'),
    path.join(packageRoot, 'prebuilds', 'darwin-x64', 'spawn-helper'),
    path.join(packageRoot, 'build', 'Release', 'spawn-helper'),
  ]
  for (const helper of candidates) {
    if (fs.existsSync(helper)) fs.chmodSync(helper, 0o755)
  }
}
