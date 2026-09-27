import type { ChatMessage, ToolCallEntry } from '../types'
import { parseTeamMessage } from './teamMessageFormat'
import { splitWhiteboardMarkers } from './teamWhiteboardFormat'
import type { TeamGraph, TeamGraphNode, TeamGraphEdge } from '../../../packages/core/src/team-graph'

export type NodeRunStatus = 'pending' | 'running' | 'done' | 'failed' | 'askedUser'

export interface BotRun {
  step: number
  bot: string
  status: NodeRunStatus
  output: string
  thinking?: string
}

export interface TeamMemberMessageGroup {
  bot: string
  messages: ChatMessage[]
  latest: ChatMessage
  status: NonNullable<ChatMessage['botStatus']>
}

/** Group a chronological team transcript by bot while preserving the order
 * in which members first appeared. Revisited graph bots become rounds under
 * one member instead of repeated top-level rows. */
export function groupTeamMessagesByMember(messages: ChatMessage[]): TeamMemberMessageGroup[] {
  const grouped = new Map<string, ChatMessage[]>()
  for (const message of messages) {
    if (!message.bot) continue
    const list = grouped.get(message.bot) ?? []
    list.push(message)
    grouped.set(message.bot, list)
  }
  return [...grouped.entries()].map(([bot, unsorted]) => {
    const rounds = [...unsorted].sort((a, b) => (a.step ?? 0) - (b.step ?? 0))
    const latest = rounds[rounds.length - 1]
    const running = rounds.find(message => message.botStatus === 'running')
    return {
      bot,
      messages: rounds,
      latest,
      status: running ? 'running' : (latest.botStatus ?? 'done'),
    }
  })
}

// Gateway marks a failed team step with a leading ❌ in its output.
const FAILED_RE = /❌/

// Live per-step "is working" markers streamed as `info` events. The structured
// `**bot**:` transcript only lands when the run completes, so mid-run these
// are the only signal of which bot is active.
//   Sequential: "🔄 Step 1: **product-manager** is working..."
//   Auto:       "Step 1: alice — <reason>"  (optionally " (revision)")
const LIVE_SEQ = /^🔄 Step (\d+): \*\*(.+?)\*\* is working/
const LIVE_AUTO = /^Step (\d+): (.+?)(?: —|$)/

function parseLiveSteps(toolCalls?: ToolCallEntry[]): Array<{ step: number; bot: string }> {
  const byStep = new Map<number, string>()
  for (const tc of toolCalls ?? []) {
    if (tc.type !== 'info' || !tc.message) continue
    const m = tc.message.match(LIVE_SEQ) ?? tc.message.match(LIVE_AUTO)
    if (m) byStep.set(parseInt(m[1], 10), m[2].trim())
  }
  return [...byStep.entries()].map(([step, bot]) => ({ step, bot })).sort((a, b) => a.step - b.step)
}

export function deriveBotRuns(turn: ChatMessage, isStreaming: boolean): BotRun[] {
  // Structured transcript (has per-bot output) — authoritative once present.
  const contentSteps = parseTeamMessage(turn.content)?.steps ?? []
  // Live `info` markers — present from the moment each bot starts.
  const liveSteps = parseLiveSteps(turn.toolCalls)
  if (contentSteps.length === 0 && liveSteps.length === 0) return []

  // Merge by step number; content wins (it carries the bot's output).
  const byStep = new Map<number, { bot: string; output: string }>()
  for (const s of liveSteps) byStep.set(s.step, { bot: s.bot, output: '' })
  for (const s of contentSteps) byStep.set(s.step, { bot: s.bot, output: s.output })

  const ordered = [...byStep.entries()].sort((a, b) => a[0] - b[0])
  const lastStep = ordered[ordered.length - 1][0]
  return ordered.map(([step, v]) => {
    const status: NodeRunStatus =
      isStreaming && step === lastStep ? 'running'
      : FAILED_RE.test(v.output) ? 'failed'
      : 'done'
    return { step, bot: v.bot, status, output: v.output, thinking: turn.thinkingByStep?.[step] }
  })
}

