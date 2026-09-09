import * as crypto from 'crypto'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

export interface BrowserExtensionCandidate {
  path: string
  name: string
  version: string
  description: string
  permissions: string[]
  hostPermissions: string[]
  warnings: string[]
}

export interface BrowserExtensionEntry extends BrowserExtensionCandidate {
  key: string
  enabled: boolean
  /** Runtime ids, one per session the extension is loaded into. Each partition
   *  is its own Chromium profile, so the same extension gets a different id in
   *  each of them and has to be removed by the right one. */
  runtimeIds: Map<ExtensionSession, string>
  error: string | null
}

/** What the renderer sees: the per-session runtime ids collapse to one flag. */
export interface BrowserExtensionSummary extends BrowserExtensionCandidate {
  key: string
  enabled: boolean
  loaded: boolean
  error: string | null
}

export interface ChromeBrowserExtensionCandidate extends BrowserExtensionCandidate {
  extensionId: string
  profile: string
  compatible: boolean
  incompatibilities: string[]
}

interface StoredBrowserExtension {
  path: string
  enabled: boolean
}

interface LoadedExtension {
  id: string
  name?: string
  version?: string
}

export interface ExtensionSession {
  extensions: {
    loadExtension: (extensionPath: string) => Promise<LoadedExtension>
    removeExtension: (extensionId: string) => void
  }
}

const MAX_MANIFEST_BYTES = 1024 * 1024
const CHROME_EXTENSION_ID = /^[a-p]{32}$/

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((item): item is string => typeof item === 'string').map(item => item.trim()).filter(Boolean))]
    : []
}

function extensionKey(extensionPath: string): string {
  return crypto.createHash('sha256').update(extensionPath).digest('hex').slice(0, 16)
}

function isInside(candidatePath: string, parentPath: string): boolean {
  const relative = path.relative(parentPath, candidatePath)
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}

function defaultChromeRoots(): string[] {
  if (process.platform === 'darwin') {
    return [path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome')]
  }
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    return [path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'User Data')]
  }
  return [path.join(os.homedir(), '.config', 'google-chrome')]
}

function versionParts(version: string): number[] {
  return version.split(/[^0-9]+/).map(part => Number(part) || 0)
}

function compareVersions(left: string, right: string): number {
  const a = versionParts(left)
  const b = versionParts(right)
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const difference = (a[index] || 0) - (b[index] || 0)
    if (difference !== 0) return difference
  }
  return left.localeCompare(right)
}

function profileDisplayName(profilePath: string, fallback: string): string {
  try {
    const preferences = JSON.parse(fs.readFileSync(path.join(profilePath, 'Preferences'), 'utf8'))
    const name = preferences?.profile?.name
    if (typeof name === 'string' && name.trim()) return name.trim()
  } catch {
    // A missing or changing Chrome Preferences file should not hide extensions.
  }
  return fallback
}

function manifestMessage(extensionPath: string, manifest: Record<string, unknown>, value: unknown): string {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  const match = trimmed.match(/^__MSG_([^_].*)__$/i)
  if (!match) return trimmed

  const locale = typeof manifest.default_locale === 'string' ? manifest.default_locale : 'en'
  for (const candidateLocale of [locale, 'en', 'en_US']) {
    try {
      const messages = JSON.parse(fs.readFileSync(
        path.join(extensionPath, '_locales', candidateLocale, 'messages.json'),
        'utf8',
      ))
      const message = messages?.[match[1]]?.message
      if (typeof message === 'string' && message.trim()) return message.trim()
    } catch {
      // Try the next fallback locale.
    }
  }
  return trimmed
}

function readManifest(extensionPath: string): Record<string, unknown> {
  const manifestPath = path.join(extensionPath, 'manifest.json')
  const stat = fs.statSync(manifestPath)
  if (!stat.isFile()) throw new Error('The selected folder does not contain manifest.json')
  if (stat.size > MAX_MANIFEST_BYTES) throw new Error('The extension manifest is too large')

  try {
    const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
    return parsed as Record<string, unknown>
  } catch {
    throw new Error('The extension manifest is not valid JSON')
  }
}

