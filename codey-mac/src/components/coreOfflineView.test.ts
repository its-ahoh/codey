import { describe, it, expect } from 'vitest'
import { coreBannerText, composerPlaceholder } from './coreOfflineView'

describe('coreBannerText', () => {
  it('returns null while booting and when ready', () => {
    expect(coreBannerText({ phase: 'booting' })).toBeNull()
    expect(coreBannerText({ phase: 'ready' })).toBeNull()
  })

  it('returns message with error detail when failed', () => {
    expect(coreBannerText({ phase: 'failed', error: 'ENOENT: gateway.json' }))
      .toBe("Codey's core failed to start: ENOENT: gateway.json")
  })

  it('returns generic message when failed without detail', () => {
    expect(coreBannerText({ phase: 'failed' })).toBe("Codey's core failed to start.")
    expect(coreBannerText({ phase: 'failed', error: '  ' })).toBe("Codey's core failed to start.")
  })
})

describe('composerPlaceholder', () => {
  it('core failure wins over everything', () => {
    expect(composerPlaceholder({ coreFailed: true, isGatewayRunning: false, isSending: false }))
      .toBe('Core offline — relaunch to continue')
    expect(composerPlaceholder({ coreFailed: true, isGatewayRunning: true, isSending: true }))
      .toBe('Core offline — relaunch to continue')
  })

  it('matches existing placeholders otherwise', () => {
    expect(composerPlaceholder({ coreFailed: false, isGatewayRunning: false, isSending: false }))
      .toBe('Start gateway to chat')
    expect(composerPlaceholder({ coreFailed: false, isGatewayRunning: true, isSending: true }))
      .toBe('Sending…')
    expect(composerPlaceholder({ coreFailed: false, isGatewayRunning: true, isSending: false }))
      .toBe('Message Codey… (↵ to send)')
  })
})
