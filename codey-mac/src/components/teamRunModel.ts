import type { ChatMessage } from '../types'
import { parseTeamMessage } from './teamMessageFormat'

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