export function inspectBrowserExtension(extensionPath: string): BrowserExtensionCandidate {
  const absolutePath = fs.realpathSync(path.resolve(extensionPath))
  if (!fs.statSync(absolutePath).isDirectory()) throw new Error('Choose a folder containing an unpacked extension')

  const manifest = readManifest(absolutePath)

  const name = manifestMessage(absolutePath, manifest, manifest.name)
  const version = typeof manifest.version === 'string' ? manifest.version.trim() : ''
  const manifestVersion = Number(manifest.manifest_version)
  if (!name || !version) throw new Error('The extension manifest must include a name and version')
  if (manifestVersion !== 2 && manifestVersion !== 3) throw new Error('Only Manifest V2 and V3 extensions are supported')

  const permissions = stringArray(manifest.permissions)
  const contentScriptMatches = Array.isArray(manifest.content_scripts)
    ? (manifest.content_scripts as Array<Record<string, unknown>>).flatMap(script => stringArray(script?.matches))
    : []
  const hostPermissions = [...new Set([...stringArray(manifest.host_permissions), ...contentScriptMatches])]
  const warnings: string[] = []

  if (permissions.includes('nativeMessaging')) {
    warnings.push('Native messaging is not supported by Electron, so desktop-app integrations may not work.')
  }
  if ('action' in manifest || 'browser_action' in manifest || 'page_action' in manifest) {
    warnings.push('Extension toolbar actions are not displayed by Codey.')
  }
  if ('side_panel' in manifest || 'sidebar_action' in manifest) {
    warnings.push('Extension sidebars are not displayed by Codey.')
  }
  if (manifestVersion === 3 && manifest.background && typeof manifest.background === 'object'
    && 'service_worker' in (manifest.background as Record<string, unknown>)) {
    warnings.push('Manifest V3 background service workers are not officially supported by Electron.')
  }
  warnings.push('Electron supports only a subset of Chrome extension APIs; compatibility is not guaranteed.')

  return {
    path: absolutePath,
    name,
    version,
    description: manifestMessage(absolutePath, manifest, manifest.description),
    permissions,
    hostPermissions,
    warnings,
  }
}

export function discoverChromeBrowserExtensions(
  chromeRoots: string[] = defaultChromeRoots(),
): ChromeBrowserExtensionCandidate[] {
  const discovered: ChromeBrowserExtensionCandidate[] = []

  for (const configuredRoot of chromeRoots) {
    let chromeRoot: string
    try { chromeRoot = fs.realpathSync(configuredRoot) } catch { continue }

    let profileDirectories: fs.Dirent[]
    try { profileDirectories = fs.readdirSync(chromeRoot, { withFileTypes: true }) } catch { continue }
    for (const profileDirectory of profileDirectories) {
      if (!profileDirectory.isDirectory()) continue
      const profilePath = path.join(chromeRoot, profileDirectory.name)
      const extensionsPath = path.join(profilePath, 'Extensions')
      if (!fs.existsSync(extensionsPath)) continue
      const profile = profileDisplayName(profilePath, profileDirectory.name)

      let extensionDirectories: fs.Dirent[]
      try { extensionDirectories = fs.readdirSync(extensionsPath, { withFileTypes: true }) } catch { continue }
      for (const extensionDirectory of extensionDirectories) {
        if (!extensionDirectory.isDirectory() || !CHROME_EXTENSION_ID.test(extensionDirectory.name)) continue
        const extensionRoot = path.join(extensionsPath, extensionDirectory.name)
        let versions: fs.Dirent[]
        try { versions = fs.readdirSync(extensionRoot, { withFileTypes: true }) } catch { continue }
        const sortedVersions = versions
          .filter(version => version.isDirectory())
          .map(version => version.name)
          .sort(compareVersions)
        const latest = sortedVersions[sortedVersions.length - 1]
        if (!latest) continue

        try {
          const extensionPath = path.join(extensionRoot, latest)
          const candidate = inspectBrowserExtension(extensionPath)
          const manifest = readManifest(candidate.path)
          const incompatibilities: string[] = []
          if (candidate.permissions.includes('nativeMessaging')) {
            incompatibilities.push('Requires native messaging, which Electron does not support.')
          }
          if (Number(manifest.manifest_version) === 3
            && manifest.background && typeof manifest.background === 'object'
            && 'service_worker' in (manifest.background as Record<string, unknown>)) {
            incompatibilities.push('Requires a Manifest V3 background service worker, which Electron does not support.')
          }
          discovered.push({
            ...candidate,
            extensionId: extensionDirectory.name,
            profile,
            compatible: incompatibilities.length === 0,
            incompatibilities,
          })
        } catch {
          // Ignore incomplete Chrome updates and extensions Electron cannot inspect.
        }
      }
    }
  }

  return discovered.sort((left, right) =>
    left.name.localeCompare(right.name) || left.profile.localeCompare(right.profile))
}

