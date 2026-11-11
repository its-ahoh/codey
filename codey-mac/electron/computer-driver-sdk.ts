import { app } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** dlopen cannot use Electron's virtual ASAR paths. Resolve the whole SDK from disk. */
export async function loadComputerDriverSdk(): Promise<typeof import('@trycua/cua-driver')> {
  if (!app.isPackaged) return import('@trycua/cua-driver')
  const entry = join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', '@trycua', 'cua-driver', 'dist', 'index.js')
  return import(/* @vite-ignore */ pathToFileURL(entry).href)
}