// Derive bot runs directly from a per-bot message group (one ChatMessage
// per bot, each carrying its own step/bot/status/output/thinking).
export function deriveBotRunsFromGroup(messages: ChatMessage[]): BotRun[] {
  return messages
    .filter(m => m.teamTurnId && m.bot)
    .map(m => ({
      step: m.step ?? 0,
      bot: m.bot!,
      status: (m.botStatus ?? 'done') as NodeRunStatus,
      output: m.content,
      thinking: m.thinking,
    }))
    .sort((a, b) => a.step - b.step)
}

// Attribute tool calls to a step. Team runs are serial, so each tool event
// belongs to the most-recent preceding `🔄 Step N:` / `Step N:` marker in the
// stream. Returns only tool_start/tool_end entries (not the info markers).
export function toolCallsForStep(toolCalls: ToolCallEntry[] | undefined, step: number): ToolCallEntry[] {
  const out: ToolCallEntry[] = []
  let current = 0
  for (const tc of toolCalls ?? []) {
    if (tc.type === 'info' && tc.message) {
      const m = tc.message.match(LIVE_SEQ) ?? tc.message.match(LIVE_AUTO)
      if (m) { current = parseInt(m[1], 10); continue }
    }
    if ((tc.type === 'tool_start' || tc.type === 'tool_end') && current === step) out.push(tc)
  }
  return out
}

export function synthesizeChainGraph(runs: BotRun[]): TeamGraph {
  const bots: string[] = []
  for (const r of runs) if (!bots.includes(r.bot)) bots.push(r.bot)
  const nodes: TeamGraphNode[] = [{ id: 'start', type: 'start', x: 120, y: 40 }]
  bots.forEach((w, i) => nodes.push({ id: `w_${i}`, type: 'bot', bot: w, x: 120, y: 120 + i * 90 }))
  nodes.push({ id: 'end', type: 'end', x: 120, y: 120 + bots.length * 90 })

  const order = ['start', ...bots.map((_, i) => `w_${i}`), 'end']
  const edges: TeamGraphEdge[] = []
  for (let i = 0; i < order.length - 1; i++) edges.push({ id: `e_${i}`, from: order[i], to: order[i + 1] })
  return { entry: 'start', maxHops: bots.length + 2, nodes, edges }
}

export function nodeStatuses(graph: TeamGraph, runs: BotRun[], askingBot?: string): Record<string, NodeRunStatus> {
  const latest = new Map<string, NodeRunStatus>()
  for (const r of runs) latest.set(r.bot, r.status) // later runs overwrite -> latest wins
  const anyRunning = runs.some(r => r.status === 'running')
  const out: Record<string, NodeRunStatus> = {}
  for (const n of graph.nodes) {
    if (n.type === 'start') out[n.id] = 'done'
    else if (n.type === 'end') out[n.id] = runs.length && !anyRunning ? 'done' : 'pending'
    else if (n.type === 'bot' && n.bot) {
      if (askingBot && n.bot === askingBot) out[n.id] = 'askedUser'
      else out[n.id] = latest.get(n.bot) ?? 'pending'
    }
    // condition nodes: omitted -> neutral default styling
  }
  return out
}

export interface TeamFinalAnswer {
  bot: string
  text: string
}

const ROUNDTABLE_SUMMARY_RE = /##\s+Advisor Summary\s*\n([\s\S]*?)(?:\n##\s|$)/i

/** The one thing to show once a team run is over: the last bot's output for
 * auto / sequential / graph, or the Advisor summary for roundtable. Returns
 * null while any member is still working or waiting on the user, so the
 * live stage stays visible until the run truly ends. */
export function teamFinalAnswer(messages: ChatMessage[], mode: ChatMessage['teamMode']): TeamFinalAnswer | null {
  const bots = messages.filter(m => !!m.bot && m.botStatus !== 'pending')
  if (bots.length === 0) return null
  if (bots.some(m => m.botStatus === 'running' || m.botStatus === 'askedUser')) return null

  if (mode === 'roundtable') {
    const footer = [...messages].reverse().find(m => !m.bot && /^🪑 Roundtable:/.test(m.content.trim()))
    if (footer) {
      const summary = ROUNDTABLE_SUMMARY_RE.exec(footer.content)?.[1]?.trim()
      if (summary && summary !== '(empty)') return { bot: 'Advisor', text: summary }
    }
  }

  const last = [...bots].sort((a, b) => (a.step ?? 0) - (b.step ?? 0)).pop()!
  const text = splitWhiteboardMarkers(last.content).stripped
  if (!text) return null
  return { bot: last.bot!, text }
}
