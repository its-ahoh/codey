import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const mock = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  directory: '',
  dialog: vi.fn(),
  trusted: { mainFrame: { url: 'file:///app/index.html' } },
  granted: false,
}))
vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => mock.directory, getAppPath: () => mock.directory },
  ipcMain: { handle: (name: string, handler: (...args: any[]) => any) => mock.handlers.set(name, handler) },
  dialog: { showMessageBox: mock.dialog, showOpenDialog: vi.fn() },
  systemPreferences: { isTrustedAccessibilityClient: () => mock.granted, getMediaAccessStatus: () => mock.granted ? 'granted' : 'denied' },
}))
import { createComputerControlHost } from './computer-control-host'

const platform = process.platform
let skill: { on: boolean; isActive(): boolean; setEnabled(enabled: boolean): Promise<void> }
/** Pretend the driver is bundled and both macOS permissions are granted. */
const grantSetup = () => {
  mock.granted = true
  Object.defineProperty(process, 'platform', { value: 'darwin' })
  mkdirSync(join(mock.directory, 'build', 'cua-driver'), { recursive: true })
  writeFileSync(join(mock.directory, 'build', 'cua-driver', 'cua-driver'), '')
}

beforeEach(() => {
  mock.handlers.clear(); mock.granted = false
  mock.directory = mkdtempSync(join(tmpdir(), 'codey-control-test-'))
  skill = { on: false, isActive() { return this.on }, async setEnabled(enabled) { this.on = enabled } }
})
afterEach(() => { Object.defineProperty(process, 'platform', { value: platform }) })

describe('computer control IPC', () => {
  it('does not accept grants from websites or subframes', async () => {
    const host = createComputerControlHost(vi.fn(), () => mock.trusted as any, skill)
    try {
      const configure = mock.handlers.get('computer:configure')!
      const rogue = { mainFrame: { url: 'file:///app/index.html' } }
      await expect(configure({ sender: rogue, senderFrame: rogue.mainFrame }, true, [])).resolves.toMatchObject({ ok: false, error: 'Untrusted computer control request' })
      await expect(configure({ sender: mock.trusted, senderFrame: { url: 'https://example.test' } }, true, [])).resolves.toMatchObject({ ok: false })
      expect(host.control.enabled).toBe(false)
    } finally { await host.shutdown(); rmSync(mock.directory, { recursive: true, force: true }) }
  })
  it('requires native permissions and never remembers a switch it could not turn on', async () => {
    const host = createComputerControlHost(vi.fn(), () => mock.trusted as any, skill)
    const event = { sender: mock.trusted, senderFrame: mock.trusted.mainFrame }
    const apps = [{ bundleId: 'org.example.Drawing', name: 'Drawing' }]
    try {
      const configure = mock.handlers.get('computer:configure')!
      await expect(configure(event, true, apps)).resolves.toMatchObject({ ok: false })
      expect(skill.on).toBe(false)
      await expect(configure(event, false, apps)).resolves.toMatchObject({ ok: true })
      await host.shutdown()
      const restored = createComputerControlHost(vi.fn(), () => mock.trusted as any, skill)
      expect(restored.state()).toMatchObject({ enabled: false, apps })
      await restored.shutdown()
    } finally { await host.shutdown(); rmSync(mock.directory, { recursive: true, force: true }) }
  })
  it('remembers the switch across restarts once setup is complete', async () => {
    grantSetup()
    const event = { sender: mock.trusted, senderFrame: mock.trusted.mainFrame }
    const apps = [{ bundleId: 'org.example.Drawing', name: 'Drawing' }]
    const host = createComputerControlHost(vi.fn(), () => mock.trusted as any, skill)
    try {
      await expect(mock.handlers.get('computer:configure')!(event, true, apps)).resolves.toMatchObject({ ok: true, data: { enabled: true } })
      expect(skill.on).toBe(true)
      await host.shutdown()
      // Quitting does not flip the remembered switch.
      expect(skill.on).toBe(true)

      const restored = createComputerControlHost(vi.fn(), () => mock.trusted as any, skill)
      await expect(mock.handlers.get('computer:status')!(event)).resolves.toMatchObject({ ok: true, data: { enabled: true, apps } })

      // Disabling the skill from the Skills tab switches computer control off.
      await skill.setEnabled(false)
      await expect(mock.handlers.get('computer:status')!(event)).resolves.toMatchObject({ ok: true, data: { enabled: false } })
      await restored.shutdown()
    } finally { await host.shutdown(); rmSync(mock.directory, { recursive: true, force: true }) }
  })
  it('keeps a remembered switch off while setup is incomplete and brings it back after', async () => {
    skill.on = true
    const event = { sender: mock.trusted, senderFrame: mock.trusted.mainFrame }
    const apps = [{ bundleId: 'org.example.Drawing', name: 'Drawing' }]
    const host = createComputerControlHost(vi.fn(), () => mock.trusted as any, skill)
    try {
      const status = mock.handlers.get('computer:status')!
      await expect(status(event)).resolves.toMatchObject({ ok: true, data: { enabled: false } })
      // Editing the app list while off must not forget that the user wanted it on.
      host.control.apps = apps
      grantSetup()
      await expect(status(event)).resolves.toMatchObject({ ok: true, data: { enabled: true } })
      expect(skill.on).toBe(true)
    } finally { await host.shutdown(); rmSync(mock.directory, { recursive: true, force: true }) }
  })
  it('allows every application until a list is picked, and remembers the list', async () => {
    grantSetup()
    const event = { sender: mock.trusted, senderFrame: mock.trusted.mainFrame }
    const host = createComputerControlHost(vi.fn(), () => mock.trusted as any, skill)
    try {
      expect(host.state()).toMatchObject({ scope: 'all', apps: [] })
      const configure = mock.handlers.get('computer:configure')!
      // Nothing to pick: it can be switched on straight away.
      await expect(configure(event, true, [])).resolves.toMatchObject({ ok: true, data: { enabled: true, scope: 'all' } })
      const apps = [{ bundleId: 'org.example.Drawing', name: 'Drawing' }]
      await expect(configure(event, true, apps)).resolves.toMatchObject({ ok: true, data: { enabled: true, scope: 'selected', apps } })
      await host.shutdown()

      // A picked list stays a list after a restart; it is never widened.
      const restored = createComputerControlHost(vi.fn(), () => mock.trusted as any, skill)
      await expect(mock.handlers.get('computer:status')!(event)).resolves.toMatchObject({ ok: true, data: { enabled: true, scope: 'selected', apps } })
      await restored.shutdown()
    } finally { await host.shutdown(); rmSync(mock.directory, { recursive: true, force: true }) }
  })
  it('does not stay on when the switch cannot be remembered', async () => {
    grantSetup()
    const event = { sender: mock.trusted, senderFrame: mock.trusted.mainFrame }
    const failing = { isActive: () => false, setEnabled: async () => { throw new Error('Cannot write the skill') } }
    const host = createComputerControlHost(vi.fn(), () => mock.trusted as any, failing)
    try {
      await expect(mock.handlers.get('computer:configure')!(event, true, [{ bundleId: 'org.example.Drawing', name: 'Drawing' }]))
        .resolves.toMatchObject({ ok: false, error: 'Cannot write the skill' })
      expect(host.control.enabled).toBe(false)
    } finally { await host.shutdown(); rmSync(mock.directory, { recursive: true, force: true }) }
  })
})
