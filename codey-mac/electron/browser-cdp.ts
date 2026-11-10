import type { WebContents } from 'electron'

/**
 * Chromium DevTools Protocol access for the Codey Browser, through Electron's
 * in-process webContents.debugger. Nothing is exposed on a port, so other
 * programs on the machine cannot reach the user's signed-in sessions.
 *
 * The accessibility tree is Chromium's own list of controls: it already sees
 * through closed shadow roots, skips hidden nodes, and computes the names a
 * screen reader would announce. Cross-site iframes run in their own renderer
 * process, so each one is reached through its own auto-attached session.
 */

/** Where a snapshot ref lives: a backend node in the page or in one frame target. */
export interface CdpRef {
  backendNodeId: number
  /** Target ID of an out-of-process iframe, or null for the page itself. */
  targetId: string | null
}

export interface CdpAxValue {
  type?: string
  value?: unknown
}

export interface CdpAxNode {
  nodeId: string
  ignored?: boolean
  role?: CdpAxValue
  name?: CdpAxValue
  value?: CdpAxValue
  properties?: Array<{ name: string; value: CdpAxValue }>
  backendDOMNodeId?: number
}

export interface CdpDomNode {
  nodeId: number
  backendNodeId?: number
  nodeName?: string
  attributes?: string[]
  children?: CdpDomNode[]
  shadowRoots?: CdpDomNode[]
  contentDocument?: CdpDomNode
}

export interface CdpSnapshotElement {
  tag: string
  role: string
  label: string
  type: string
  value?: string
  checked?: boolean
  disabled: boolean
  ref: CdpRef
}

/** Roles a user acts on. Chromium-specific names cover native selects and toggles. */
const ACTION_ROLES = new Set([
  'button', 'link', 'textbox', 'searchbox', 'combobox', 'checkbox', 'radio', 'switch',
  'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'slider',
  'spinbutton', 'listbox', 'treeitem', 'ComboBoxSelect', 'ComboBoxMenuButton',
  'PopUpButton', 'ToggleButton', 'DisclosureTriangle',
])
/** Focusable containers that are not controls of their own. */
const CONTAINER_ROLES = new Set(['RootWebArea', 'WebArea', 'Iframe', 'IframePresentational'])

const FIELD_TAGS = new Set(['input', 'textarea', 'select'])

export const MAX_SNAPSHOT_ELEMENTS = 500

function axProperty(node: CdpAxNode, name: string): unknown {
  return node.properties?.find(property => property.name === name)?.value?.value
}

function attributeMap(node: CdpDomNode | undefined): Map<string, string> {
  const map = new Map<string, string>()
  const attributes = node?.attributes ?? []
  for (let index = 0; index + 1 < attributes.length; index += 2) map.set(attributes[index], attributes[index + 1])
  return map
}

/** Index every node of a pierced DOM.getDocument tree by backend node ID. */
export function indexDomTree(root: CdpDomNode): Map<number, CdpDomNode> {
  const index = new Map<number, CdpDomNode>()
  const stack: CdpDomNode[] = [root]
  while (stack.length > 0) {
    const node = stack.pop()!
    if (typeof node.backendNodeId === 'number') index.set(node.backendNodeId, node)
    if (node.contentDocument) stack.push(node.contentDocument)
    for (const child of node.shadowRoots ?? []) stack.push(child)
    for (const child of node.children ?? []) stack.push(child)
  }
  return index
}

/** True when an accessibility node is something the agent can act on. */
export function isActionableAxNode(node: CdpAxNode): boolean {
  if (node.ignored || typeof node.backendDOMNodeId !== 'number') return false
  const role = String(node.role?.value ?? '')
  if (ACTION_ROLES.has(role)) return true
  if (CONTAINER_ROLES.has(role)) return false
  const focusable = axProperty(node, 'focusable') === true
  // The root of a rich editor is focusable and editable; its inner nodes are not focusable.
  if (focusable && axProperty(node, 'editable')) return true
  const name = String(node.name?.value ?? '').trim()
  return focusable && name.length > 0
}

