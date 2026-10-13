// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Markdown } from './Markdown'
import { FilePathCwd } from './FilePathLink'
let container: HTMLDivElement
let root: Root
const open = vi.fn()
const external = vi.fn()
beforeEach(() => {
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  open.mockReset().mockResolvedValue({ ok: true })
  external.mockReset()
  ;(window as any).codey = { fileRef: { open }, openExternal: external }
  vi.spyOn(window, 'alert').mockImplementation(() => {})
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})
async function click(target: string, shiftKey = false) {
  await act(async () => root.render(React.createElement(FilePathCwd.Provider, { value: '/tmp/project' },
    React.createElement(Markdown, { children: `[Artifact](<${target}>)` }))))
  await act(async () => {
    container.querySelector('a')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, shiftKey }))
  })
}
it.each([
  ['/tmp/sample-installer.dmg', '/tmp/sample-installer.dmg'],
  ['/tmp/Quarterly Report.pdf', '/tmp/Quarterly Report.pdf'],
  ['./src/example.ts:12', './src/example.ts'],
])('opens local reference %s through the file bridge', async (target, path) => {
  await click(target)
  expect(open).toHaveBeenCalledWith(path, '/tmp/project', { reveal: false })
  expect(external).not.toHaveBeenCalled()
})
it('reveals local files on shift-click', async () => {
  await click('/tmp/sample.zip', true)
  expect(open).toHaveBeenCalledWith('/tmp/sample.zip', '/tmp/project', { reveal: true })
})
it('keeps web links on the external URL bridge', async () => {
  await click('https://example.org/guide')
  expect(external).toHaveBeenCalledWith('https://example.org/guide')
  expect(open).not.toHaveBeenCalled()
})
it('reports file opening errors', async () => {
  open.mockResolvedValue({ ok: false, error: 'Path is unavailable' })
  await click('/tmp/missing.pdf')
  expect(window.alert).toHaveBeenCalledWith(expect.stringContaining('Path is unavailable'))
})
it('reports rejected file bridge requests', async () => {
  open.mockRejectedValue(new Error('Bridge unavailable'))
  await click('/tmp/sample.pdf')
  expect(window.alert).toHaveBeenCalledWith(expect.stringContaining('Bridge unavailable'))
})
it.each(['javascript:alert(1)', 'file:///tmp/sample.pdf', '//example.org/share', '#section'])('does not send URL target %s to the file bridge', async target => {
  await click(target)
  expect(open).not.toHaveBeenCalled()
  expect(external).not.toHaveBeenCalled()
})
