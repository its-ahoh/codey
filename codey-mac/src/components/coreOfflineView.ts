import type { CoreState } from '../../electron/core-state'

// Pure view logic for the core-offline banner and composer, extracted for
// unit testing (vitest runs in a node environment with no DOM).

export function coreBannerText(state: CoreState | null | undefined): string | null {
  if (!state || state.phase !== 'failed') return null
  const detail = state.error?.trim()
  return detail
    ? `Codey's core failed to start: ${detail}`
    : "Codey's core failed to start."
}

export function composerPlaceholder(opts: {
  coreFailed: boolean
  isGatewayRunning: boolean
  isSending: boolean
}): string {
  if (opts.coreFailed) return 'Core offline — relaunch to continue'
  if (!opts.isGatewayRunning) return 'Start gateway to chat'
  // While a turn runs the composer stays live: what you type is queued and
  // sent as soon as the agent finishes, so say so instead of "Sending…".
  return opts.isSending ? 'Queue the next message… (↵ to queue)' : 'Message Codey… (↵ to send)'
}
