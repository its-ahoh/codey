import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BrowserExtensionManager,
  discoverChromeBrowserExtensions,
  inspectBrowserExtension,
} from './browser-extensions'

const temporaryDirectories: string[] = []

function makeExtension(manifest: Record<string, unknown>): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-extension-'))
  temporaryDirectories.push(directory)
  fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify(manifest))
  return directory
}

function makeChromeExtension(
  chromeRoot: string,
  profile: string,
  extensionId: string,
  version: string,
  manifest: Record<string, unknown>,
): string {
  const directory = path.join(chromeRoot, profile, 'Extensions', extensionId, version)
  fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify(manifest))
  return directory
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

describe('inspectBrowserExtension', () => {
  it('previews permissions, page access, and Electron compatibility warnings', () => {
    const directory = makeExtension({
      manifest_version: 3,
      name: 'Page Helper',
      version: '1.2.3',
      description: 'Improves example pages',
      permissions: ['storage', 'nativeMessaging'],
      host_permissions: ['https://example.com/*'],
      content_scripts: [{ matches: ['https://docs.example.com/*'], js: ['content.js'] }],
      action: { default_title: 'Page Helper' },
    })

    const candidate = inspectBrowserExtension(directory)
    expect(candidate).toMatchObject({ name: 'Page Helper', version: '1.2.3' })
    expect(candidate.permissions).toEqual(['storage', 'nativeMessaging'])
    expect(candidate.hostPermissions).toEqual(['https://example.com/*', 'https://docs.example.com/*'])
    expect(candidate.warnings.join(' ')).toContain('Native messaging is not supported')
    expect(candidate.warnings.join(' ')).toContain('toolbar actions')
  })

  it('rejects folders that are not valid unpacked extensions', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-extension-'))
    temporaryDirectories.push(directory)
    expect(() => inspectBrowserExtension(directory)).toThrow('manifest.json')
  })
})

describe('BrowserExtensionManager', () => {
  it('loads, disables, and remembers an approved local extension', async () => {
    const directory = makeExtension({ manifest_version: 3, name: 'Local Notes', version: '1.0.0' })
    const stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-extension-state-'))
    temporaryDirectories.push(stateDirectory)
    const stateFile = path.join(stateDirectory, 'extensions.json')
    const loadExtension = vi.fn(async () => ({ id: 'runtime-id' }))
    const removeExtension = vi.fn()
    const session = { extensions: { loadExtension, removeExtension } }
    const manager = new BrowserExtensionManager(session, stateFile)

    await expect(manager.install(directory)).resolves.toEqual([
      expect.objectContaining({ name: 'Local Notes', enabled: true, runtimeId: 'runtime-id', error: null }),
    ])
    expect(loadExtension).toHaveBeenCalledWith(fs.realpathSync(directory))

    const key = manager.list()[0].key
    await manager.setEnabled(key, false)
    expect(removeExtension).toHaveBeenCalledWith('runtime-id')
    expect(manager.list()[0]).toMatchObject({ enabled: false, runtimeId: null })

    const restoredLoad = vi.fn(async () => ({ id: 'restored-id' }))
    const restored = new BrowserExtensionManager({ extensions: { loadExtension: restoredLoad, removeExtension: vi.fn() } }, stateFile)
    await restored.initialize()
    expect(restoredLoad).not.toHaveBeenCalled()
    expect(restored.list()[0]).toMatchObject({ name: 'Local Notes', enabled: false })
  })

  it('keeps a visible error when Electron rejects an incompatible extension', async () => {
    const directory = makeExtension({ manifest_version: 3, name: 'Unsupported', version: '1.0.0' })
    const stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-extension-state-'))
    temporaryDirectories.push(stateDirectory)
    const manager = new BrowserExtensionManager({
      extensions: {
        loadExtension: vi.fn(async () => { throw new Error('Unsupported manifest key') }),
        removeExtension: vi.fn(),
      },
    }, path.join(stateDirectory, 'extensions.json'))

    const entries = await manager.install(directory)
    expect(entries[0]).toMatchObject({ enabled: true, runtimeId: null, error: 'Unsupported manifest key' })
  })

  it('discovers the newest installed Chrome version and imports a managed copy', async () => {
    const chromeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-chrome-'))
    const stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-extension-state-'))
    temporaryDirectories.push(chromeRoot, stateDirectory)
    const extensionId = 'abcdefghijklmnopabcdefghijklmnop'
    const profilePath = path.join(chromeRoot, 'Profile 2')
    fs.mkdirSync(profilePath, { recursive: true })
    fs.writeFileSync(path.join(profilePath, 'Preferences'), JSON.stringify({ profile: { name: 'Work' } }))
    makeChromeExtension(chromeRoot, 'Profile 2', extensionId, '1.2.0_0', {
      manifest_version: 2,
      name: 'Old Helper',
      version: '1.2.0',
    })
    const sourcePath = makeChromeExtension(chromeRoot, 'Profile 2', extensionId, '2.0.0_0', {
      manifest_version: 2,
      name: 'Page Helper',
      version: '2.0.0',
      permissions: ['storage'],
      content_scripts: [{ matches: ['https://example.com/*'], js: ['content.js'] }],
    })
    fs.writeFileSync(path.join(sourcePath, 'content.js'), 'document.body.dataset.helper = "on"')

    const discovered = discoverChromeBrowserExtensions([chromeRoot])
    expect(discovered).toEqual([
      expect.objectContaining({
        extensionId,
        profile: 'Work',
        name: 'Page Helper',
        version: '2.0.0',
        compatible: true,
      }),
    ])

    const loadExtension = vi.fn(async () => ({ id: extensionId }))
    const manager = new BrowserExtensionManager(
      { extensions: { loadExtension, removeExtension: vi.fn() } },
      path.join(stateDirectory, 'extensions.json'),
      [chromeRoot],
    )
    const entries = await manager.importFromChrome(discovered[0].path)
    const managedPath = fs.realpathSync(path.join(stateDirectory, 'browser-extensions', extensionId))
    expect(entries[0]).toMatchObject({ name: 'Page Helper', path: managedPath, enabled: true })
    expect(loadExtension).toHaveBeenCalledWith(fs.realpathSync(managedPath))
    expect(fs.readFileSync(path.join(managedPath, 'content.js'), 'utf8')).toContain('dataset.helper')

    manager.remove(entries[0].key)
    expect(fs.existsSync(managedPath)).toBe(false)
    expect(fs.existsSync(sourcePath)).toBe(true)
  })

  it('blocks importing Chrome extensions that require unsupported native messaging', async () => {
    const chromeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-chrome-'))
    const stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-extension-state-'))
    temporaryDirectories.push(chromeRoot, stateDirectory)
    const sourcePath = makeChromeExtension(
      chromeRoot,
      'Default',
      'pppppppppppppppppppppppppppppppp',
      '1.0.0_0',
      { manifest_version: 2, name: 'Desktop Bridge', version: '1.0.0', permissions: ['nativeMessaging'] },
    )
    const manager = new BrowserExtensionManager(
      { extensions: { loadExtension: vi.fn(), removeExtension: vi.fn() } },
      path.join(stateDirectory, 'extensions.json'),
      [chromeRoot],
    )

    expect(manager.discoverChrome()[0]).toMatchObject({ compatible: false })
    await expect(manager.importFromChrome(fs.realpathSync(sourcePath))).rejects.toThrow('native messaging')
  })
})
