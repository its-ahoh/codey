import * as fs from 'fs'
import { join } from 'path'

/**
 * Chrome's "Load unpacked" picker cannot descend into a `.app` bundle, so the
 * copy of the extension that ships inside `Codey.app/Contents/Resources` is
 * unreachable for the user who has to select it. Stage a copy in a plain user
 * directory instead, and keep it in step with the bundled one by version.
 */
export function stageChromeExtension(source: string, stagingRoot: string): string {
  if (!fs.existsSync(join(source, 'manifest.json'))) {
    throw new Error('The Chrome companion extension is missing from this build')
  }
  const target = join(stagingRoot, 'chrome-extension')
  if (!fs.existsSync(target) || stagedVersion(target) !== stagedVersion(source)) {
    fs.rmSync(target, { force: true, recursive: true })
    fs.mkdirSync(stagingRoot, { recursive: true })
    fs.cpSync(source, target, { recursive: true })
  }
  return target
}

/** The manifest version of an extension directory, or null when unreadable. */
export function stagedVersion(dir: string): string | null {
  try {
    const manifest = JSON.parse(fs.readFileSync(join(dir, 'manifest.json'), 'utf8'))
    return typeof manifest.version === 'string' ? manifest.version : null
  } catch { return null }
}
