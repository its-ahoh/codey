import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { describe, expect, it, vi } from 'vitest'
import { BrowserControlPermissionGate } from './browser-control-permission'

describe('BrowserControlPermissionGate', () => {
  it('starts view-only, waits for approval, persists it, and can revoke it', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-browser-permission-'))
    const file = path.join(dir, 'permission.json')
    const onChange = vi.fn()
    try {
      const gate = new BrowserControlPermissionGate(file, onChange)
      const waiting = gate.request({ command: 'fill', url: 'https://example.com/form' })
      expect(gate.getState()).toEqual({
        approved: false,
        pending: { command: 'fill', url: 'https://example.com/form' },
      })
      gate.approve()
      await expect(waiting).resolves.toBe(true)
      expect(new BrowserControlPermissionGate(file, vi.fn()).getState().approved).toBe(true)

      gate.revoke()
      expect(gate.getState().approved).toBe(false)
      expect(new BrowserControlPermissionGate(file, vi.fn()).getState().approved).toBe(false)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('resolves a pending command as denied without granting future access', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-browser-permission-deny-'))
    try {
      const gate = new BrowserControlPermissionGate(path.join(dir, 'permission.json'), vi.fn())
      const waiting = gate.request({ command: 'submit', url: 'https://example.com/post' })
      gate.deny()
      await expect(waiting).resolves.toBe(false)
      expect(gate.getState()).toEqual({ approved: false, pending: null })
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