/** Turn one frame's accessibility nodes into snapshot elements. */
export function elementsFromAxTree(
  nodes: CdpAxNode[],
  dom: Map<number, CdpDomNode>,
  targetId: string | null,
): CdpSnapshotElement[] {
  const elements: CdpSnapshotElement[] = []
  for (const node of nodes) {
    if (!isActionableAxNode(node)) continue
    const backendNodeId = node.backendDOMNodeId as number
    const domNode = dom.get(backendNodeId)
    const attributes = attributeMap(domNode)
    const tag = String(domNode?.nodeName ?? '').toLowerCase()
    // A native select's options are chosen with `select`, not clicked one by one.
    if (tag === 'option') continue
    const type = tag === 'input' ? (attributes.get('type') || 'text').toLowerCase() : ''
    const editable = !!axProperty(node, 'editable')
    const rawValue = node.value?.value
    const value = type === 'password' || (!FIELD_TAGS.has(tag) && !editable) || rawValue === undefined
      ? undefined
      : String(rawValue).slice(0, 300)
    const checked = axProperty(node, 'checked')
    elements.push({
      tag,
      role: String(node.role?.value ?? ''),
      label: String(node.name?.value ?? '').replace(/\s+/g, ' ').trim().slice(0, 300),
      type,
      ...(value !== undefined ? { value } : {}),
      ...(checked !== undefined ? { checked: checked === 'true' || checked === true } : {}),
      disabled: axProperty(node, 'disabled') === true,
      ref: { backendNodeId, targetId },
    })
  }
  return elements
}

interface FrameTree {
  frame: { id: string }
  childFrames?: FrameTree[]
}

function frameIds(tree: FrameTree): string[] {
  const ids: string[] = []
  const stack = [tree]
  while (stack.length > 0) {
    const current = stack.pop()!
    ids.push(current.frame.id)
    for (const child of current.childFrames ?? []) stack.push(child)
  }
  return ids
}

interface FrameTarget {
  sessionId: string
  /** Session of the frame that embeds this one; undefined means the page itself. */
  parentSessionId?: string
}

interface AttachedToTarget {
  sessionId: string
  targetInfo: { type: string; targetId: string }
}

interface ExceptionDetails {
  text?: string
  exception?: { description?: string }
}

/** Pull the first line of a page exception, dropping the "Error: " prefix and stack. */
export function exceptionMessage(details: ExceptionDetails): string {
  const description = details.exception?.description || details.text || 'Page script failed'
  return description.split('\n')[0].replace(/^[A-Za-z]*Error: /, '')
}

/**
 * One attached debugger session over a page and, when asked, its cross-site
 * frames. Attach for the duration of one command; refs keep backend node IDs,
 * which stay valid across sessions for as long as the node exists.
 */
export class CdpPage {
  private readonly frames = new Map<string, FrameTarget>()

  private constructor(private readonly contents: WebContents) {}

  static async run<T>(contents: WebContents, withFrames: boolean, task: (page: CdpPage) => Promise<T>): Promise<T> {
    const attachedHere = !contents.debugger.isAttached()
    if (attachedHere) contents.debugger.attach('1.3')
    const page = new CdpPage(contents)
    const onMessage = (_event: unknown, method: string, params: AttachedToTarget, sessionId?: string) => {
      if (method !== 'Target.attachedToTarget' || params?.targetInfo?.type !== 'iframe') return
      page.frames.set(params.targetInfo.targetId, {
        sessionId: params.sessionId,
        ...(sessionId ? { parentSessionId: sessionId } : {}),
      })
    }
    try {
      contents.debugger.on('message', onMessage)
      if (withFrames) await page.attachFrames()
      return await task(page)
    } finally {
      contents.debugger.removeListener('message', onMessage)
      if (attachedHere && contents.debugger.isAttached()) {
        try { contents.debugger.detach() } catch { /* already gone */ }
      }
    }
  }

  async send<T = unknown>(method: string, params: Record<string, unknown> = {}, targetId: string | null = null): Promise<T> {
    const sessionId = targetId ? this.sessionFor(targetId) : undefined
    return await this.contents.debugger.sendCommand(method, params, sessionId) as T
  }

