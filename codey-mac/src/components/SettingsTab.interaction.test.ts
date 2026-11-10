// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SettingsTab } from './SettingsTab'

// Inline "+ Add key" on the Model edit card: the user can create an API key
// without leaving the model form, the new key is selected, and whatever was
// already typed into the model form survives.

let host: HTMLDivElement
let root: Root
let keys: Array<{ name: string; apiKey: string; anthropicBaseUrl?: string; openaiBaseUrl?: string; purpose?: string }>
let saveKey: ReturnType<typeof vi.fn>
let saveModel: ReturnType<typeof vi.fn>

const ok = <T,>(data: T) => ({ ok: true, data })

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  keys = [{ name: 'existing-key', apiKey: 'sk-sample-0000', purpose: 'general' }]
  saveKey = vi.fn(async (entry: any) => { keys = [...keys, entry]; return ok(undefined) })
  saveModel = vi.fn(async () => ok(undefined))
  ;(window as any).codey = {
    models: { list: async () => ok([]), save: saveModel, rename: vi.fn(), delete: vi.fn() },
    fallback: { get: async () => ok({ enabled: true, order: [] }), set: vi.fn() },
    dispatcher: { get: async () => ok({}), set: vi.fn() },
    aide: { get: async () => ok({}), set: vi.fn() },
    apiKeys: { list: async () => ok(keys), save: saveKey, rename: vi.fn(), delete: vi.fn() },
  }
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  delete (window as any).codey
  vi.unstubAllGlobals()
})

const $ = <T extends Element = HTMLElement>(sel: string) => host.querySelector<T>(sel)
const button = (text: string) =>
  [...host.querySelectorAll('button')].find(b => b.textContent?.trim() === text) as HTMLButtonElement | undefined
const click = async (el: Element | null | undefined) => {
  expect(el).toBeTruthy()
  await act(async () => { (el as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true })) })
}
const type = async (sel: string, value: string) => {
  const el = $<HTMLInputElement>(sel)!
  expect(el).toBeTruthy()
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  await act(async () => { setter.call(el, value); el.dispatchEvent(new Event('input', { bubbles: true })) })
}
const choose = async (sel: string, value: string) => {
  const el = $<HTMLSelectElement>(sel)!
  await act(async () => { el.value = value; el.dispatchEvent(new Event('change', { bubbles: true })) })
}

const openNewModel = async () => {
  await act(async () => root.render(React.createElement(SettingsTab, { isGatewayRunning: true })))
  await click(button('+ Add'))
  await type('input[aria-label="Model ID"]', 'sample-model-1')
  await choose('select[aria-label="Model API type"]', 'openai')
}

describe('SettingsTab inline + Add key', () => {
  it('shows + Add key next to the model key field', async () => {
    await openNewModel()
    expect(button('+ Add key')).toBeTruthy()
  })

  it('saves the new key, selects it, and keeps the model draft', async () => {
    await openNewModel()
    await click(button('+ Add key'))
    await type('input[aria-label="Key name"]', 'sample-key')
    await type('input[aria-label="API key value"]', 'sk-sample-1234')
    await type('input[aria-label="OpenAI base URL"]', 'https://example.test/v1')
    await click(button('Save key'))

    expect(saveKey).toHaveBeenCalledWith(expect.objectContaining({
      name: 'sample-key', apiKey: 'sk-sample-1234', openaiBaseUrl: 'https://example.test/v1', purpose: 'general',
    }))
    expect($('input[aria-label="Key name"]')).toBeNull()
    expect($<HTMLSelectElement>('select[aria-label="Model API key"]')!.value).toBe('sample-key')
    expect($<HTMLInputElement>('input[aria-label="Model ID"]')!.value).toBe('sample-model-1')
    expect($<HTMLSelectElement>('select[aria-label="Model API type"]')!.value).toBe('openai')
    // The model itself is still only saved when the user clicks Save.
    expect(saveModel).not.toHaveBeenCalled()

    await click(button('Save'))
    expect(saveModel).toHaveBeenCalledWith({ model: 'sample-model-1', apiType: 'openai', apiKeyRef: 'sample-key' })
  })

  it('keeps the key form and model draft when saving the key fails', async () => {
    saveKey.mockImplementationOnce(async () => ({ ok: false, error: 'sample failure' }))
    await openNewModel()
    await click(button('+ Add key'))
    await type('input[aria-label="Key name"]', 'sample-key')
    await type('input[aria-label="API key value"]', 'sk-sample-1234')
    await click(button('Save key'))

    expect(host.textContent).toContain('sample failure')
    expect($<HTMLInputElement>('input[aria-label="Key name"]')!.value).toBe('sample-key')
    expect($<HTMLInputElement>('input[aria-label="Model ID"]')!.value).toBe('sample-model-1')
    expect($<HTMLSelectElement>('select[aria-label="Model API key"]')!.value).toBe('')
  })

  it('names missing required fields instead of saving', async () => {
    await openNewModel()
    await click(button('+ Add key'))
    await click(button('Save key'))
    expect(saveKey).not.toHaveBeenCalled()
    expect(host.textContent).toContain('Name and API Key are required.')
  })

  it('refuses a name that already exists so a saved key is not overwritten', async () => {
    await openNewModel()
    await click(button('+ Add key'))
    await type('input[aria-label="Key name"]', 'existing-key')
    await type('input[aria-label="API key value"]', 'sk-sample-9999')
    await click(button('Save key'))
    expect(saveKey).not.toHaveBeenCalled()
    expect(host.textContent).toContain('already exists')
  })

  it('Cancel closes only the key form', async () => {
    await openNewModel()
    await click(button('+ Add key'))
    await type('input[aria-label="Key name"]', 'sample-key')
    await click($('button[aria-label="Cancel new key"]'))
    expect($('input[aria-label="Key name"]')).toBeNull()
    expect($<HTMLInputElement>('input[aria-label="Model ID"]')!.value).toBe('sample-model-1')
    expect(saveKey).not.toHaveBeenCalled()
  })
})

describe('SettingsTab provider picker + inline key', () => {
  const sampleProvider = {
    id: 'sample-co', label: 'Sample Co', openaiBaseUrl: 'https://api.sample.test/v1',
    keyUrl: 'https://sample.test/keys', modelCount: 1, curated: true,
  }

  it('picks a company and a model, then pre-fills a new key for that company', async () => {
    ;(window as any).codey.providers = {
      list: async () => ok([sampleProvider]),
      catalogModels: async () => ok([{ id: 'sample-model-9', name: 'Sample Model 9' }]),
    }
    await act(async () => root.render(React.createElement(SettingsTab, { isGatewayRunning: true })))
    await click(button('+ Add'))
    await click($('button[aria-label="Model provider"]'))
    // Cards and rows also carry a logo, so match on the visible label.
    const byText = (t: string) => [...document.querySelectorAll('button')].find(b => b.textContent?.includes(t))
    await click(byText('Sample Co'))
    await click(byText('Sample Model 9'))

    expect($<HTMLInputElement>('input[aria-label="Model ID"]')!.value).toBe('sample-model-9')
    // A company with only an OpenAI endpoint makes the new model openai-typed.
    expect($<HTMLSelectElement>('select[aria-label="Model API type"]')!.value).toBe('openai')

    await click(button('+ Add key'))
    expect($<HTMLInputElement>('input[aria-label="Key name"]')!.value).toBe('sample-co')
    expect($<HTMLInputElement>('input[aria-label="OpenAI base URL"]')!.value).toBe('https://api.sample.test/v1')
  })
})
