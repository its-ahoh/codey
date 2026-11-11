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
  /**
   * Loader ID of the document the target showed at snapshot time. A
   * cross-site navigation starts a new renderer whose node IDs begin again,
   * so an old ID could name an unrelated node; the loader ID tells them apart.
   */
  documentId: string
}

export interface CdpAxValue {
  type?: string
  value?: unknown
}

export interface CdpAxNode {
  nodeId: string
  ignored?: boolean
  ignoredReasons?: Array<{ name: string }>
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
  nodeValue?: string
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
/** Upper bound on aria-hidden nodes described per frame; most are text and icons. */
const MAX_ARIA_HIDDEN_CANDIDATES = 200

function axProperty(node: CdpAxNode, name: string): unknown {
  return node.properties?.find(property => property.name === name)?.value?.value
}

function attributeMap(node: CdpDomNode | undefined): Map<string, string> {
  const map = new Map<string, string>()
  const attributes = node?.attributes ?? []
  for (let index = 0; index + 1 < attributes.length; index += 2) map.set(attributes[index], attributes[index + 1])
  return map
}

/** Find the node carrying data-codey-ref=ref in a pierced DOM.getDocument tree. */
export function findCdpNodeByRef(root: CdpDomNode, ref: string): number | null {
  const stack: CdpDomNode[] = [root]
  while (stack.length > 0) {
    const node = stack.pop()!
    const attributes = node.attributes ?? []
    for (let index = 0; index + 1 < attributes.length; index += 2) {
      if (attributes[index] === 'data-codey-ref' && attributes[index + 1] === ref) return node.nodeId
    }
    if (node.contentDocument) stack.push(node.contentDocument)
    for (const child of node.shadowRoots ?? []) stack.push(child)
    for (const child of node.children ?? []) stack.push(child)
  }
  return null
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

/**
 * True for a node the tree drops only because of aria-hidden. Sites put
 * aria-hidden on icon buttons and decorative wrappers that still render and
 * still take clicks, so these get a second look against the DOM.
 */
export function isAriaHiddenAxNode(node: CdpAxNode): boolean {
  return !!node.ignored && typeof node.backendDOMNodeId === 'number'
    && (node.ignoredReasons ?? []).some(reason => reason.name.startsWith('ariaHidden'))
}

/** True when a DOM node is a native or ARIA control, judged from tag and attributes alone. */
export function isInteractiveDomNode(node: CdpDomNode): boolean {
  const tag = String(node.nodeName ?? '').toLowerCase()
  const attributes = attributeMap(node)
  if (tag === 'button' || tag === 'textarea' || tag === 'select') return true
  if (tag === 'a') return attributes.has('href')
  if (tag === 'input') return (attributes.get('type') || 'text').toLowerCase() !== 'hidden'
  if (ACTION_ROLES.has(attributes.get('role') ?? '')) return true
  const editable = attributes.get('contenteditable')
  return editable === '' || editable === 'true'
}

function domText(node: CdpDomNode): string {
  let text = ''
  const stack: CdpDomNode[] = [...(node.children ?? [])].reverse()
  while (stack.length > 0) {
    const current = stack.pop()!
    if (current.nodeName === '#text') text += (current.nodeValue ?? '') + ' '
    for (const child of [...(current.children ?? [])].reverse()) stack.push(child)
  }
  return text
}

const clean = (text: string): string => text.replace(/\s+/g, ' ').trim().slice(0, 300)

/**
 * Snapshot element for one accessibility node and its DOM node, or null when
 * the pair is not something to list.
 */
export function elementFromAx(node: CdpAxNode, dom: CdpDomNode, ref: CdpRef): CdpSnapshotElement | null {
  const attributes = attributeMap(dom)
  const tag = String(dom.nodeName ?? '').toLowerCase()
  // A native select's options are chosen with `select`, not clicked one by one.
  if (tag === 'option') return null
  const type = tag === 'input' ? (attributes.get('type') || 'text').toLowerCase() : ''

  if (isAriaHiddenAxNode(node)) {
    if (!isInteractiveDomNode(dom)) return null
    // The tree computed no name or state for an ignored node; read what the markup says.
    return {
      tag,
      role: attributes.get('role') ?? '',
      label: clean(attributes.get('aria-label') || attributes.get('title') || attributes.get('placeholder')
        || domText(dom) || attributes.get('name') || ''),
      type,
      disabled: attributes.has('disabled') || attributes.get('aria-disabled') === 'true',
      ref,
    }
  }
  if (!isActionableAxNode(node)) return null

  const editable = !!axProperty(node, 'editable')
  const rawValue = node.value?.value
  const value = type === 'password' || (!FIELD_TAGS.has(tag) && !editable) || rawValue === undefined
    ? undefined
    : String(rawValue).slice(0, 300)
  const checked = axProperty(node, 'checked')
  return {
    tag,
    role: String(node.role?.value ?? ''),
    label: clean(String(node.name?.value ?? '')),
    type,
    ...(value !== undefined ? { value } : {}),
    ...(checked !== undefined ? { checked: checked === 'true' || checked === true } : {}),
    disabled: axProperty(node, 'disabled') === true,
    ref,
  }
}

interface FrameTree {
  frame: { id: string; loaderId?: string }
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

interface TargetEvent {
  sessionId: string
  targetInfo?: { type: string; targetId: string }
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

const AUTO_ATTACH = { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }

/**
 * The one debugger attachment a page has, shared by every command running on
 * it right now. Commands overlap (a `wait` polls while a click runs), so the
 * attachment is counted: only the last user to finish detaches, and frame
 * sessions found by one user serve the others.
 */
interface SharedAttachment {
  users: number
  attachedHere: boolean
  frames: Map<string, FrameTarget>
  /** setAutoAttach calls still in flight on newly attached frame sessions. */
  settling: Set<Promise<unknown>>
  framesReady: Promise<void> | null
  onMessage: (event: unknown, method: string, params: TargetEvent, sessionId?: string) => void
  onDetach: () => void
}

const attachments = new WeakMap<WebContents, SharedAttachment>()

function openAttachment(contents: WebContents): SharedAttachment {
  const attachedHere = !contents.debugger.isAttached()
  if (attachedHere) contents.debugger.attach('1.3')
  const shared: SharedAttachment = {
    users: 0,
    attachedHere,
    frames: new Map(),
    settling: new Set(),
    framesReady: null,
    onMessage: (_event, method, params, sessionId) => {
      if (method === 'Target.detachedFromTarget') {
        for (const [targetId, frame] of shared.frames) if (frame.sessionId === params?.sessionId) shared.frames.delete(targetId)
        return
      }
      if (method !== 'Target.attachedToTarget' || params?.targetInfo?.type !== 'iframe') return
      shared.frames.set(params.targetInfo.targetId, {
        sessionId: params.sessionId,
        ...(sessionId ? { parentSessionId: sessionId } : {}),
      })
      // Frames nested inside this one are announced only once it auto-attaches too.
      const nested = contents.debugger.sendCommand('Target.setAutoAttach', AUTO_ATTACH, params.sessionId).catch(() => undefined)
      shared.settling.add(nested)
      void nested.finally(() => shared.settling.delete(nested))
    },
    // DevTools or a crash can drop the attachment; the next command starts a new one.
    onDetach: () => { if (attachments.get(contents) === shared) attachments.delete(contents) },
  }
  try {
    contents.debugger.on('message', shared.onMessage)
    contents.debugger.on('detach', shared.onDetach)
  } catch (error) {
    closeAttachment(contents, shared)
    throw error
  }
  attachments.set(contents, shared)
  return shared
}

function closeAttachment(contents: WebContents, shared: SharedAttachment): void {
  if (attachments.get(contents) === shared) attachments.delete(contents)
  try {
    contents.debugger.removeListener('message', shared.onMessage)
    contents.debugger.removeListener('detach', shared.onDetach)
  } catch { /* listeners were never added */ }
  if (shared.attachedHere && contents.debugger.isAttached()) {
    try { contents.debugger.detach() } catch { /* already gone */ }
  }
}

/**
 * CDP access to a page and, when asked, its cross-site frames, for the length
 * of one command. Refs keep backend node IDs, which stay valid across
 * attachments for as long as the node and its document exist.
 */
export class CdpPage {
  private constructor(
    private readonly contents: WebContents,
    private readonly shared: SharedAttachment,
  ) {}

  static async run<T>(contents: WebContents, withFrames: boolean, task: (page: CdpPage) => Promise<T>): Promise<T> {
    const shared = attachments.get(contents) ?? openAttachment(contents)
    shared.users += 1
    try {
      const page = new CdpPage(contents, shared)
      if (withFrames) await page.attachFrames()
      return await task(page)
    } finally {
      shared.users -= 1
      if (shared.users === 0) closeAttachment(contents, shared)
    }
  }

  async send<T = unknown>(method: string, params: Record<string, unknown> = {}, targetId: string | null = null): Promise<T> {
    const sessionId = targetId ? this.sessionFor(targetId) : undefined
    return await this.contents.debugger.sendCommand(method, params, sessionId) as T
  }

  /** Auto-attach to cross-site frames, then to frames nested inside them. */
  private async attachFrames(): Promise<void> {
    const shared = this.shared
    shared.framesReady ??= (async () => {
      await this.contents.debugger.sendCommand('Target.setAutoAttach', AUTO_ATTACH)
      // Chromium announces running frames before the command resolves, and
      // each announcement starts auto-attach on that frame. Wait until a full
      // turn of the event loop passes with nothing new in flight.
      for (let round = 0; round < 16; round += 1) {
        await Promise.all(shared.settling)
        await new Promise<void>(resolve => setImmediate(resolve))
        if (shared.settling.size === 0) break
      }
    })()
    const ready = shared.framesReady
    try {
      await ready
    } catch (error) {
      // Let the next command try again, unless one already has.
      if (shared.framesReady === ready) shared.framesReady = null
      throw error
    }
  }

  private sessionFor(targetId: string): string {
    const frame = this.shared.frames.get(targetId)
    if (!frame) throw new Error('That frame is no longer on the page; take a new snapshot')
    return frame.sessionId
  }

  private targetForSession(sessionId: string | undefined): string | null {
    if (!sessionId) return null
    for (const [targetId, frame] of this.shared.frames) if (frame.sessionId === sessionId) return targetId
    return null
  }

  /** Actionable elements of the page, then of each cross-site frame. */
  async snapshot(limit = MAX_SNAPSHOT_ELEMENTS): Promise<CdpSnapshotElement[]> {
    const elements: CdpSnapshotElement[] = []
    for (const targetId of [null, ...this.shared.frames.keys()]) {
      if (elements.length >= limit) break
      let frameElements: CdpSnapshotElement[]
      try {
        frameElements = await this.snapshotTarget(targetId, limit - elements.length)
      } catch (error) {
        // A frame can disappear mid-snapshot; the page itself must not.
        if (targetId === null) throw error
        continue
      }
      elements.push(...frameElements)
    }
    return elements.slice(0, limit)
  }

  private async snapshotTarget(targetId: string | null, limit: number): Promise<CdpSnapshotElement[]> {
    const tree = await this.send<{ frameTree?: FrameTree }>('Page.getFrameTree', {}, targetId)
    if (!tree?.frameTree) throw new Error('Page.getFrameTree returned no frames')
    const documentId = String(tree.frameTree.frame.loaderId ?? '')
    const candidates: CdpAxNode[] = []
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
      let ariaHidden = 0
      for (const node of result.nodes) {
        if (isActionableAxNode(node)) candidates.push(node)
        else if (isAriaHiddenAxNode(node) && ariaHidden < MAX_ARIA_HIDDEN_CANDIDATES) {
          ariaHidden += 1
          candidates.push(node)
        }
      }
    }
    // Tag and attributes come from one small describe call per kept node,
    // rather than shipping the whole document tree for every snapshot.
    const described = await Promise.all(candidates.map(async node => {
      try {
        const result = await this.send<{ node?: CdpDomNode }>('DOM.describeNode', {
          backendNodeId: node.backendDOMNodeId,
          // An ignored node has no computed name; its text children stand in.
          ...(node.ignored ? { depth: 3 } : {}),
        }, targetId)
        return result?.node ?? null
      } catch {
        return null
      }
    }))
    const elements: CdpSnapshotElement[] = []
    candidates.forEach((node, index) => {
      const dom = described[index]
      if (!dom || elements.length >= limit) return
      const element = elementFromAx(node, dom, { backendNodeId: node.backendDOMNodeId as number, targetId, documentId })
      if (element) elements.push(element)
    })
    return elements
  }

  /** Remote object for a ref, or a clear error when its node or document is gone. */
  async resolve(ref: CdpRef, label: string): Promise<string> {
    const gone = new Error(`Element ${label} is no longer available; take a new snapshot`)
    let tree: { frameTree?: FrameTree }
    try {
      tree = await this.send('Page.getFrameTree', {}, ref.targetId)
    } catch {
      throw gone
    }
    if (String(tree?.frameTree?.frame.loaderId ?? '') !== ref.documentId) throw gone
    try {
      const resolved = await this.send<{ object?: { objectId?: string } }>('DOM.resolveNode', { backendNodeId: ref.backendNodeId }, ref.targetId)
      if (resolved?.object?.objectId) return resolved.object.objectId
    } catch { /* fall through */ }
    throw gone
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
   * Centre of a ref's box in top-level viewport coordinates. Chromium's quads
   * already account for same-process frames; a cross-site frame reports in
   * its own viewport, so its position in the page is added.
   */
  async centerOf(ref: CdpRef, label: string): Promise<{ x: number; y: number }> {
    let quads: number[][] | undefined
    try {
      quads = (await this.send<{ quads?: number[][] }>('DOM.getContentQuads', { backendNodeId: ref.backendNodeId }, ref.targetId))?.quads
    } catch { /* not rendered */ }
    const quad = quads?.find(candidate => candidate.length === 8)
    if (!quad) throw new Error(`Element ${label} is not visible on the page`)
    const offset = await this.frameOffset(ref.targetId)
    return {
      x: (quad[0] + quad[2] + quad[4] + quad[6]) / 4 + offset.x,
      y: (quad[1] + quad[3] + quad[5] + quad[7]) / 4 + offset.y,
    }
  }

  /**
   * Where a cross-site frame's viewport sits in the top-level viewport: the
   * content box of the iframe that embeds it, summed through every parent.
   */
  private async frameOffset(targetId: string | null): Promise<{ x: number; y: number }> {
    let x = 0
    let y = 0
    let current = targetId
    for (let depth = 0; current && depth < 8; depth += 1) {
      const frame = this.shared.frames.get(current)
      if (!frame) throw new Error('That frame is no longer on the page; take a new snapshot')
      const parentTarget = this.targetForSession(frame.parentSessionId)
      const owner = await this.send<{ backendNodeId?: number }>('DOM.getFrameOwner', { frameId: current }, parentTarget)
      if (typeof owner?.backendNodeId !== 'number') throw new Error('Could not locate the frame on the page')
      const box = await this.send<{ model?: { content?: number[] } }>('DOM.getBoxModel', { backendNodeId: owner.backendNodeId }, parentTarget)
      const content = box?.model?.content
      if (!content || content.length < 2) throw new Error('Could not locate the frame on the page')
      x += content[0]
      y += content[1]
      current = parentTarget
    }
    return { x, y }
  }
}

/** The subset of Electron input events the browser controller sends. */
export type PointerInput =
  | { type: 'mouseMove'; x: number; y: number; button?: 'left' }
  | { type: 'mouseDown' | 'mouseUp'; x: number; y: number; button: 'left'; clickCount: number }
  | { type: 'mouseWheel'; x: number; y: number; deltaX: number; deltaY: number }

/**
 * CDP pointer event for an Electron one. Electron's sendInputEvent hands
 * events straight to the top page's widget, so a click or wheel over a
 * cross-site iframe never reaches it; Input.dispatchMouseEvent goes through
 * Chromium's input router, which hit-tests into the frame.
 */
export function toCdpMouseEvent(event: PointerInput): Record<string, unknown> {
  if (event.type === 'mouseMove') {
    return { type: 'mouseMoved', x: event.x, y: event.y, button: event.button ?? 'none', buttons: event.button ? 1 : 0 }
  }
  if (event.type === 'mouseWheel') {
    // Electron counts a positive delta as wheel-up; CDP, like the DOM, counts
    // it as scroll-down. Flip so both paths move the page the same way.
    return { type: 'mouseWheel', x: event.x, y: event.y, deltaX: -event.deltaX, deltaY: -event.deltaY }
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

export type KeyModifier = 'meta' | 'control' | 'alt' | 'shift'

const MODIFIER_BITS: Record<KeyModifier, number> = { alt: 1, control: 2, meta: 4, shift: 8 }

/**
 * macOS runs editing shortcuts from the app menu, which CDP key events skip,
 * so each one names the editing command to run.
 */
const MAC_EDITING_COMMANDS: Record<string, string> = {
  a: 'selectAll', c: 'copy', v: 'paste', x: 'cut', z: 'undo', 'shift+z': 'redo',
}

/**
 * CDP key events for one key press, or null when this combination should stay
 * on the Electron path. Keyboard input from sendInputEvent stops at the top
 * page, so keys for a field inside a cross-site frame need this path.
 */
export function toCdpKeyEvents(
  keyCode: string,
  modifiers: KeyModifier[] = [],
  platform: string = process.platform,
): Array<Record<string, unknown>> | null {
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

  const held = new Set(modifiers)
  const bits = modifiers.reduce((mask, modifier) => mask | MODIFIER_BITS[modifier], 0)
  let commands: string[] | undefined
  const shortcut = held.has('meta') || held.has('control') || held.has('alt')
  if (shortcut) {
    // A shortcut triggers an action; it never inserts its own character.
    text = undefined
    if (platform === 'darwin' && held.has('meta')) {
      if (held.has('control') || held.has('alt')) return null
      const command = MAC_EDITING_COMMANDS[(held.has('shift') ? 'shift+' : '') + keyCode.toLowerCase()]
      if (!command) return null
      commands = [command]
    }
  } else if (held.has('shift') && text !== undefined && !named) {
    // Shift+letter types the capital; other shifted symbols depend on the
    // keyboard layout, which only the Electron path knows.
    if (!/^[a-zA-Z]$/.test(keyCode)) return null
    key = keyCode.toUpperCase()
    text = key
  }

  const shared = { key, code, windowsVirtualKeyCode: virtual, ...(bits ? { modifiers: bits } : {}) }
  return [
    {
      type: text !== undefined ? 'keyDown' : 'rawKeyDown',
      ...shared,
      ...(text !== undefined ? { text, unmodifiedText: text } : {}),
      ...(commands ? { commands } : {}),
    },
    { type: 'keyUp', ...shared },
  ]
}
