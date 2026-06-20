import type { ChatMessage, ToolCallEntry } from '../types'
import { parseTeamMessage } from './teamMessageFormat'
import type { TeamGraph, TeamGraphNode, TeamGraphEdge } from '../../../packages/core/src/team-graph'

export type NodeRunStatus = 'pending' | 'running' | 'done' | 'failed' | 'askedUser'

export interface WorkerRun {
  step: number
  worker: string
  status: NodeRunStatus
  output: string
  thinking?: string
}

// Gateway marks a failed team step with a leading ❌ in its output.
const FAILED_RE = /❌/

// Live per-step "is working" markers streamed as `info` events. The structured
// `**worker**:` transcript only lands when the run completes, so mid-run these
// are the only signal of which worker is active.
//   Sequential: "🔄 Step 1: **product-manager** is working..."
//   Auto:       "Step 1: alice — <reason>"  (optionally " (revision)")
const LIVE_SEQ = /^🔄 Step (\d+): \*\*(.+?)\*\* is working/
const LIVE_AUTO = /^Step (\d+): (.+?)(?: —|$)/

function parseLiveSteps(toolCalls?: ToolCallEntry[]): Array<{ step: number; worker: string }> {
  const byStep = new Map<number, string>()
  for (const tc of toolCalls ?? []) {
    if (tc.type !== 'info' || !tc.message) continue
    const m = tc.message.match(LIVE_SEQ) ?? tc.message.match(LIVE_AUTO)
    if (m) byStep.set(parseInt(m[1], 10), m[2].trim())
  }
  return [...byStep.entries()].map(([step, worker]) => ({ step, worker })).sort((a, b) => a.step - b.step)
}

export function deriveWorkerRuns(turn: ChatMessage, isStreaming: boolean): WorkerRun[] {
  // Structured transcript (has per-worker output) — authoritative once present.
  const contentSteps = parseTeamMessage(turn.content)?.steps ?? []
  // Live `info` markers — present from the moment each worker starts.
  const liveSteps = parseLiveSteps(turn.toolCalls)
  if (contentSteps.length === 0 && liveSteps.length === 0) return []

  // Merge by step number; content wins (it carries the worker's output).
  const byStep = new Map<number, { worker: string; output: string }>()
  for (const s of liveSteps) byStep.set(s.step, { worker: s.worker, output: '' })
  for (const s of contentSteps) byStep.set(s.step, { worker: s.worker, output: s.output })

  const ordered = [...byStep.entries()].sort((a, b) => a[0] - b[0])
  const lastStep = ordered[ordered.length - 1][0]
  return ordered.map(([step, v]) => {
    const status: NodeRunStatus =
      isStreaming && step === lastStep ? 'running'
      : FAILED_RE.test(v.output) ? 'failed'
      : 'done'
    return { step, worker: v.worker, status, output: v.output, thinking: turn.thinkingByStep?.[step] }
  })
}

// Derive worker runs directly from a per-worker message group (one ChatMessage
// per worker, each carrying its own step/worker/status/output/thinking).
export function deriveWorkerRunsFromGroup(messages: ChatMessage[]): WorkerRun[] {
  return messages
    .filter(m => m.teamTurnId && m.worker)
    .map(m => ({
      step: m.step ?? 0,
      worker: m.worker!,
      status: (m.workerStatus ?? 'done') as NodeRunStatus,
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

export function synthesizeChainGraph(runs: WorkerRun[]): TeamGraph {
  const workers: string[] = []
  for (const r of runs) if (!workers.includes(r.worker)) workers.push(r.worker)
  const nodes: TeamGraphNode[] = [{ id: 'start', type: 'start', x: 120, y: 40 }]
  workers.forEach((w, i) => nodes.push({ id: `w_${i}`, type: 'worker', worker: w, x: 120, y: 120 + i * 90 }))
  nodes.push({ id: 'end', type: 'end', x: 120, y: 120 + workers.length * 90 })

  const order = ['start', ...workers.map((_, i) => `w_${i}`), 'end']
  const edges: TeamGraphEdge[] = []
  for (let i = 0; i < order.length - 1; i++) edges.push({ id: `e_${i}`, from: order[i], to: order[i + 1] })
  return { entry: 'start', maxHops: workers.length + 2, nodes, edges }
}

export function nodeStatuses(graph: TeamGraph, runs: WorkerRun[], askingWorker?: string): Record<string, NodeRunStatus> {
  const latest = new Map<string, NodeRunStatus>()
  for (const r of runs) latest.set(r.worker, r.status) // later runs overwrite -> latest wins
  const anyRunning = runs.some(r => r.status === 'running')
  const out: Record<string, NodeRunStatus> = {}
  for (const n of graph.nodes) {
    if (n.type === 'start') out[n.id] = 'done'
    else if (n.type === 'end') out[n.id] = runs.length && !anyRunning ? 'done' : 'pending'
    else if (n.type === 'worker' && n.worker) {
      if (askingWorker && n.worker === askingWorker) out[n.id] = 'askedUser'
      else out[n.id] = latest.get(n.worker) ?? 'pending'
    }
    // condition nodes: omitted -> neutral default styling
  }
  return out
}
