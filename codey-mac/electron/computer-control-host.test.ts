import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const mock = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  directory: '',
  dialog: vi.fn(),
  trusted: { mainFrame: { url: 'file:///app/index.html' } },
}))
vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => mock.directory, getAppPath: () => mock.directory },
  ipcMain: { handle: (name: string, handler: (...args: any[]) => any) => mock.handlers.set(name, handler) },
  dialog: { showMessageBox: mock.dialog, showOpenDialog: vi.fn() },
  systemPreferences: { isTrustedAccessibilityClient: () => false, getMediaAccessStatus: () => 'denied' },
}))
import { createComputerControlHost } from './computer-control-host'

beforeEach(() => { mock.handlers.clear(); mock.directory = mkdtempSync(join(tmpdir(), 'codey-control-test-')) })

describe('computer control IPC', () => {
  it('does not accept grants from websites or subframes', async () => {
    const host = createComputerControlHost(vi.fn(), () => mock.trusted as any)
    try {
      const configure = mock.handlers.get('computer:configure')!
      const rogue = { mainFrame: { url: 'file:///app/index.html' } }
      await expect(configure({ sender: rogue, senderFrame: rogue.mainFrame }, true, [])).resolves.toMatchObject({ ok: false, error: 'Untrusted computer control request' })
      await expect(configure({ sender: mock.trusted, senderFrame: { url: 'https://example.test' } }, true, [])).resolves.toMatchObject({ ok: false })
      expect(host.control.enabled).toBe(false)
    } finally { await host.shutdown(); rmSync(mock.directory, { recursive: true, force: true }) }
  })
  it('requires native permissions and restores selections without restoring enablement', async () => {
    const host = createComputerControlHost(vi.fn(), () => mock.trusted as any)
    const event = { sender: mock.trusted, senderFrame: mock.trusted.mainFrame }
    const apps = [{ bundleId: 'org.example.Drawing', name: 'Drawing' }]
    try {
      const configure = mock.handlers.get('computer:configure')!
      await expect(configure(event, true, apps)).resolves.toMatchObject({ ok: false })
      await expect(configure(event, false, apps)).resolves.toMatchObject({ ok: true })
      await host.shutdown()
      const restored = createComputerControlHost(vi.fn(), () => mock.trusted as any)
      expect(restored.state()).toMatchObject({ enabled: false, apps })
      await restored.shutdown()
    } finally { await host.shutdown(); rmSync(mock.directory, { recursive: true, force: true }) }
  })
})
