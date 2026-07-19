import { describe, expect, it, vi } from 'vitest'
import {
  browserWebAuthnSignatureEligible,
  CODEY_WEBAUTHN_KEYCHAIN_GROUP,
  configureBrowserWebAuthn,
  passkeyAccountLabel,
} from './browser-webauthn'

describe('browser WebAuthn', () => {
  it('requires a valid Codey team signature and matching entitlement', () => {
    const valid = {
      valid: true,
      teamIdentifier: 'N59NN58KB2',
      entitlements: `[Array]\n[String] ${CODEY_WEBAUTHN_KEYCHAIN_GROUP}`,
    }
    expect(browserWebAuthnSignatureEligible(valid)).toBe(true)
    expect(browserWebAuthnSignatureEligible({ ...valid, valid: false })).toBe(false)
    expect(browserWebAuthnSignatureEligible({ ...valid, teamIdentifier: null })).toBe(false)
    expect(browserWebAuthnSignatureEligible({ ...valid, entitlements: '' })).toBe(false)
  })

  it('uses the signed Codey keychain access group', () => {
    expect(CODEY_WEBAUTHN_KEYCHAIN_GROUP).toBe('N59NN58KB2.com.codey.mac.webauthn')
  })

  it('formats discoverable account labels without exposing credential ids', () => {
    expect(passkeyAccountLabel({ credentialId: 'secret', displayName: 'Jack', name: 'jack@example.com' }, 0))
      .toBe('Jack (jack@example.com)')
    expect(passkeyAccountLabel({ credentialId: 'secret' }, 1)).toBe('Passkey 2')
  })

  it.runIf(process.platform === 'darwin')('configures Touch ID and resolves account selection exactly once', async () => {
    const configureWebAuthn = vi.fn()
    let listener: any
    const browserSession = {
      on: vi.fn((_event: string, next: any) => { listener = next }),
    }
    const picker = vi.fn(async () => 'credential-2')
    expect(configureBrowserWebAuthn(
      { configureWebAuthn } as any,
      browserSession as any,
      picker,
    )).toBe(true)
    expect(configureWebAuthn).toHaveBeenCalledWith({
      touchID: {
        keychainAccessGroup: CODEY_WEBAUTHN_KEYCHAIN_GROUP,
        promptReason: 'sign in to $1',
      },
    })

    const callback = vi.fn()
    listener({}, {
      relyingPartyId: 'example.com',
      accounts: [
        { credentialId: 'credential-1', name: 'one@example.com' },
        { credentialId: 'credential-2', name: 'two@example.com' },
      ],
      frame: null,
    }, callback)
    await vi.waitFor(() => expect(callback).toHaveBeenCalledWith('credential-2'))
    expect(callback).toHaveBeenCalledTimes(1)
    expect(picker).toHaveBeenCalledWith(expect.objectContaining({ relyingPartyId: 'example.com' }))
  })
})
