import { describe, expect, it, vi } from 'vitest'
import {
  CdpPage,
  elementFromAx,
  exceptionMessage,
  findCdpNodeByRef,
  isActionableAxNode,
  isAriaHiddenAxNode,
  isInteractiveDomNode,
  toCdpKeyEvents,
  toCdpMouseEvent,
  type CdpAxNode,
  type CdpDomNode,
  type CdpRef,
} from './browser-cdp'
import { BrowserController } from './browser-controller'

const ax = (backendDOMNodeId: number, role: string, name = '', extra: Partial<CdpAxNode> = {}): CdpAxNode => ({
  nodeId: String(backendDOMNodeId),
  backendDOMNodeId,
  role: { value: role },
  name: { value: name },
  ...extra,
})
const prop = (name: string, value: unknown) => ({ name, value: { value } })
const dom = (nodeName: string, attributes: string[] = [], children: CdpDomNode[] = []): CdpDomNode => ({ nodeId: 0, nodeName, attributes, children })
const ariaHidden = (backendDOMNodeId: number): CdpAxNode =>
  ax(backendDOMNodeId, 'none', '', { ignored: true, ignoredReasons: [{ name: 'ariaHiddenSubtree' }] })
const REF: CdpRef = { backendNodeId: 1, targetId: 'FRAME-1', documentId: 'doc' }

