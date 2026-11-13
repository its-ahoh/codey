import { readdir } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { allComputerApps, type ComputerApp } from './computer-control'

export interface InstalledAppsOptions {
  /** Folders whose `.app` bundles count as installed. */
  roots: string[]
  /** Roots where one level of sub-folders is searched too (vendor folders in /Applications). */
  nested?: string[]
  /** Single bundles outside the roots, such as Finder. */
  extra?: string[]
  /** Read a bundle's identifier; a bundle that cannot be read is skipped. */
  bundleId(appPath: string): Promise<string>
  concurrency?: number
}

async function bundles(dir: string, deeper: boolean): Promise<string[]> {
  let entries
  try { entries = await readdir(dir, { withFileTypes: true }) } catch { return [] }
  const found: string[] = []
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith('.')) continue
    const path = join(dir, entry.name)
    if (entry.name.endsWith('.app')) found.push(path)
    else if (deeper && entry.isDirectory()) found.push(...await bundles(path, false))
  }
  return found
}

/**
 * Every application installed on this Mac, as the exact bundle IDs the bounded
 * driver needs. The driver has no wildcard, so "all applications" is this list
 * at the moment a task starts.
 */
export async function findInstalledApps(options: InstalledAppsOptions): Promise<ComputerApp[]> {
  const nested = new Set(options.nested ?? [])
  const paths = [...new Set([
    ...(await Promise.all(options.roots.map(root => bundles(root, nested.has(root))))).flat(),
    ...(options.extra ?? []),
  ])]
  // Keep the order the folders were given in, so which of two copies of an
  // app names the grant does not depend on which read finished first.
  const found: ({ bundleId: string; name: string } | undefined)[] = new Array(paths.length)
  let next = 0
  const worker = async () => {
    while (next < paths.length) {
      const index = next++
      try { found[index] = { bundleId: (await options.bundleId(paths[index])).trim(), name: basename(paths[index], '.app') } }
      catch { /* not a readable application bundle */ }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, options.concurrency ?? 12) }, worker))
  return allComputerApps(found.filter(app => app !== undefined))
}
