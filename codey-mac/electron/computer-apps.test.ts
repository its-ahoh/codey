import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findInstalledApps } from './computer-apps'

let root: string
const app = (...parts: string[]) => { const path = join(root, ...parts); mkdirSync(path, { recursive: true }); return path }
// The fake bundle ID lives in a file, standing in for Info.plist.
const withId = (path: string, id: string) => { writeFileSync(join(path, 'id'), id); return path }
const bundleId = async (path: string) => (await import('node:fs/promises')).readFile(join(path, 'id'), 'utf8')

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'codey-apps-test-')) })
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

describe('installed applications', () => {
  it('finds application bundles in the roots, one vendor folder deep, plus named extras', async () => {
    withId(app('Applications', 'Writer.app'), 'org.example.Writer\n')
    withId(app('Applications', 'Vendor', 'Painter.app'), 'org.example.Painter')
    withId(app('Applications', 'Vendor', 'Deep', 'Hidden.app'), 'org.example.Hidden')
    withId(app('System', 'Clock.app'), 'org.example.Clock')
    withId(app('System', 'Tools', 'Skipped.app'), 'org.example.Skipped')
    const finder = withId(app('Core', 'Files.app'), 'org.example.Files')
    app('Applications', 'Notes.txt')

    const found = await findInstalledApps({
      roots: [join(root, 'Applications'), join(root, 'System'), join(root, 'Missing')],
      nested: [join(root, 'Applications')], extra: [finder], bundleId,
    })
    expect(found).toEqual([
      { bundleId: 'org.example.Clock', name: 'Clock' },
      { bundleId: 'org.example.Files', name: 'Files' },
      { bundleId: 'org.example.Painter', name: 'Painter' },
      { bundleId: 'org.example.Writer', name: 'Writer' },
    ])
  })

  it('skips bundles it cannot read, duplicates and Codey itself', async () => {
    withId(app('Applications', 'Writer.app'), 'org.example.Writer')
    withId(app('Applications', 'Writer 2.app'), 'org.example.Writer')
    withId(app('Applications', 'Codey.app'), 'com.codey.mac')
    app('Applications', 'Broken.app')
    withId(app('Applications', 'Odd.app'), 'not a bundle id')

    const found = await findInstalledApps({ roots: [join(root, 'Applications')], bundleId })
    // One grant per bundle ID; the first copy in folder order names it.
    expect(found).toEqual([{ bundleId: 'org.example.Writer', name: 'Writer 2' }])
  })
})
