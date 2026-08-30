import { describe, expect, it } from 'vitest'
import { shouldShowChromeInstallInstructions } from './ChromeCompanionSettings'

describe('Chrome Companion settings', () => {
  it('shows installation steps only before the extension has been detected', () => {
    expect(shouldShowChromeInstallInstructions({ paired: false })).toBe(true)
    expect(shouldShowChromeInstallInstructions({ paired: true })).toBe(false)
  })
})