/** Loads user-approved unpacked extensions into the persistent Codey browser session. */
export class BrowserExtensionManager {
  private entries = new Map<string, BrowserExtensionEntry>()
  private readonly managedRoot: string
  /** Every partition's session that has asked to be served, in attach order. */
  private readonly sessions: ExtensionSession[] = []

  constructor(
    private readonly stateFile: string,
    private readonly chromeRoots: string[] = defaultChromeRoots(),
  ) {
    const configuredStateDirectory = path.dirname(path.resolve(stateFile))
    let stateDirectory = configuredStateDirectory
    try { stateDirectory = fs.realpathSync(configuredStateDirectory) } catch { /* created on first import */ }
    this.managedRoot = path.join(stateDirectory, 'browser-extensions')
  }

  async initialize(): Promise<BrowserExtensionSummary[]> {
    let stored: StoredBrowserExtension[] = []
    try {
      const parsed = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'))
      if (Array.isArray(parsed)) {
        stored = parsed.filter((item): item is StoredBrowserExtension =>
          !!item && typeof item.path === 'string' && typeof item.enabled === 'boolean')
      }
    } catch {
      // First run, a removed folder, or a damaged settings file starts cleanly.
    }

    for (const item of stored) {
      try {
        const candidate = inspectBrowserExtension(item.path)
        const entry: BrowserExtensionEntry = {
          ...candidate,
          key: extensionKey(candidate.path),
          enabled: item.enabled,
          runtimeIds: new Map(),
          error: null,
        }
        this.entries.set(entry.key, entry)
        if (entry.enabled) await this.loadEverywhere(entry)
      } catch (error) {
        const absolutePath = path.resolve(item.path)
        const entry: BrowserExtensionEntry = {
          key: extensionKey(absolutePath),
          path: absolutePath,
          name: path.basename(absolutePath) || 'Unavailable extension',
          version: '',
          description: '',
          permissions: [],
          hostPermissions: [],
          warnings: [],
          enabled: item.enabled,
          runtimeIds: new Map(),
          error: error instanceof Error ? error.message : String(error),
        }
        this.entries.set(entry.key, entry)
      }
    }
    return this.list()
  }

  inspect(extensionPath: string): BrowserExtensionCandidate {
    return inspectBrowserExtension(extensionPath)
  }

  discoverChrome(): ChromeBrowserExtensionCandidate[] {
    return discoverChromeBrowserExtensions(this.chromeRoots)
  }

  /** Start serving one more session (one more profile's partition). Every
   *  enabled extension is loaded into it, and it is remembered so extensions
   *  enabled later reach it too. Attaching the same session twice is a no-op. */
  async attach(target: ExtensionSession): Promise<void> {
    if (this.sessions.includes(target)) return
    this.sessions.push(target)
    for (const entry of this.entries.values()) {
      if (entry.enabled) await this.loadInto(entry, target)
    }
  }

