import type { ChatMessage } from '../types'

/** Compact token count: 1200 -> "1.2k", 45000 -> "45k". Moved verbatim from
 *  ChatTab so the header formats exactly as the footer used to. */
export const formatTokens = (n: number): string | null => {
  if (!Number.isFinite(n) || n < 0) return null
  if (n < 1000) return String(n)
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`
  return `${Math.round(n / 1000)}k`
}

export interface TurnHeaderMeta {
  /** `agent · model`, whichever is known, or null when neither is. */
  identity: string | null
  /** Right-side items, already ordered. Returned as items rather than a joined
   *  string so an absent field cannot leave an orphaned separator. */
  stats: string[]
  fallback?: { from: string; to: string }
  /** Nothing to show — the caller renders the rule without a metadata row. */
  isEmpty: boolean
}

/** The metadata identifying one assistant turn, ready to render.
 *
 *  Every field on a ChatMessage that this reads is optional: older messages
 *  predate the model/token bookkeeping, and duration and tokens are only set
 *  once a turn completes, so a streaming turn legitimately has neither. */
export function turnHeaderMeta(msg: ChatMessage): TurnHeaderMeta {
  const identity = [msg.agent, msg.model].filter(Boolean).join(' · ') || null

  const stats: string[] = []
  if (msg.durationSec != null && Number.isFinite(msg.durationSec)) {
    stats.push(`${msg.durationSec}s`)
  }
  if (msg.tokens != null) {
    const tok = formatTokens(msg.tokens)
    if (tok) stats.push(`${tok} tok`)
  }

  return {
    identity,
    stats,
    fallback: msg.fallback,
    isEmpty: !identity && stats.length === 0 && !msg.fallback,
  }
}
