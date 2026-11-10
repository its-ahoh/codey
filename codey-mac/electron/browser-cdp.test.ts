import { describe, expect, it, vi } from 'vitest'
import {
  elementsFromAxTree,
  exceptionMessage,
  indexDomTree,
  isActionableAxNode,
  toCdpKeyEvents,
  toCdpMouseEvent,
  type CdpAxNode,
  type CdpDomNode,
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

describe('accessibility snapshot filtering', () => {
  const dom = indexDomTree({
    nodeId: 1, backendNodeId: 1, nodeName: '#document', children: [
      { nodeId: 2, backendNodeId: 2, nodeName: 'BUTTON' },
      { nodeId: 3, backendNodeId: 3, nodeName: 'INPUT', attributes: ['type', 'password'] },
      { nodeId: 4, backendNodeId: 4, nodeName: 'DIV', shadowRoots: [
        { nodeId: 5, backendNodeId: 5, nodeName: '#document-fragment', children: [
          { nodeId: 6, backendNodeId: 6, nodeName: 'DIV' },
        ] },
      ] },
      { nodeId: 7, backendNodeId: 7, nodeName: 'SELECT', children: [{ nodeId: 8, backendNodeId: 8, nodeName: 'OPTION' }] },
      { nodeId: 9, backendNodeId: 9, nodeName: 'INPUT', attributes: ['type', 'checkbox'] },
      { nodeId: 10, backendNodeId: 10, nodeName: 'IFRAME', contentDocument: {
        nodeId: 11, backendNodeId: 11, nodeName: '#document', children: [{ nodeId: 12, backendNodeId: 12, nodeName: 'TEXTAREA' }],
      } },
    ],
  } as CdpDomNode)

  it('indexes nodes inside shadow roots and frame documents', () => {
    expect(dom.get(6)?.nodeName).toBe('DIV')
    expect(dom.get(12)?.nodeName).toBe('TEXTAREA')
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

  it('builds elements with tag, type and state, hiding passwords and native options', () => {
    const elements = elementsFromAxTree([
      ax(2, 'button', 'Send', { properties: [prop('disabled', true)] }),
      ax(3, 'textbox', 'Secret', { value: { value: 'swordfish' } }),
      ax(6, 'generic', 'Composer', { value: { value: 'draft' }, properties: [prop('focusable', true), prop('editable', 'richtext')] }),
      ax(7, 'combobox', 'Size', { value: { value: 'M' } }),
      ax(8, 'option', 'M'),
      ax(9, 'checkbox', 'Agree', { properties: [prop('checked', 'true')] }),
    ], dom, 'FRAME-1')

    expect(elements).toEqual([
      { tag: 'button', role: 'button', label: 'Send', type: '', disabled: true, ref: { backendNodeId: 2, targetId: 'FRAME-1' } },
      { tag: 'input', role: 'textbox', label: 'Secret', type: 'password', disabled: false, ref: { backendNodeId: 3, targetId: 'FRAME-1' } },
      { tag: 'div', role: 'generic', label: 'Composer', type: '', value: 'draft', disabled: false, ref: { backendNodeId: 6, targetId: 'FRAME-1' } },
      { tag: 'select', role: 'combobox', label: 'Size', type: '', value: 'M', disabled: false, ref: { backendNodeId: 7, targetId: 'FRAME-1' } },
      { tag: 'input', role: 'checkbox', label: 'Agree', type: 'checkbox', checked: true, disabled: false, ref: { backendNodeId: 9, targetId: 'FRAME-1' } },
    ])
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
})

describe('BrowserController accessibility snapshot', () => {
  /** A fake debugger with one cross-site frame that auto-attaches as FRAME-1. */
  function setup() {
    let attached = false
    const listeners = new Set<(...args: any[]) => void>()
    const sendCommand = vi.fn(async (method: string, params: any = {}, sessionId?: string): Promise<any> => {
      if (method === 'Target.setAutoAttach' && !sessionId) {
        listeners.forEach(listener => listener({}, 'Target.attachedToTarget', {
          sessionId: 'S1', targetInfo: { type: 'iframe', targetId: 'FRAME-1' },
        }))
        return {}
      }
      if (method === 'DOM.getDocument') {
        return sessionId
          ? { root: { nodeId: 1, backendNodeId: 1, nodeName: '#document', children: [{ nodeId: 2, backendNodeId: 40, nodeName: 'INPUT' }] } }
          : { root: { nodeId: 1, backendNodeId: 1, nodeName: '#document', children: [{ nodeId: 2, backendNodeId: 7, nodeName: 'BUTTON' }] } }
      }
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: sessionId ? 'FRAME-1' : 'MAIN' } } }
      if (method === 'Accessibility.getFullAXTree') {
        return sessionId
          ? { nodes: [ax(40, 'textbox', 'Card number')] }
          : { nodes: [ax(7, 'button', 'Pay')] }
      }
      if (method === 'DOM.resolveNode') return { object: { objectId: `obj-${params.backendNodeId}` } }
      if (method === 'Runtime.callFunctionOn') return { result: { value: true } }
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
        on: vi.fn((_event: string, listener: (...args: any[]) => void) => { listeners.add(listener) }),
        removeListener: vi.fn((_event: string, listener: (...args: any[]) => void) => { listeners.delete(listener) }),
        sendCommand,
      },
    }
    const controller = new BrowserController(() => null, vi.fn(), undefined, undefined, undefined, { sleep: async () => undefined, random: () => 0.5 })
    ;(controller as any).view = { webContents: contents }
    return { controller, contents, sendCommand }
  }

  it('lists controls from the page and a cross-site frame and detaches afterwards', async () => {
    const { controller, contents } = setup()
    const snapshot = await controller.snapshotInteractive()
    expect(snapshot.elements).toEqual([
      { ref: 'e1', tag: 'button', role: 'button', label: 'Pay', type: '', disabled: false },
      { ref: 'e2', tag: 'input', role: 'textbox', label: 'Card number', type: 'text', disabled: false },
    ])
    expect(snapshot.viewport).toEqual({ width: 800, height: 600, deviceScaleFactor: 2 })
    expect(contents.debugger.detach).toHaveBeenCalled()
    expect(contents.debugger.isAttached()).toBe(false)
  })

  it('runs ref actions on the node in its own frame session', async () => {
    const { controller, sendCommand } = setup()
    await controller.snapshotInteractive()
    sendCommand.mockClear()
    await controller.fill('e2', '4242')
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

  it('surfaces page exceptions from a ref action as plain errors', async () => {
    const { controller, sendCommand } = setup()
    await controller.snapshotInteractive()
    const original = sendCommand.getMockImplementation()!
    sendCommand.mockImplementation(async (method: string, params?: any, sessionId?: string) => method === 'Runtime.callFunctionOn'
      ? { exceptionDetails: { exception: { description: 'Error: Element e1 is not a select field\n    at x' } } }
      : original(method, params, sessionId))
    await expect(controller.select('e1', 'M')).rejects.toThrow(/^Element e1 is not a select field$/)
  })

  it('clicks through CDP so the event can reach cross-site frames', async () => {
    const { controller, contents, sendCommand } = setup()
    await controller.clickAt(10, 20)
    const mouse = sendCommand.mock.calls.filter(call => call[0] === 'Input.dispatchMouseEvent').map(call => call[1].type)
    expect(mouse.slice(-2)).toEqual(['mousePressed', 'mouseReleased'])
    expect(contents.sendInputEvent).not.toHaveBeenCalled()
  })

  it('types plain keys through CDP and leaves shortcuts on the Electron path', async () => {
    const { controller, contents, sendCommand } = setup()
    await controller.press('x')
    expect(sendCommand.mock.calls.filter(call => call[0] === 'Input.dispatchKeyEvent').map(call => call[1].type)).toEqual(['keyDown', 'keyUp'])
    await controller.press('cmd+a')
    expect(contents.sendInputEvent).toHaveBeenCalledWith({ type: 'keyDown', keyCode: 'a', modifiers: ['meta'] })
  })

  it('falls back to the page-script snapshot when the debugger cannot attach', async () => {
    const { controller, contents } = setup()
    contents.debugger.attach.mockImplementation(() => { throw new Error('Another debugger is already attached') })
    contents.executeJavaScript.mockResolvedValueOnce({ url: 'https://example.com/pay', title: 'Checkout', elements: [], viewport: { width: 1, height: 1, deviceScaleFactor: 1 } })
    await expect(controller.snapshotInteractive()).resolves.toMatchObject({ elements: [] })
    expect(String(contents.executeJavaScript.mock.calls[0][0])).toContain('codeyQueryAll')
  })
})