describe('accessibility snapshot filtering', () => {
  it('finds a stamped ref inside nested frames and shadow roots of a pierced tree', () => {
    const tree: CdpDomNode = {
      nodeId: 1,
      children: [
        { nodeId: 2, attributes: ['data-codey-ref', 'e1'] },
        { nodeId: 3, contentDocument: { nodeId: 4, children: [
          { nodeId: 5, shadowRoots: [{ nodeId: 6, children: [{ nodeId: 7, attributes: ['data-codey-ref', 'e12'] }] }] },
        ] } },
      ],
    }
    expect(findCdpNodeByRef(tree, 'e12')).toBe(7)
    expect(findCdpNodeByRef(tree, 'e1')).toBe(2)
    expect(findCdpNodeByRef(tree, 'e2')).toBeNull()
  })

  it('keeps controls and rich editors, and drops containers, hidden and nameless nodes', () => {
    expect(isActionableAxNode(ax(2, 'button', 'Send'))).toBe(true)
    expect(isActionableAxNode(ax(6, 'generic', '', { properties: [prop('focusable', true), prop('editable', 'richtext')] }))).toBe(true)
    expect(isActionableAxNode(ax(2, 'button', 'Hidden', { ignored: true }))).toBe(false)
    expect(isActionableAxNode(ax(1, 'RootWebArea', 'Page', { properties: [prop('focusable', true)] }))).toBe(false)
    expect(isActionableAxNode(ax(4, 'generic', '', { properties: [prop('focusable', true)] }))).toBe(false)
    expect(isActionableAxNode(ax(4, 'generic', 'Card', { properties: [prop('focusable', true)] }))).toBe(true)
    expect(isActionableAxNode({ nodeId: 'x', role: { value: 'button' } })).toBe(false)
  })

  it('gives aria-hidden nodes a second look, but not nodes ignored for other reasons', () => {
    expect(isAriaHiddenAxNode(ariaHidden(3))).toBe(true)
    expect(isAriaHiddenAxNode(ax(3, 'none', '', { ignored: true, ignoredReasons: [{ name: 'ariaHiddenElement' }] }))).toBe(true)
    expect(isAriaHiddenAxNode(ax(3, 'none', '', { ignored: true, ignoredReasons: [{ name: 'uninteresting' }] }))).toBe(false)
    expect(isAriaHiddenAxNode(ax(3, 'button', 'Send'))).toBe(false)
  })

  it('recognises controls from tag and attributes', () => {
    expect(isInteractiveDomNode(dom('BUTTON'))).toBe(true)
    expect(isInteractiveDomNode(dom('A', ['href', '/x']))).toBe(true)
    expect(isInteractiveDomNode(dom('A'))).toBe(false)
    expect(isInteractiveDomNode(dom('INPUT', ['type', 'hidden']))).toBe(false)
    expect(isInteractiveDomNode(dom('INPUT'))).toBe(true)
    expect(isInteractiveDomNode(dom('DIV', ['role', 'button']))).toBe(true)
    expect(isInteractiveDomNode(dom('DIV', ['contenteditable', 'true']))).toBe(true)
    expect(isInteractiveDomNode(dom('SPAN'))).toBe(false)
    expect(isInteractiveDomNode(dom('#text'))).toBe(false)
  })

  it('builds elements with tag, type and state, hiding passwords and native options', () => {
    expect(elementFromAx(ax(2, 'button', 'Send', { properties: [prop('disabled', true)] }), dom('BUTTON'), REF))
      .toEqual({ tag: 'button', role: 'button', label: 'Send', type: '', disabled: true, ref: REF })
    expect(elementFromAx(ax(3, 'textbox', 'Secret', { value: { value: 'swordfish' } }), dom('INPUT', ['type', 'password']), REF))
      .toEqual({ tag: 'input', role: 'textbox', label: 'Secret', type: 'password', disabled: false, ref: REF })
    expect(elementFromAx(
      ax(6, 'generic', 'Composer', { value: { value: 'draft' }, properties: [prop('focusable', true), prop('editable', 'richtext')] }),
      dom('DIV'), REF,
    )).toEqual({ tag: 'div', role: 'generic', label: 'Composer', type: '', value: 'draft', disabled: false, ref: REF })
    expect(elementFromAx(ax(7, 'combobox', 'Size', { value: { value: 'M' } }), dom('SELECT'), REF)).toMatchObject({ tag: 'select', value: 'M' })
    expect(elementFromAx(ax(8, 'option', 'M'), dom('OPTION'), REF)).toBeNull()
    expect(elementFromAx(ax(9, 'checkbox', 'Agree', { properties: [prop('checked', 'true')] }), dom('INPUT', ['type', 'checkbox']), REF))
      .toMatchObject({ type: 'checkbox', checked: true })
    expect(elementFromAx(ax(10, 'paragraph', 'Words'), dom('P'), REF)).toBeNull()
  })

  it('lists aria-hidden controls with a label read from the markup, and skips aria-hidden text', () => {
    expect(elementFromAx(ariaHidden(4), dom('BUTTON', [], [dom('SPAN', [], [{ nodeId: 0, nodeName: '#text', nodeValue: ' Close\n' }])]), REF))
      .toEqual({ tag: 'button', role: '', label: 'Close', type: '', disabled: false, ref: REF })
    expect(elementFromAx(ariaHidden(4), dom('DIV', ['role', 'button', 'aria-label', 'Menu', 'aria-disabled', 'true']), REF))
      .toMatchObject({ role: 'button', label: 'Menu', disabled: true })
    expect(elementFromAx(ariaHidden(4), dom('SPAN'), REF)).toBeNull()
    expect(elementFromAx(ariaHidden(4), { nodeId: 0, nodeName: '#text', nodeValue: 'x' }, REF)).toBeNull()
  })

  it('reports only the first line of a page exception', () => {
    expect(exceptionMessage({ exception: { description: 'Error: Element e4 is disabled\n    at <anonymous>:3:9' } })).toBe('Element e4 is disabled')
    expect(exceptionMessage({ text: 'Uncaught' })).toBe('Uncaught')
  })
})

