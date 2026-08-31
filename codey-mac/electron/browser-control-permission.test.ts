import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BrowserControlPermissionGate, levelForCommand } from './browser-control-permission'

function tempFile(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `codey-browser-permission-${label}-`))
  directories.push(dir)
  return path.join(dir, 'permission.json')
}

const directories: string[] = []
afterEach(() => {
  for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('levelForCommand', () => {
  it('treats adding and changing as write, and destroying as full', () => {
    for (const command of ['click', 'fill', 'submit', 'upload', 'chrome click', 'chrome fill']) {
      expect(levelForCommand(command)).toBe('write')
    }
    for (const command of ['delete-profile', 'activate-profile']) {
      expect(levelForCommand(command)).toBe('full')
    }
  })
})

describe('BrowserControlPermissionGate', () => {
  it('starts view-only, waits for approval, persists it, and can revoke it', async () => {
    const file = tempFile('grant')
    const onChange = vi.fn()
    const gate = new BrowserControlPermissionGate(file, onChange)
    const waiting = gate.request({ command: 'fill', url: 'https://example.com/form', surface: 'browser', level: 'write' })
    expect(gate.getState()).toEqual({
      granted: { browser: 'none', chrome: 'none' },
      pending: { command: 'fill', url: 'https://example.com/form', surface: 'browser', level: 'write' },
    })

    gate.approve('write')
    await expect(waiting).resolves.toBe(true)
    expect(new BrowserControlPermissionGate(file, vi.fn()).getState().granted).toEqual({ browser: 'write', chrome: 'none' })

    gate.revoke('browser')
    expect(new BrowserControlPermissionGate(file, vi.fn()).getState().granted).toEqual({ browser: 'none', chrome: 'none' })
  })

  it('lets a write grant through repeat writes but still stops a full-access command', async () => {
    const gate = new BrowserControlPermissionGate(tempFile('tier'), vi.fn())
    const first = gate.request({ command: 'click', url: 'https://example.com', surface: 'browser', level: 'write' })
    gate.approve('write')
    await expect(first).resolves.toBe(true)

    // A second write needs no prompt at all.
    await expect(gate.request({ command: 'fill', url: 'https://example.com', surface: 'browser', level: 'write' })).resolves.toBe(true)
    expect(gate.getState().pending).toBeNull()

    // Deleting is past what they granted, so it asks again.
    const destructive = gate.request({ command: 'delete-profile', url: 'https://example.com', surface: 'browser', level: 'full' })
    expect(gate.getState().pending).toMatchObject({ command: 'delete-profile', level: 'full' })
    gate.approve('full')
    await expect(destructive).resolves.toBe(true)
    expect(gate.getState().granted.browser).toBe('full')
  })

  it('never lets one browser\'s grant apply to the other', async () => {
    const gate = new BrowserControlPermissionGate(tempFile('surface'), vi.fn())
    const inBrowser = gate.request({ command: 'click', url: 'https://example.com', surface: 'browser', level: 'write' })
    gate.approve('full')
    await expect(inBrowser).resolves.toBe(true)
    expect(gate.getState().granted).toEqual({ browser: 'full', chrome: 'none' })

    // The user's real Chrome was never approved, so it must still prompt.
    const inChrome = gate.request({ command: 'chrome click', url: 'https://github.com', surface: 'chrome', level: 'write' })
    expect(gate.getState().pending).toMatchObject({ surface: 'chrome' })
    gate.deny()
    await expect(inChrome).resolves.toBe(false)
    expect(gate.getState().granted.chrome).toBe('none')
  })

  it('raises a write approval to full when the command needs full', async () => {
    const gate = new BrowserControlPermissionGate(tempFile('raise'), vi.fn())
    const waiting = gate.request({ command: 'delete-profile', url: 'https://example.com', surface: 'browser', level: 'full' })
    gate.approve('write')
    // Approving less than the command needs would leave it blocked forever.
    await expect(waiting).resolves.toBe(true)
    expect(gate.getState().granted.browser).toBe('full')
  })

  it('reads a legacy blanket approval as the embedded browser only', () => {
    const file = tempFile('legacy')
    fs.writeFileSync(file, JSON.stringify({ agentControlApproved: true }))
    // Chrome had no gate when that flag was written, so it must not inherit one.
    expect(new BrowserControlPermissionGate(file, vi.fn()).getState().granted).toEqual({ browser: 'full', chrome: 'none' })
  })

  it('resolves a pending command as denied without granting future access', async () => {
    const gate = new BrowserControlPermissionGate(tempFile('deny'), vi.fn())
    const waiting = gate.request({ command: 'submit', url: 'https://example.com/post', surface: 'browser', level: 'write' })
    gate.deny()
    await expect(waiting).resolves.toBe(false)
    expect(gate.getState()).toEqual({ granted: { browser: 'none', chrome: 'none' }, pending: null })
  })
})