  /** Auto-attach to cross-site frames, then to frames nested inside them. */
  private async attachFrames(): Promise<void> {
    const autoAttach = { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }
    await this.contents.debugger.sendCommand('Target.setAutoAttach', autoAttach)
    // Chromium reports already-running frames before the command resolves;
    // walk each newly found session once so nested frames are reached too.
    const visited = new Set<string>()
    for (let round = 0; round < 8; round += 1) {
      const pending = Array.from(this.frames.values()).filter(frame => !visited.has(frame.sessionId))
      if (pending.length === 0) break
      for (const frame of pending) {
        visited.add(frame.sessionId)
        await this.contents.debugger.sendCommand('Target.setAutoAttach', autoAttach, frame.sessionId).catch(() => undefined)
      }
    }
  }

  private sessionFor(targetId: string): string {
    const frame = this.frames.get(targetId)
    if (!frame) throw new Error('That frame is no longer on the page; take a new snapshot')
    return frame.sessionId
  }

  private targetForSession(sessionId: string | undefined): string | null {
    if (!sessionId) return null
    for (const [targetId, frame] of this.frames) if (frame.sessionId === sessionId) return targetId
    return null
  }

  /** Actionable elements of the page, then of each cross-site frame. */
  async snapshot(limit = MAX_SNAPSHOT_ELEMENTS): Promise<CdpSnapshotElement[]> {
    const elements: CdpSnapshotElement[] = []
    for (const targetId of [null, ...this.frames.keys()]) {
      if (elements.length >= limit) break
      let frameElements: CdpSnapshotElement[]
      try {
        frameElements = await this.snapshotTarget(targetId)
      } catch (error) {
        // A frame can disappear mid-snapshot; the page itself must not.
        if (targetId === null) throw error
        continue
      }
      elements.push(...frameElements)
    }
    return elements.slice(0, limit)
  }

  private async snapshotTarget(targetId: string | null): Promise<CdpSnapshotElement[]> {
    const document = await this.send<{ root: CdpDomNode }>('DOM.getDocument', { depth: -1, pierce: true }, targetId)
    if (!document?.root) throw new Error('DOM.getDocument returned no document')
    const dom = indexDomTree(document.root)
    const tree = await this.send<{ frameTree: FrameTree }>('Page.getFrameTree', {}, targetId)
    if (!tree?.frameTree) throw new Error('Page.getFrameTree returned no frames')
    const elements: CdpSnapshotElement[] = []
    // Same-process frames are listed here and read in this session. A
    // cross-site frame belongs to another process and fails; its own session
    // reads it instead.
    for (const frameId of frameIds(tree.frameTree)) {
      let result: { nodes?: CdpAxNode[] }
      try {
        result = await this.send('Accessibility.getFullAXTree', { frameId }, targetId)
      } catch (error) {
        if (frameId === tree.frameTree.frame.id) throw error
        continue
      }
      if (!Array.isArray(result?.nodes)) throw new Error('Accessibility.getFullAXTree returned no nodes')
      elements.push(...elementsFromAxTree(result.nodes, dom, targetId))
    }
    return elements
  }

  /** Remote object for a ref, or a clear error when the node is gone. */
  async resolve(ref: CdpRef, label: string): Promise<string> {
    try {
      const resolved = await this.send<{ object?: { objectId?: string } }>('DOM.resolveNode', { backendNodeId: ref.backendNodeId }, ref.targetId)
      if (resolved?.object?.objectId) return resolved.object.objectId
    } catch { /* fall through */ }
    throw new Error(`Element ${label} is no longer available; take a new snapshot`)
  }

