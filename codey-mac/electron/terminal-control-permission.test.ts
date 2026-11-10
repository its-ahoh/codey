import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TerminalControlPermissionGate } from './terminal-control-permission'

let dir: string
let file: string
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-term-perm-')); file = path.join(dir, 'perm.json') })
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

const req = (preview: string) => ({ chatId: 'c', sessionId: 's', command: 'run', preview })

describe('TerminalControlPermissionGate', () => {
  it('asks one request at a time; "once" lets only the shown one through', async () => {
    const onChange = vi.fn()
    const gate = new TerminalControlPermissionGate(file, onChange)
    const first = gate.request(req('npm test'))
    const second = gate.request(req('rm -rf build'))
    expect(gate.getState().pending?.preview).toBe('npm test')
    gate.approve('once')
    await expect(first).resolves.toBe(true)
    expect(gate.getState().pending?.preview).toBe('rm -rf build')
    gate.deny()
    await expect(second).resolves.toBe(false)
    expect(gate.getState()).toEqual({ always: false, pending: null })
    expect(fs.existsSync(file)).toBe(false)
  })

  it('"always" lets everything queued through and is remembered until revoked', async () => {
    const gate = new TerminalControlPermissionGate(file, () => {})
    const a = gate.request(req('a'))
    const b = gate.request(req('b'))
    gate.approve('always')
    await expect(Promise.all([a, b])).resolves.toEqual([true, true])
    const reloaded = new TerminalControlPermissionGate(file, () => {})
    await expect(reloaded.request(req('c'))).resolves.toBe(true)
    reloaded.revoke()
    expect(new TerminalControlPermissionGate(file, () => {}).getState().always).toBe(false)
  })

  it('shortens very long previews and denies everything on dispose', async () => {
    const gate = new TerminalControlPermissionGate(file, () => {})
    const pending = gate.request(req('x'.repeat(1000)))
    expect(gate.getState().pending!.preview.length).toBeLessThan(410)
    gate.dispose()
    await expect(pending).resolves.toBe(false)
  })
})
