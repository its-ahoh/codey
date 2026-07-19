import type { App, Session, WebAuthnAccount } from 'electron'
import { spawnSync } from 'child_process'
import { existsSync } from 'fs'
import { dirname, join } from 'path'

export const CODEY_WEBAUTHN_KEYCHAIN_GROUP = 'N59NN58KB2.com.codey.mac.webauthn'

export interface BrowserPasskeyPickerRequest {
  relyingPartyId: string
  accounts: WebAuthnAccount[]
}

export type BrowserPasskeyPicker = (request: BrowserPasskeyPickerRequest) => Promise<string | null>

export interface BrowserWebAuthnSignature {
  valid: boolean
  teamIdentifier: string | null
  entitlements: string
}

export function browserWebAuthnSignatureEligible(signature: BrowserWebAuthnSignature): boolean {
  return signature.valid
    && signature.teamIdentifier === 'N59NN58KB2'
    && signature.entitlements.includes(CODEY_WEBAUTHN_KEYCHAIN_GROUP)
}

/**
 * Native Touch ID must never be configured for an ad-hoc build. Chromium may
 * accept the initial configuration but terminate later when Keychain rejects
 * the Team-ID access group during a credential request.
 */
export function canConfigureBrowserWebAuthn(executablePath = process.execPath): boolean {
  if (process.platform !== 'darwin') return false
  try {
    // keychain-access-groups is restricted on Developer ID builds. AMFI will
    // refuse to launch an app that carries it without an embedded profile.
    const provisioningProfile = join(dirname(dirname(executablePath)), 'embedded.provisionprofile')
    if (!existsSync(provisioningProfile)) return false
    const verification = spawnSync('/usr/bin/codesign', ['--verify', '--strict', executablePath], {
      encoding: 'utf8',
      timeout: 5000,
    })
    const metadata = spawnSync('/usr/bin/codesign', ['-dv', '--verbose=4', executablePath], {
      encoding: 'utf8',
      timeout: 5000,
    })
    const entitlements = spawnSync('/usr/bin/codesign', ['-d', '--entitlements', '-', executablePath], {
      encoding: 'utf8',
      timeout: 5000,
    })
    const details = `${metadata.stdout || ''}\n${metadata.stderr || ''}`
    return browserWebAuthnSignatureEligible({
      valid: verification.status === 0,
      teamIdentifier: details.match(/(?:^|\n)TeamIdentifier=([^\n]+)/)?.[1]?.trim() || null,
      entitlements: `${entitlements.stdout || ''}\n${entitlements.stderr || ''}`,
    })
  } catch {
    return false
  }
}

export function passkeyAccountLabel(account: WebAuthnAccount, index: number): string {
  const displayName = String(account.displayName || '').trim()
  const name = String(account.name || '').trim()
  if (displayName && name && displayName !== name) return `${displayName} (${name})`
  return displayName || name || `Passkey ${index + 1}`
}

/** Enable Electron's native macOS Touch ID / Secure Enclave authenticator. */
export function configureBrowserWebAuthn(
  electronApp: App,
  browserSession: Session,
  pickAccount: BrowserPasskeyPicker,
  onError: (error: unknown) => void = () => {},
): boolean {
  if (process.platform !== 'darwin') return false

  try {
    electronApp.configureWebAuthn({
      touchID: {
        keychainAccessGroup: CODEY_WEBAUTHN_KEYCHAIN_GROUP,
        promptReason: 'sign in to $1',
      },
    })
  } catch (error) {
    onError(error)
    return false
  }

  browserSession.on('select-webauthn-account', (_event, details, callback) => {
    void (async () => {
      let credentialId: string | null = null
      try {
        if (details.accounts.length === 1) {
          credentialId = details.accounts[0].credentialId
        } else if (details.accounts.length > 1) {
          const selected = await pickAccount({
            relyingPartyId: details.relyingPartyId,
            accounts: details.accounts.map(account => ({ ...account })),
          })
          if (selected && details.accounts.some(account => account.credentialId === selected)) {
            credentialId = selected
          }
        }
      } catch (error) {
        onError(error)
      } finally {
        callback(credentialId)
      }
    })()
  })

  return true
}