  list(): BrowserExtensionSummary[] {
    return [...this.entries.values()]
      .map(({ runtimeIds, ...entry }) => ({
        ...entry,
        loaded: runtimeIds.size > 0,
        permissions: [...entry.permissions],
        hostPermissions: [...entry.hostPermissions],
        warnings: [...entry.warnings],
      }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  async install(extensionPath: string): Promise<BrowserExtensionSummary[]> {
    const candidate = inspectBrowserExtension(extensionPath)
    const key = extensionKey(candidate.path)
    if (this.entries.has(key)) throw new Error('This extension is already added')
    const entry: BrowserExtensionEntry = {
      ...candidate,
      key,
      enabled: true,
      runtimeIds: new Map(),
      error: null,
    }
    this.entries.set(key, entry)
    await this.loadEverywhere(entry)
    this.persist()
    return this.list()
  }

  async importFromChrome(extensionPath: string): Promise<BrowserExtensionSummary[]> {
    const sourcePath = fs.realpathSync(path.resolve(extensionPath))
    const discovered = this.discoverChrome().find(candidate => candidate.path === sourcePath)
    if (!discovered) throw new Error('The selected extension is not installed in a recognized Chrome profile')
    if (!discovered.compatible) throw new Error(discovered.incompatibilities.join(' '))

    fs.mkdirSync(this.managedRoot, { recursive: true })
    const targetPath = path.join(this.managedRoot, discovered.extensionId)
    const temporaryPath = `${targetPath}.import-${process.pid}-${crypto.randomBytes(4).toString('hex')}`
    const backupPath = `${targetPath}.backup-${process.pid}`
    fs.rmSync(temporaryPath, { recursive: true, force: true })
    fs.rmSync(backupPath, { recursive: true, force: true })

    let movedExisting = false
    let installedTarget = false
    try {
      fs.cpSync(sourcePath, temporaryPath, { recursive: true, errorOnExist: true, force: false })
      inspectBrowserExtension(temporaryPath)
      if (fs.existsSync(targetPath)) {
        fs.renameSync(targetPath, backupPath)
        movedExisting = true
      }
      fs.renameSync(temporaryPath, targetPath)
      installedTarget = true

      const candidate = inspectBrowserExtension(targetPath)
      const key = extensionKey(candidate.path)
      const existing = this.entries.get(key)
      if (existing) this.unload(existing)
      const entry: BrowserExtensionEntry = {
        ...candidate,
        key,
        enabled: true,
        runtimeIds: new Map(),
        error: null,
      }
      this.entries.set(key, entry)
      await this.loadEverywhere(entry)
      this.persist()
      fs.rmSync(backupPath, { recursive: true, force: true })
      return this.list()
    } catch (error) {
      fs.rmSync(temporaryPath, { recursive: true, force: true })
      if (installedTarget) fs.rmSync(targetPath, { recursive: true, force: true })
      if (movedExisting && fs.existsSync(backupPath)) {
        fs.renameSync(backupPath, targetPath)
      }
      throw error
    } finally {
      fs.rmSync(temporaryPath, { recursive: true, force: true })
      fs.rmSync(backupPath, { recursive: true, force: true })
    }
  }

  async setEnabled(key: string, enabled: boolean): Promise<BrowserExtensionSummary[]> {
    const entry = this.requireEntry(key)
    if (enabled === entry.enabled && (enabled ? entry.runtimeIds.size > 0 : true)) return this.list()
    if (!enabled) this.unload(entry)
    entry.enabled = enabled
    entry.error = null
    if (enabled) {
      try {
        const refreshed = inspectBrowserExtension(entry.path)
        Object.assign(entry, refreshed)
        await this.loadEverywhere(entry)
      } catch (error) {
        this.unload(entry)
        entry.error = error instanceof Error ? error.message : String(error)
      }
    }
    this.persist()
    return this.list()
  }

  async reload(key: string): Promise<BrowserExtensionSummary[]> {
    const entry = this.requireEntry(key)
    if (!entry.enabled) throw new Error('Enable the extension before reloading it')
    this.unload(entry)
    try {
      const refreshed = inspectBrowserExtension(entry.path)
      Object.assign(entry, refreshed)
      await this.loadEverywhere(entry)
    } catch (error) {
      this.unload(entry)
      entry.error = error instanceof Error ? error.message : String(error)
    }
    this.persist()
    return this.list()
  }

  remove(key: string): BrowserExtensionSummary[] {
    const entry = this.requireEntry(key)
    this.unload(entry)
    this.entries.delete(key)
    if (isInside(entry.path, this.managedRoot)) {
      fs.rmSync(entry.path, { recursive: true, force: true })
    }
    this.persist()
    return this.list()
  }

  private requireEntry(key: string): BrowserExtensionEntry {
    const entry = this.entries.get(key)
    if (!entry) throw new Error('Extension not found')
    return entry
  }

  /** Load one extension into every session already attached. Before the first
   *  partition opens this records nothing: the loading happens in `attach`. */
  private async loadEverywhere(entry: BrowserExtensionEntry): Promise<void> {
    for (const target of this.sessions) await this.loadInto(entry, target)
  }

  private async loadInto(entry: BrowserExtensionEntry, target: ExtensionSession): Promise<void> {
    try {
      const loaded = await target.extensions.loadExtension(entry.path)
      entry.runtimeIds.set(target, loaded.id)
      entry.error = null
    } catch (error) {
      entry.error = error instanceof Error ? error.message : String(error)
    }
  }

  private unload(entry: BrowserExtensionEntry): void {
    for (const [target, runtimeId] of entry.runtimeIds) {
      try { target.extensions.removeExtension(runtimeId) } catch { /* already unloaded */ }
    }
    entry.runtimeIds.clear()
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.stateFile), { recursive: true })
    const data: StoredBrowserExtension[] = [...this.entries.values()].map(entry => ({
      path: entry.path,
      enabled: entry.enabled,
    }))
    const temporary = `${this.stateFile}.${process.pid}.tmp`
    fs.writeFileSync(temporary, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 })
    fs.renameSync(temporary, this.stateFile)
  }
}