describe('CDP input mapping', () => {
  it('maps pointer events to CDP mouse events', () => {
    expect(toCdpMouseEvent({ type: 'mouseMove', x: 4, y: 5 })).toEqual({ type: 'mouseMoved', x: 4, y: 5, button: 'none', buttons: 0 })
    expect(toCdpMouseEvent({ type: 'mouseMove', x: 4, y: 5, button: 'left' })).toMatchObject({ button: 'left', buttons: 1 })
    expect(toCdpMouseEvent({ type: 'mouseDown', x: 1, y: 2, button: 'left', clickCount: 2 }))
      .toEqual({ type: 'mousePressed', x: 1, y: 2, button: 'left', buttons: 1, clickCount: 2 })
    expect(toCdpMouseEvent({ type: 'mouseUp', x: 1, y: 2, button: 'left', clickCount: 1 })).toMatchObject({ type: 'mouseReleased', buttons: 0 })
  })

  it('flips wheel deltas so CDP scrolls the same way as the Electron path', () => {
    expect(toCdpMouseEvent({ type: 'mouseWheel', x: 1, y: 2, deltaX: 10, deltaY: -300 }))
      .toEqual({ type: 'mouseWheel', x: 1, y: 2, deltaX: -10, deltaY: 300 })
  })

  it('maps printable, named and function keys, and declines unknown ones', () => {
    expect(toCdpKeyEvents('a')).toEqual([
      { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, text: 'a', unmodifiedText: 'a' },
      { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 },
    ])
    expect(toCdpKeyEvents('Enter')?.[0]).toMatchObject({ type: 'keyDown', key: 'Enter', windowsVirtualKeyCode: 13, text: '\r' })
    expect(toCdpKeyEvents('Space')?.[0]).toMatchObject({ key: ' ', code: 'Space', text: ' ' })
    expect(toCdpKeyEvents('Tab')?.[0]).toEqual({ type: 'rawKeyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 })
    expect(toCdpKeyEvents('F5')?.[0]).toMatchObject({ type: 'rawKeyDown', key: 'F5', windowsVirtualKeyCode: 116 })
    expect(toCdpKeyEvents('MediaPlayPause')).toBeNull()
  })

  it('maps shortcuts, naming the editing command macOS needs', () => {
    expect(toCdpKeyEvents('a', ['meta'], 'darwin')).toEqual([
      { type: 'rawKeyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 4, commands: ['selectAll'] },
      { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 4 },
    ])
    expect(toCdpKeyEvents('z', ['shift', 'meta'], 'darwin')?.[0]).toMatchObject({ modifiers: 12, commands: ['redo'] })
    // An unmapped Cmd shortcut stays on the Electron path rather than doing nothing.
    expect(toCdpKeyEvents('r', ['meta'], 'darwin')).toBeNull()
    expect(toCdpKeyEvents('a', ['control'], 'linux')?.[0]).toEqual({ type: 'rawKeyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 })
    expect(toCdpKeyEvents('Tab', ['shift'])?.[0]).toEqual({ type: 'rawKeyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, modifiers: 8 })
    expect(toCdpKeyEvents('a', ['shift'])?.[0]).toMatchObject({ type: 'keyDown', key: 'A', text: 'A', modifiers: 8 })
    // Shifted symbols depend on the keyboard layout.
    expect(toCdpKeyEvents('1', ['shift'])).toBeNull()
  })
})

/** A fake debugger for a page with one cross-site frame that auto-attaches as FRAME-1. */
function fakePage() {
  let attached = false
  let mainLoader = 'doc-main'
  const listeners = new Map<string, Set<(...args: any[]) => void>>()
  const emit = (event: string, ...args: any[]) => listeners.get(event)?.forEach(listener => listener({}, ...args))
  const sendCommand = vi.fn(async (method: string, params: any = {}, sessionId?: string): Promise<any> => {
    if (!attached) throw new Error('Debugger is not attached')
    if (method === 'Target.setAutoAttach' && !sessionId) {
      emit('message', 'Target.attachedToTarget', { sessionId: 'S1', targetInfo: { type: 'iframe', targetId: 'FRAME-1' } })
      return {}
    }
    if (method === 'Page.getFrameTree') {
      return { frameTree: { frame: sessionId ? { id: 'FRAME-1', loaderId: 'doc-frame' } : { id: 'MAIN', loaderId: mainLoader } } }
    }
    if (method === 'Accessibility.getFullAXTree') {
      return sessionId
        ? { nodes: [ax(40, 'textbox', 'Card number')] }
        : { nodes: [ax(7, 'button', 'Pay'), ariaHidden(8), ariaHidden(9)] }
    }
    if (method === 'DOM.describeNode') {
      const nodes: Record<number, CdpDomNode> = {
        7: dom('BUTTON'),
        8: dom('BUTTON', ['aria-label', 'Close']),
        9: { nodeId: 0, nodeName: '#text', nodeValue: 'decoration' },
        40: dom('INPUT'),
      }
      return { node: nodes[params.backendNodeId] }
    }
    if (method === 'DOM.resolveNode') return { object: { objectId: `obj-${params.backendNodeId}` } }
    if (method === 'Runtime.callFunctionOn') return { result: { value: true } }
    if (method === 'DOM.getContentQuads') return { quads: [[10, 20, 30, 20, 30, 40, 10, 40]] }
    if (method === 'DOM.getFrameOwner') return { backendNodeId: 99 }
    if (method === 'DOM.getBoxModel') return { model: { content: [100, 200, 400, 200, 400, 500, 100, 500] } }
    return {}
  })
  const contents = {
    isDestroyed: vi.fn(() => false),
    getURL: vi.fn(() => 'https://example.com/pay'),
    getTitle: vi.fn(() => 'Checkout'),
    executeJavaScript: vi.fn(async (_script: string): Promise<unknown> => ({ width: 800, height: 600, deviceScaleFactor: 2 })),
    sendInputEvent: vi.fn(),
    debugger: {
      isAttached: vi.fn(() => attached),
      attach: vi.fn(() => { attached = true }),
      detach: vi.fn(() => { attached = false }),
      on: vi.fn((event: string, listener: (...args: any[]) => void) => {
        if (!listeners.has(event)) listeners.set(event, new Set())
        listeners.get(event)!.add(listener)
      }),
      removeListener: vi.fn((event: string, listener: (...args: any[]) => void) => { listeners.get(event)?.delete(listener) }),
      sendCommand,
    },
  }
  return { contents, sendCommand, navigate: (loaderId: string) => { mainLoader = loaderId } }
}

function setup() {
  const page = fakePage()
  const controller = new BrowserController(() => null, vi.fn(), undefined, undefined, undefined, { sleep: async () => undefined, random: () => 0.5 })
  ;(controller as any).view = { webContents: page.contents }
  // The Browser panel is open: pointer and key input may use CDP.
  ;(controller as any).attachedTo = {}
  return { controller, ...page }
}

describe('CdpPage attachment', () => {
  it('keeps the debugger attached until the last overlapping command finishes', async () => {
    const { contents } = fakePage()
    let releaseFirst!: () => void
    const first = CdpPage.run(contents as any, false, () => new Promise<void>(resolve => { releaseFirst = resolve }))
    await CdpPage.run(contents as any, false, async page => { await page.send('Page.getFrameTree') })
    // The second command finished first; the first still owns a live attachment.
    expect(contents.debugger.detach).not.toHaveBeenCalled()
    expect(contents.debugger.attach).toHaveBeenCalledTimes(1)
    releaseFirst()
    await first
    expect(contents.debugger.detach).toHaveBeenCalledTimes(1)
  })

  it('shares frame sessions found by one command with an overlapping one', async () => {
    const { contents, sendCommand } = fakePage()
    await CdpPage.run(contents as any, true, async () => {
      await CdpPage.run(contents as any, true, async page => { await page.send('DOM.enable', {}, 'FRAME-1') })
    })
    expect(sendCommand.mock.calls.filter(call => call[0] === 'Target.setAutoAttach' && !call[2])).toHaveLength(1)
    expect(sendCommand.mock.calls.find(call => call[0] === 'DOM.enable')?.[2]).toBe('S1')
  })

  it('detaches when attaching listeners fails', async () => {
    const { contents } = fakePage()
    contents.debugger.on.mockImplementation(() => { throw new Error('no events') })
    await expect(CdpPage.run(contents as any, false, async () => undefined)).rejects.toThrow('no events')
    expect(contents.debugger.isAttached()).toBe(false)
  })
})

describe('BrowserController accessibility snapshot', () => {
  it('lists controls from the page and a cross-site frame and detaches afterwards', async () => {
    const { controller, contents, sendCommand } = setup()
    const snapshot = await controller.snapshotInteractive()
    expect(snapshot.elements).toEqual([
      { ref: 'e1', tag: 'button', role: 'button', label: 'Pay', type: '', disabled: false },
      { ref: 'e2', tag: 'button', role: '', label: 'Close', type: '', disabled: false },
      { ref: 'e3', tag: 'input', role: 'textbox', label: 'Card number', type: 'text', disabled: false },
    ])
    expect(snapshot.viewport).toEqual({ width: 800, height: 600, deviceScaleFactor: 2 })
    expect(contents.debugger.isAttached()).toBe(false)
    // Only the kept nodes are described; the whole document is never fetched.
    expect(sendCommand.mock.calls.some(call => call[0] === 'DOM.getDocument')).toBe(false)
  })

  it('runs ref actions on the node in its own frame session', async () => {
    const { controller, sendCommand } = setup()
    await controller.snapshotInteractive()
    sendCommand.mockClear()
    await controller.fill('e3', '4242')
    const resolve = sendCommand.mock.calls.find(call => call[0] === 'DOM.resolveNode')
    expect(resolve?.[1]).toEqual({ backendNodeId: 40 })
    expect(resolve?.[2]).toBe('S1')
    const call = sendCommand.mock.calls.find(entry => entry[0] === 'Runtime.callFunctionOn')
    expect(call?.[1]).toMatchObject({ objectId: 'obj-40', returnByValue: true, userGesture: true })
    expect(String(call?.[1].functionDeclaration)).toContain('const el = this')
    expect(call?.[2]).toBe('S1')
  })

  it('refuses refs the current accessibility snapshot does not know', async () => {
    const { controller, contents } = setup()
    await controller.snapshotInteractive()
    await expect(controller.fill('e9', 'x')).rejects.toThrow('Element e9 is no longer available')
    expect(contents.executeJavaScript).toHaveBeenCalledTimes(1)
  })

  it('refuses a ref once its page has navigated, even if the node ID still resolves', async () => {
    const { controller, sendCommand, navigate } = setup()
    await controller.snapshotInteractive()
    navigate('doc-after-navigation')
    sendCommand.mockClear()
    await expect(controller.click('e1')).rejects.toThrow('Element e1 is no longer available; take a new snapshot')
    expect(sendCommand.mock.calls.some(call => call[0] === 'DOM.resolveNode')).toBe(false)
    expect(sendCommand.mock.calls.some(call => call[0] === 'Input.dispatchMouseEvent')).toBe(false)
  })

  it('surfaces page exceptions from a ref action as plain errors', async () => {
    const { controller, sendCommand } = setup()
    await controller.snapshotInteractive()
    const original = sendCommand.getMockImplementation()!
    sendCommand.mockImplementation(async (method: string, params?: any, sessionId?: string) => method === 'Runtime.callFunctionOn'
      ? { exceptionDetails: { exception: { description: 'Error: Element e1 is not a select field\n    at x' } } }
      : original(method, params, sessionId))
    await expect(controller.select('e1', 'M')).rejects.toThrow(/^Element e1 is not a select field$/)
  })

  it('clicks at the centre of the node quad, adding the frame offset for cross-site frames', async () => {
    const { controller, sendCommand } = setup()
    await controller.snapshotInteractive()
    sendCommand.mockClear()
    await controller.click('e1')
    const press = (calls: any[][]) => calls.find(call => call[0] === 'Input.dispatchMouseEvent' && call[1].type === 'mousePressed')?.[1]
    expect(press(sendCommand.mock.calls)).toMatchObject({ x: 20, y: 30 })
    expect(sendCommand.mock.calls.some(call => call[0] === 'DOM.getBoxModel')).toBe(false)

    sendCommand.mockClear()
    await controller.click('e3')
    // Quad centre (20, 30) inside the frame, plus the iframe content box origin (100, 200).
    expect(press(sendCommand.mock.calls)).toMatchObject({ x: 120, y: 230 })
    expect(sendCommand.mock.calls.find(call => call[0] === 'DOM.getFrameOwner')?.[1]).toEqual({ frameId: 'FRAME-1' })
  })

  it('reports an element that never scrolls on screen instead of clicking off-screen', async () => {
    const { controller, sendCommand } = setup()
    await controller.snapshotInteractive()
    const original = sendCommand.getMockImplementation()!
    sendCommand.mockImplementation(async (method: string, params?: any, sessionId?: string) => method === 'DOM.getContentQuads'
      ? { quads: [[10, -500, 30, -500, 30, -480, 10, -480]] }
      : original(method, params, sessionId))
    await expect(controller.click('e1')).rejects.toThrow('Element e1 could not be scrolled into view')
    expect(sendCommand.mock.calls.some(call => call[0] === 'Input.dispatchMouseEvent')).toBe(false)
  })

  it('clicks through CDP so the event can reach cross-site frames', async () => {
    const { controller, contents, sendCommand } = setup()
    await controller.clickAt(10, 20)
    const mouse = sendCommand.mock.calls.filter(call => call[0] === 'Input.dispatchMouseEvent').map(call => call[1].type)
    expect(mouse.slice(-2)).toEqual(['mousePressed', 'mouseReleased'])
    expect(contents.sendInputEvent).not.toHaveBeenCalled()
  })

  it('uses the Electron input path when the page does not acknowledge pointer input', async () => {
    vi.useFakeTimers()
    try {
      const { controller, contents, sendCommand } = setup()
      const original = sendCommand.getMockImplementation()!
      // A page that is not on screen never answers CDP pointer events.
      sendCommand.mockImplementation((method: string, params?: any, sessionId?: string) => method === 'Input.dispatchMouseEvent'
        ? new Promise(() => undefined)
        : original(method, params, sessionId))
      const click = controller.clickAt(10, 20)
      await vi.advanceTimersByTimeAsync(2000)
      await expect(click).resolves.toMatchObject({ ok: true })
      const sent = contents.sendInputEvent.mock.calls.map(call => (call as any[])[0].type)
      expect(sent.filter(type => type === 'mouseDown')).toHaveLength(1)
      expect(sent.slice(-2)).toEqual(['mouseDown', 'mouseUp'])
      expect(contents.debugger.isAttached()).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('uses the Electron input path directly while the Browser panel is closed', async () => {
    const { controller, contents, sendCommand } = setup()
    ;(controller as any).attachedTo = null
    await controller.clickAt(10, 20)
    await controller.press('x')
    await controller.scrollAt(5, 6, 300)
    expect(sendCommand.mock.calls.some(call => String(call[0]).startsWith('Input.'))).toBe(false)
    expect(contents.sendInputEvent).toHaveBeenCalledWith({ type: 'mouseWheel', x: 5, y: 6, deltaX: 0, deltaY: 300, canScroll: true })
  })

  it('scrolls through CDP with the same direction as the Electron path', async () => {
    const { controller, contents, sendCommand } = setup()
    await controller.scrollAt(5, 6, 300, 20)
    expect(sendCommand.mock.calls.find(call => call[0] === 'Input.dispatchMouseEvent' && call[1].type === 'mouseWheel')?.[1])
      .toEqual({ type: 'mouseWheel', x: 5, y: 6, deltaX: -20, deltaY: -300 })
    expect(contents.sendInputEvent).not.toHaveBeenCalled()
  })

  it('types keys and shortcuts through CDP, leaving unmapped combinations on the Electron path', async () => {
    const { controller, contents, sendCommand } = setup()
    const keys = () => sendCommand.mock.calls.filter(call => call[0] === 'Input.dispatchKeyEvent').map(call => call[1])
    await controller.press('x')
    expect(keys().map(event => event.type)).toEqual(['keyDown', 'keyUp'])
    sendCommand.mockClear()
    await controller.press('shift+Tab')
    expect(keys()[0]).toMatchObject({ type: 'rawKeyDown', key: 'Tab', modifiers: 8 })
    expect(contents.sendInputEvent).not.toHaveBeenCalled()
    // A key with no CDP mapping stays on the Electron path on every platform.
    await controller.press('alt+MediaPlayPause')
    expect(contents.sendInputEvent).toHaveBeenCalledWith({ type: 'keyDown', keyCode: 'MediaPlayPause', modifiers: ['alt'] })
  })

  it('holds one debugger attachment for a whole ref wait', async () => {
    const { controller, contents, sendCommand } = setup()
    await controller.snapshotInteractive()
    contents.debugger.attach.mockClear()
    const original = sendCommand.getMockImplementation()!
    let polls = 0
    sendCommand.mockImplementation(async (method: string, params?: any, sessionId?: string) => {
      if (method !== 'Runtime.callFunctionOn') return original(method, params, sessionId)
      polls += 1
      return { result: { value: { visible: polls >= 3, enabled: true } } }
    })
    await expect(controller.waitFor({ kind: 'ref', value: 'e1', timeoutMs: 2000 })).resolves.toMatchObject({ ok: true })
    expect(polls).toBe(3)
    expect(contents.debugger.attach).toHaveBeenCalledTimes(1)
    expect(contents.debugger.isAttached()).toBe(false)
  })

  it('falls back to the page-script snapshot when the debugger cannot attach', async () => {
    const { controller, contents } = setup()
    contents.debugger.attach.mockImplementation(() => { throw new Error('Another debugger is already attached') })
    contents.executeJavaScript.mockResolvedValueOnce({ url: 'https://example.com/pay', title: 'Checkout', elements: [], viewport: { width: 1, height: 1, deviceScaleFactor: 1 } })
    await expect(controller.snapshotInteractive()).resolves.toMatchObject({ elements: [] })
    expect(String(contents.executeJavaScript.mock.calls[0][0])).toContain('codeyQueryAll')
  })
})
