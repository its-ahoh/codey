import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { describe, expect, it, vi } from 'vitest'
import { BrowserSitePermissionManager, browserSitePermissionsFor } from './browser-site-permissions'

describe('browserSitePermissionsFor', () => {
  it('maps Electron media requests to user-facing camera and microphone permissions', () => {
    expect(browserSitePermissionsFor('media', { mediaTypes: ['video', 'audio'] })).toEqual(['camera', 'microphone'])
    expect(browserSitePermissionsFor('media', { mediaType: 'audio' })).toEqual(['microphone'])
    expect(browserSitePermissionsFor('geolocation')).toEqual(['geolocation'])
    expect(browserSitePermissionsFor('clipboard-read')).toEqual([])
  })
})

describe('BrowserSitePermissionManager', () => {
  function setup(timeout = 1000) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-site-permissions-'))
    const file = path.join(dir, 'permissions.json')
    const onChange = vi.fn()
    const manager = new BrowserSitePermissionManager(file, onChange, timeout)
    return { dir, file, manager, onChange }
  }

  it('asks once, persists an allow decision, and reuses it after restart', async () => {
    const { dir, file, manager } = setup()
    try {
      const result = manager.request('media', 'https://meet.example.com', { mediaTypes: ['video'] })
      const pending = manager.getState().pending!
      expect(pending).toMatchObject({ hostname: 'meet.example.com', permissions: ['camera'] })
      manager.alwaysAllow(pending.id)
      await expect(result).resolves.toBe(true)
      expect(manager.check('media', 'https://meet.example.com', { mediaType: 'video' })).toBe(true)

      const restored = new BrowserSitePermissionManager(file, vi.fn())
      expect(restored.check('media', 'https://meet.example.com', { mediaType: 'video' })).toBe(true)
      expect(restored.getState().savedSiteCount).toBe(1)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('supports session-only grants and persistent blocking', async () => {
    const { dir, file, manager } = setup()
    try {
      const location = manager.request('geolocation', 'https://maps.example.com')
      manager.allowForSession(manager.getState().pending!.id)
      await expect(location).resolves.toBe(true)
      expect(manager.check('geolocation', 'https://maps.example.com')).toBe(true)
      expect(new BrowserSitePermissionManager(file, vi.fn()).check('geolocation', 'https://maps.example.com')).toBe(false)

      const notification = manager.request('notifications', 'https://maps.example.com')
      manager.block(manager.getState().pending!.id)
      await expect(notification).resolves.toBe(false)
      await expect(manager.request('notifications', 'https://maps.example.com')).resolves.toBe(false)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('denies unsupported or insecure requests without prompting', async () => {
    const { dir, manager, onChange } = setup()
    try {
      await expect(manager.request('clipboard-read', 'https://example.com')).resolves.toBe(false)
      await expect(manager.request('media', 'http://example.com', { mediaTypes: ['audio'] })).resolves.toBe(false)
      expect(onChange).not.toHaveBeenCalled()
      expect(manager.getState().pending).toBeNull()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('queues simultaneous requests and clears saved decisions', async () => {
    const { dir, manager } = setup()
    try {
      const first = manager.request('geolocation', 'https://one.example.com')
      const second = manager.request('notifications', 'https://two.example.com')
      const firstId = manager.getState().pending!.id
      manager.alwaysAllow(firstId)
      await expect(first).resolves.toBe(true)
      expect(manager.getState().pending?.hostname).toBe('two.example.com')
      manager.block(manager.getState().pending!.id)
      await expect(second).resolves.toBe(false)
      expect(manager.getState().savedSiteCount).toBe(2)

      manager.clear()
      expect(manager.getState()).toEqual({ pending: null, savedSiteCount: 0 })
      expect(manager.check('geolocation', 'https://one.example.com')).toBe(false)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('times out unanswered prompts without granting access', async () => {
    vi.useFakeTimers()
    const { dir, manager } = setup(100)
    try {
      const result = manager.request('geolocation', 'https://slow.example.com')
      await vi.advanceTimersByTimeAsync(100)
      await expect(result).resolves.toBe(false)
      expect(manager.getState().pending).toBeNull()
    } finally {
      manager.dispose()
      fs.rmSync(dir, { recursive: true, force: true })
      vi.useRealTimers()
    }
  })
})