  /** Run `function() { body }` with `this` bound to the node and return its value. */
  async callOn<T>(objectId: string, functionDeclaration: string, targetId: string | null): Promise<T> {
    const result = await this.send<{ result?: { value?: unknown }; exceptionDetails?: ExceptionDetails }>('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    }, targetId)
    if (result?.exceptionDetails) throw new Error(exceptionMessage(result.exceptionDetails))
    return result?.result?.value as T
  }

  /**
   * Offset of a cross-site frame's viewport inside the top-level viewport:
   * the embedding iframe's content box, summed up through every parent frame.
   * Scrolls each embedding iframe into view on the way.
   */
  async frameOffset(targetId: string | null, rectFunction: string): Promise<{ x: number; y: number }> {
    let x = 0
    let y = 0
    let current = targetId
    for (let depth = 0; current && depth < 8; depth += 1) {
      const frame = this.frames.get(current)
      if (!frame) throw new Error('That frame is no longer on the page; take a new snapshot')
      const parentTarget = this.targetForSession(frame.parentSessionId)
      const owner = await this.send<{ backendNodeId?: number }>('DOM.getFrameOwner', { frameId: current }, parentTarget)
      if (typeof owner?.backendNodeId !== 'number') throw new Error('Could not locate the frame on the page')
      const objectId = await this.resolve({ backendNodeId: owner.backendNodeId, targetId: parentTarget }, 'frame')
      const box = await this.callOn<{ left: number; top: number }>(objectId, rectFunction, parentTarget)
      x += box.left
      y += box.top
      current = parentTarget
    }
    return { x, y }
  }
}

/** The subset of Electron input events the browser controller sends. */
export type PointerInput =
  | { type: 'mouseMove'; x: number; y: number; button?: 'left' }
  | { type: 'mouseDown' | 'mouseUp'; x: number; y: number; button: 'left'; clickCount: number }

/**
 * CDP pointer event for an Electron one. Electron's sendInputEvent hands
 * events straight to the top page's widget, so a click over a cross-site
 * iframe never reaches it; Input.dispatchMouseEvent goes through Chromium's
 * input router, which hit-tests into the frame.
 */
export function toCdpMouseEvent(event: PointerInput): Record<string, unknown> {
  if (event.type === 'mouseMove') {
    return { type: 'mouseMoved', x: event.x, y: event.y, button: event.button ?? 'none', buttons: event.button ? 1 : 0 }
  }
  return {
    type: event.type === 'mouseDown' ? 'mousePressed' : 'mouseReleased',
    x: event.x,
    y: event.y,
    button: event.button,
    buttons: event.type === 'mouseDown' ? 1 : 0,
    clickCount: event.clickCount,
  }
}

const NAMED_KEYS: Record<string, { key: string; code: string; keyCode: number; text?: string }> = {
  enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  return: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  esc: { key: 'Escape', code: 'Escape', keyCode: 27 },
  space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  up: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  down: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  left: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  right: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  home: { key: 'Home', code: 'Home', keyCode: 36 },
  end: { key: 'End', code: 'End', keyCode: 35 },
  pageup: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  pagedown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
}

/**
 * CDP key events for one key press with no modifiers, or null when the key is
 * not mapped. Keyboard input from sendInputEvent also stops at the top page,
 * so typing into a focused field inside a cross-site frame needs this path.
 * Shortcuts stay on the Electron path: on macOS, CDP does not run editing
 * commands such as Cmd+A without an explicit command list.
 */
export function toCdpKeyEvents(keyCode: string): Array<Record<string, unknown>> | null {
  const named = NAMED_KEYS[keyCode.toLowerCase()]
  let key: string, code: string, virtual: number, text: string | undefined
  if (named) {
    ({ key, code, keyCode: virtual, text } = named)
  } else if (keyCode.length === 1) {
    key = keyCode
    text = keyCode
    const upper = keyCode.toUpperCase()
    if (/^[A-Z]$/.test(upper)) { code = 'Key' + upper; virtual = upper.charCodeAt(0) }
    else if (/^[0-9]$/.test(keyCode)) { code = 'Digit' + keyCode; virtual = keyCode.charCodeAt(0) }
    else { code = ''; virtual = 0 }
  } else if (/^F([1-9]|1[0-2])$/i.test(keyCode)) {
    key = keyCode.toUpperCase()
    code = key
    virtual = 111 + Number(key.slice(1))
  } else {
    return null
  }
  return [
    { type: text !== undefined ? 'keyDown' : 'rawKeyDown', key, code, windowsVirtualKeyCode: virtual, ...(text !== undefined ? { text, unmodifiedText: text } : {}) },
    { type: 'keyUp', key, code, windowsVirtualKeyCode: virtual },
  ]
}
