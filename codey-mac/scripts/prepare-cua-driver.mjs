// Stage the exact native executable paired with @trycua/cua-driver. Never run an installer.
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile, rm, copyFile, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
const version = '0.34.0'
const archive = `cua-driver-rs-${version}-darwin-universal-binary.tar.gz`
const checksum = '940dc008e0f7c5d217d14c0f247d1ebab91b1bac965f4a649d19e8c789bdfd81'
const destination = fileURLToPath(new URL('../build/cua-driver/', import.meta.url))
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
await mkdir(destination, { recursive: true })
try {
  const record = JSON.parse(await readFile(join(destination, 'version.json'), 'utf8'))
  if (record.version === version && record.archiveSha256 === checksum &&
      record.binarySha256 === hash(await readFile(join(destination, 'cua-driver')))) process.exit(0)
} catch { /* download missing or altered payload */ }
const temporary = await mkdtemp(join(tmpdir(), 'codey-cua-build-'))
try {
  const response = await fetch(`https://github.com/trycua/cua/releases/download/cua-driver-rs-v${version}/${archive}`)
  if (!response.ok) throw new Error(`Cua Driver download failed: ${response.status}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  if (hash(bytes) !== checksum) throw new Error('Cua Driver checksum mismatch')
  const path = join(temporary, archive)
  await writeFile(path, bytes)
  const entries = execFileSync('tar', ['-tzf', path], { encoding: 'utf8' }).trim().split('\n')
  const binary = entries.find(entry => /(^|\/)cua-driver$/.test(entry))
  if (!binary || binary.startsWith('/') || binary.split('/').includes('..')) throw new Error('Unexpected Cua Driver archive layout')
  execFileSync('tar', ['-xzf', path, '-C', temporary, binary])
  await copyFile(join(temporary, binary), join(destination, 'cua-driver'))
  await chmod(join(destination, 'cua-driver'), 0o755)
  await writeFile(join(destination, 'version.json'), JSON.stringify({ version, archiveSha256: checksum,
    binarySha256: hash(await readFile(join(destination, 'cua-driver'))) }) + '\n')
  console.log(`Staged Cua Driver ${version}`)
} finally { await rm(temporary, { recursive: true, force: true }) }
