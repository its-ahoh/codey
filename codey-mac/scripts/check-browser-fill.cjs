// Run with: npm run check:browser-fill -w codey-mac
// Uses only an isolated, hidden local page; no saved browser sessions.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { app, BrowserWindow } = require('electron')
require('ts-node').register({
  transpileOnly: true,
  compilerOptions: { module: 'commonjs', moduleResolution: 'node' },
})
const { BrowserController } = require('../electron/browser-controller.ts')
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-fill-check-'))
app.setPath('userData', directory)
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false } })
  try {
    const controller = new BrowserController(() => window, () => {})
    controller.view = { webContents: window.webContents }
    await window.loadURL('data:text/html,' + encodeURIComponent(`
      <input data-codey-ref="e1" value="old">
      <textarea data-codey-ref="e2">old</textarea>
      <div data-codey-ref="e3" contenteditable="true">old<div>second</div></div>
      <input data-codey-ref="e4" readonly value="keep">
      <input data-codey-ref="e5" maxlength="3">
    `))
    await window.webContents.executeJavaScript(`
      window.inputEvents = [];
      document.addEventListener('input', event => inputEvents.push({ ref: event.target.dataset.codeyRef, trusted: event.isTrusted }));
    `)
    let replacements = 0
    for (const ref of ['e1', 'e2', 'e3']) {
      const values = ref === 'e1'
        ? ['hello \u{1f30e}', 'hello \u{1f30e}', '', '']
        : ['hello\nworld \u{1f30e}', 'hello\nworld \u{1f30e}', 'trailing\n', 'a  b', '\n\n', '', '']
      for (const value of values) {
        await controller.fill(ref, value)
        assert.equal(window.isFocused(), false)
        assert.equal(window.isVisible(), false)
        replacements += 1
      }
    }
    await assert.rejects(controller.fill('e4', 'overwrite'))
    assert.equal(await window.webContents.executeJavaScript('document.querySelector("[data-codey-ref=e4]").value'), 'keep')
    await assert.rejects(controller.fill('e5', 'too long'), /could not be verified/)
    const events = await window.webContents.executeJavaScript('inputEvents')
    for (const ref of ['e1', 'e2', 'e3']) assert.ok(events.some(event => event.ref === ref && event.trusted))
    console.log(`Passed ${replacements} background replacements, trusted input events, read-only rejection, and mismatch detection.`)
  } finally {
    window.destroy()
  }
}).then(() => app.quit()).catch(error => {
  console.error(error)
  app.exit(1)
})
app.on('quit', () => fs.rmSync(directory, { recursive: true, force: true }))
