import type { CuaDriverLike } from '@trycua/cua-driver'
import type { ComputerApp, ComputerCommand, ComputerReply } from './computer-control'

// `element_token` addresses one control from the latest observation through
// the accessibility API. It is the route that works on a window the user is not
// looking at (another Space, hidden, minimized); pixel coordinates need the
// window on screen and are for surfaces with no accessibility elements.
const actionFields: Record<string, string[]> = {
  click: ['element_token', 'action', 'x', 'y', 'button', 'count'],
  type_text: ['text', 'element_token', 'x', 'y'],
  press_key: ['key', 'element_token'],
  hotkey: ['keys', 'element_token'],
  scroll: ['direction', 'amount', 'element_token', 'x', 'y'],
  drag: ['from_x', 'from_y', 'to_x', 'to_y'],
  move_cursor: ['x', 'y'],
}

/** Resolve targets inside Codey. Agents never supply process IDs or native socket paths. */
export function computerCommands(client: CuaDriverLike, apps: ComputerApp[]) {
  const windows = new Map<string, { pid: number; windowId: number; bundleId: string; observed: boolean }>()
  return async (command: ComputerCommand, validate: () => void = () => {}): Promise<ComputerReply> => {
    validate()
    if (command.action === 'invalidate') {
      for (const target of windows.values()) target.observed = false
      return {}
    }
    if (command.action === 'windows') {
      const allowed = apps.find(app => app.bundleId === command.bundleId)
      if (!allowed) throw new Error('Application is outside this task grant')
      const processes = (await client.listApps({})).apps.filter(app => app.bundleId === allowed.bundleId && app.running)
      const result: NonNullable<ComputerReply['windows']> = []
      for (const [id, target] of windows) if (target.bundleId === allowed.bundleId) windows.delete(id)
      for (const process of processes) {
        // The driver works in the background, so a window on another Space
        // (or minimized) is a valid target: the user can keep their own
        // desktop while the agent works on a different one.
        const listed = await client.listWindows({ pid: process.pid, onScreenOnly: false })
        for (const window of listed.windows) {
          if (window.pid !== undefined && window.pid !== process.pid) continue
          const windowId = Number(window.windowId)
          if (!Number.isSafeInteger(windowId) || windowId <= 0) continue
          const id = `${process.pid}:${window.windowId}`
          windows.set(id, { pid: process.pid, windowId, bundleId: allowed.bundleId, observed: false })
          result.push({ id, title: window.title, app: allowed.name })
        }
      }
      return { windows: result, text: result.length ? undefined : 'No windows. Open the application and try again.' }
    }
    if (!['observe', 'act', 'inspect'].includes(command.action)) throw new Error('Unknown Codey computer command')
    const target = windows.get(command.window ?? '')
    if (!target) throw new Error('List windows first and use a returned window ID')
    const current = (await client.listApps({})).apps.find(app => app.pid === target.pid && app.bundleId === target.bundleId && app.running)
    if (!current) { windows.delete(command.window!); throw new Error('The target application has changed; list windows again') }
    const listed = await client.listWindows({ pid: target.pid, onScreenOnly: false })
    const nativeWindow = listed.windows.find(window => window.windowId.toString() === String(target.windowId) &&
      (window.pid === undefined || window.pid === target.pid))
    if (!nativeWindow) { windows.delete(command.window!); throw new Error('The window has closed or is unavailable') }
    const resolved = { pid: target.pid, windowId: target.windowId, bundleId: target.bundleId, title: nativeWindow.title, app: current.name ?? target.bundleId }
    if (command.action === 'inspect') return { target: resolved }
    let name = 'get_window_state'
    const input: Record<string, unknown> = { pid: target.pid, window_id: target.windowId }
    if (command.action === 'observe') {
      Object.assign(input, { include_screenshot: true, include_accessibility_tree: true, max_dimension: 1280 })
    } else {
      if (!target.observed) throw new Error('Observe this window before sending input')
      const args = command.args
      if (!args || typeof args.tool !== 'string' || !Object.prototype.hasOwnProperty.call(actionFields, args.tool)) throw new Error('Unsupported input action')
      name = args.tool
      for (const [key, value] of Object.entries(args)) {
        if (key === 'tool') continue
        if (!actionFields[name].includes(key) && key !== 'delivery_mode') throw new Error(`Unsupported action field: ${key}`)
        if (key === 'delivery_mode' && value !== 'background' && value !== 'foreground') throw new Error('Invalid delivery mode')
        if (key === 'element_token' && (typeof value !== 'string' || !/^s[0-9a-f]{8}:[0-9]+$/.test(value))) throw new Error('Invalid element_token; use one from the latest observe')
        if (key === 'action' && !['press', 'show_menu', 'pick', 'confirm', 'cancel', 'open'].includes(String(value))) throw new Error('Invalid click action')
        input[key] = value
      }
      input.scope = 'window'
      input.delivery_mode ??= 'background'
      target.observed = false
    }
    validate()
    const result = await client.callTool(name, JSON.stringify(input))
    if (command.action === 'observe') target.observed = !result.isError && result.images.length > 0
    return { target: resolved, text: result.text, images: result.images.slice(0, 4), isError: result.isError,
      data: result.structuredJson ? JSON.parse(result.structuredJson) : undefined }
  }
}
