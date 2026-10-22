import type { CuaDriverLike } from '@trycua/cua-driver'
import type { ComputerApp, ComputerCommand, ComputerReply } from './computer-control'

const actionFields: Record<string, string[]> = {
  click: ['x', 'y', 'button', 'count'],
  type_text: ['text', 'x', 'y'],
  press_key: ['key'],
  hotkey: ['keys'],
  scroll: ['direction', 'amount', 'x', 'y'],
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
        const listed = await client.listWindows({ pid: process.pid, onScreenOnly: true })
        for (const window of listed.windows) {
          if (window.pid !== undefined && window.pid !== process.pid) continue
          const windowId = Number(window.windowId)
          if (!Number.isSafeInteger(windowId) || windowId <= 0) continue
          const id = `${process.pid}:${window.windowId}`
          windows.set(id, { pid: process.pid, windowId, bundleId: allowed.bundleId, observed: false })
          result.push({ id, title: window.title, app: allowed.name })
        }
      }
      return { windows: result, text: result.length ? undefined : 'No visible windows. Open the application and try again.' }
    }
    if (!['observe', 'act', 'inspect', 'human_input'].includes(command.action)) throw new Error('Unknown Codey computer command')
    const target = windows.get(command.window ?? '')
    if (!target) throw new Error('List windows first and use a returned window ID')
    const current = (await client.listApps({})).apps.find(app => app.pid === target.pid && app.bundleId === target.bundleId && app.running)
    if (!current) { windows.delete(command.window!); throw new Error('The target application has changed; list windows again') }
    const listed = await client.listWindows({ pid: target.pid, onScreenOnly: true })
    const nativeWindow = listed.windows.find(window => window.windowId.toString() === String(target.windowId) &&
      (window.pid === undefined || window.pid === target.pid))
    if (!nativeWindow) { windows.delete(command.window!); throw new Error('The window has closed or is unavailable') }
    const resolved = { pid: target.pid, windowId: target.windowId, title: nativeWindow.title, app: current.name ?? target.bundleId }
    if (command.action === 'inspect') return { target: resolved }
    if (command.action === 'human_input') {
      const args = command.args
      if (!args || !['click', 'drag', 'scroll', 'type_text', 'press_key', 'hotkey'].includes(String(args.tool))) throw new Error('Invalid human input')
      validate()
      const observed = await client.callTool('get_window_state', JSON.stringify({ pid: target.pid, window_id: target.windowId,
        include_screenshot: true, include_accessibility_tree: false, max_dimension: 1280 }))
      if (observed.isError || !observed.images.length || !observed.structuredJson) throw new Error('Cannot verify the target window for input')
      const snapshot = JSON.parse(observed.structuredJson)
      const width = snapshot.screenshot_width
      const height = snapshot.screenshot_height
      const frameWidth = args.frameWidth
      const frameHeight = args.frameHeight
      if (![width, height, frameWidth, frameHeight].every(n => typeof n === 'number' && Number.isFinite(n) && n > 0) ||
        Math.abs(width / height / (Number(frameWidth) / Number(frameHeight)) - 1) > 0.02) {
        throw new Error('Window geometry changed. Wait for the live view to update and try again.')
      }
      const mapped: Record<string, unknown> = { ...args }
      delete mapped.frameWidth; delete mapped.frameHeight
      for (const key of ['x', 'y', 'from_x', 'from_y', 'to_x', 'to_y']) {
        if (mapped[key] === undefined) continue
        const value = mapped[key]
        if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) throw new Error('Input is outside the window')
        mapped[key] = Math.min((key.endsWith('x') ? width : height) - 1, value * (key.endsWith('x') ? width : height))
      }
      command = { action: 'act', window: command.window, args: mapped }
      target.observed = true
    }
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
