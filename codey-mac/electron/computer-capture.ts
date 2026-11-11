import { randomBytes } from 'node:crypto'
import type { ComputerDesktop, ComputerTarget } from './computer-control'

/** One-shot, exact-window capture grants. Never offer a desktop or OS source picker. */
export function createComputerCapture(deps: {
  renderer(): Electron.WebContents | undefined
  permitted(): boolean
  inspect(sessionId: string, window: string): Promise<ComputerTarget>
  sources(): Promise<Electron.DesktopCapturerSource[]>
}) {
  type Grant = { sessionId: string; window: string; expires: number; streamId: string }
  let armed: Grant | undefined
  let active: Grant | undefined
  let revision = 0
  return {
    async arm(sessionId: string, window: string) {
      const generation = ++revision
      armed = undefined
      if (!deps.permitted()) throw new Error('Screen Recording permission is required')
      await deps.inspect(sessionId, window)
      if (generation !== revision) throw new Error('The desktop session has changed')
      armed = { sessionId, window, expires: Date.now() + 10000, streamId: randomBytes(16).toString('hex') }
      return armed.streamId
    },
    revoke() { revision++; armed = undefined; active = undefined },
    sync(desktop: ComputerDesktop | null) {
      const grant = active ?? armed
      if (grant && (desktop?.sessionId !== grant.sessionId || desktop.window !== grant.window)) this.revoke()
    },
    release(streamId: string) {
      if (active?.streamId === streamId) active = undefined
      if (armed?.streamId === streamId) { revision++; armed = undefined }
    },
    isActive(streamId: string, sessionId: string, window: string) {
      return !!active && active.streamId === streamId && active.sessionId === sessionId && active.window === window && deps.permitted()
    },
    async handle(request: Electron.DisplayMediaRequestHandlerHandlerRequest, callback: (streams: Electron.Streams) => void) {
      const grant = armed
      const generation = revision
      armed = undefined
      const renderer = deps.renderer()
      if (!grant || !renderer || request.frame !== renderer.mainFrame || !request.userGesture || request.audioRequested ||
        !request.videoRequested || grant.expires < Date.now() || !deps.permitted()) { callback({}); return }
      try {
        const target = await deps.inspect(grant.sessionId, grant.window)
        const sources = await deps.sources()
        const source = sources.find(item => item.id.split(':')[0] === 'window' && item.id.split(':')[1] === String(target.windowId))
        const verified = await deps.inspect(grant.sessionId, grant.window)
        if (!source || generation !== revision || verified.pid !== target.pid || verified.windowId !== target.windowId ||
          !deps.permitted() || request.frame !== deps.renderer()?.mainFrame) { callback({}); return }
        active = grant
        callback({ video: source })
      } catch { callback({}) }
    },
  }
}
