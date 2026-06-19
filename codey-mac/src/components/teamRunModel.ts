import type { ChatMessage } from '../types'
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

export function deriveWorkerRuns(turn: ChatMessage, isStreaming: boolean): WorkerRun[] {
  const parsed = parseTeamMessage(turn.content)
  if (!parsed || parsed.steps.length === 0) return []
  const lastStep = parsed.steps[parsed.steps.length - 1].step
  return parsed.steps.map(s => {
    const status: NodeRunStatus =
      isStreaming && s.step === lastStep ? 'running'
      : FAILED_RE.test(s.output) ? 'failed'
      : 'done'
    return { step: s.step, worker: s.worker, status, output: s.output, thinking: turn.thinkingByStep?.[s.step] }
  })
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
