import { describe, expect, it } from 'vitest'
import { errorBelongsTo, listButtonLabel, shouldShowChromeInstallInstructions } from './ChromeCompanionSettings'

describe('Chrome Companion settings', () => {
  it('shows installation steps only before the extension has been detected', () => {
    expect(shouldShowChromeInstallInstructions({ paired: false })).toBe(true)
    expect(shouldShowChromeInstallInstructions({ paired: true })).toBe(false)
  })
})

describe('where a Chrome settings failure is shown', () => {
  it('reports a failure under the section that caused it, and nowhere else', () => {
    const error = { at: 'sites', message: 'Chrome command timed out' }
    expect(errorBelongsTo(error, 'sites')).toBe(true)
    expect(errorBelongsTo(error, 'status')).toBe(false)
    expect(errorBelongsTo(error, 'import')).toBe(false)
  })

  it('shows nothing when there is no failure', () => {
    expect(errorBelongsTo(null, 'sites')).toBe(false)
  })
})

describe('the list-sites button', () => {
  it('says it is waiting rather than going silent', () => {
    expect(listButtonLabel('sites', false)).toBe('Asking Chrome…')
    expect(listButtonLabel('sites', true)).toBe('Asking Chrome…')
  })

  it('offers a first listing, then a way to ask again', () => {
    expect(listButtonLabel(null, false)).toBe('List Chrome’s signed-in sites')
    expect(listButtonLabel(null, true)).toBe('List again')
  })

  it('is not confused by another section being busy', () => {
    expect(listButtonLabel('import', false)).toBe('List Chrome’s signed-in sites')
  })
})
