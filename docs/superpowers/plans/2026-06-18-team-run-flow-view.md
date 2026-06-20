# Team Run Flow View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In team mode, add a full-screen flow-graph overlay where each worker is a node and clicking a worker shows that worker's output and thinking.

**Architecture:** Three new Mac-only pieces — a pure run-model deriver (`teamRunModel.ts`), a shared graph renderer extracted from `FlowEditor.tsx` (`flowGraph.tsx`), and the overlay (`TeamRunFlow.tsx`) — wired into `ChatContextPanel`/`ChatTab`. No `packages/core` or `packages/gateway` changes. Per-worker tool calls are a deferred follow-up (the gateway doesn't stream them today).

**Tech Stack:** React + TypeScript, `@xyflow/react` (React Flow), Vitest. Spec: `docs/superpowers/specs/2026-06-18-team-run-flow-view-design.md`.

**Setup note:** Tests need Node ≥ 22 (`nvm use 22.17.1`). Run codey-mac tests with `npm test -w codey-mac` (which runs `vitest run`); target one file by appending the path.

---

### Task 1: Run-model deriver — `deriveWorkerRuns`

**Files:**
- Create: `codey-mac/src/components/teamRunModel.ts`
- Test: `codey-mac/src/components/teamRunModel.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// codey-mac/src/components/teamRunModel.test.ts
import { describe, it, expect } from 'vitest'
import { deriveWorkerRuns } from './teamRunModel'
import type { ChatMessage } from '../types'

const teamTurn = (over: Partial<ChatMessage> = {}): ChatMessage => ({
  id: 't1', role: 'assistant', timestamp: 0, isComplete: true,
  content: '### Step 1: product-manager\n\nPM output here.\n\n---\n\n### Step 2: developer\n\n❌ Failed - build error',
  thinkingByStep: { 1: 'pm reasoning', 2: 'dev reasoning' },
  ...over,
})

describe('deriveWorkerRuns', () => {
  it('maps each step to a worker run with output and thinking', () => {
    const runs = deriveWorkerRuns(teamTurn(), false)
    expect(runs).toHaveLength(2)
    expect(runs[0]).toMatchObject({ step: 1, worker: 'product-manager', output: 'PM output here.', thinking: 'pm reasoning', status: 'done' })
    expect(runs[1]).toMatchObject({ step: 2, worker: 'developer', thinking: 'dev reasoning' })
  })

  it('marks the last step running while streaming', () => {
    const runs = deriveWorkerRuns(teamTurn(), true)
    expect(runs[1].status).toBe('running')
  })

  it('marks a failed-output step failed when not streaming', () => {
    const runs = deriveWorkerRuns(teamTurn(), false)
    expect(runs[1].status).toBe('failed')
  })

  it('returns [] for a non-team turn', () => {
    const runs = deriveWorkerRuns(teamTurn({ content: 'just a normal reply' }), false)
    expect(runs).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w codey-mac -- teamRunModel`
Expected: FAIL — `deriveWorkerRuns` is not exported / module missing.

- [ ] **Step 3: Write minimal implementation**

```ts
// codey-mac/src/components/teamRunModel.ts
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

const FAILED_RE = /❌|\bFailed\b/

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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w codey-mac -- teamRunModel`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add codey-mac/src/components/teamRunModel.ts codey-mac/src/components/teamRunModel.test.ts
git commit -m "feat(codey-mac): deriveWorkerRuns for team run flow view"
```

---

### Task 2: Run-model deriver — `synthesizeChainGraph` + `nodeStatuses`

**Files:**
- Modify: `codey-mac/src/components/teamRunModel.ts`
- Test: `codey-mac/src/components/teamRunModel.test.ts`

- [ ] **Step 1: Write the failing test** (append to the existing test file)

```ts
import { synthesizeChainGraph, nodeStatuses } from './teamRunModel'
import type { WorkerRun } from './teamRunModel'
import { validateGraph } from '../../../packages/core/src/team-graph'

const run = (step: number, worker: string, status: WorkerRun['status']): WorkerRun =>
  ({ step, worker, status, output: 'o' })

describe('synthesizeChainGraph', () => {
  it('builds start -> w1 -> w2 -> end and validates', () => {
    const runs = [run(1, 'pm', 'done'), run(2, 'dev', 'running')]
    const g = synthesizeChainGraph(runs)
    expect(g.entry).toBe('start')
    expect(g.nodes.find(n => n.type === 'start')).toBeTruthy()
    expect(g.nodes.find(n => n.type === 'end')).toBeTruthy()
    expect(g.nodes.filter(n => n.type === 'worker').map(n => n.worker)).toEqual(['pm', 'dev'])
    expect(validateGraph(g, ['pm', 'dev'])).toEqual([])
  })

  it('dedupes a revisited worker into one node', () => {
    const g = synthesizeChainGraph([run(1, 'pm', 'done'), run(2, 'dev', 'done'), run(3, 'pm', 'done')])
    expect(g.nodes.filter(n => n.type === 'worker')).toHaveLength(2)
  })
})

describe('nodeStatuses', () => {
  it('maps run status onto matching worker nodes, pending for unreached', () => {
    const runs = [run(1, 'pm', 'done')]
    const g = synthesizeChainGraph([run(1, 'pm', 'done'), run(2, 'dev', 'done')])
    const st = nodeStatuses(g, runs)
    const pmNode = g.nodes.find(n => n.worker === 'pm')!
    const devNode = g.nodes.find(n => n.worker === 'dev')!
    expect(st[pmNode.id]).toBe('done')
    expect(st[devNode.id]).toBe('pending')
  })

  it('marks the asking worker askedUser', () => {
    const g = synthesizeChainGraph([run(1, 'pm', 'done'), run(2, 'dev', 'running')])
    const st = nodeStatuses(g, [run(1, 'pm', 'done'), run(2, 'dev', 'running')], 'dev')
    const devNode = g.nodes.find(n => n.worker === 'dev')!
    expect(st[devNode.id]).toBe('askedUser')
  })

  it('end is pending while a run is running, done otherwise', () => {
    const g = synthesizeChainGraph([run(1, 'pm', 'done')])
    const endId = g.nodes.find(n => n.type === 'end')!.id
    expect(nodeStatuses(g, [run(1, 'pm', 'running')])[endId]).toBe('pending')
    expect(nodeStatuses(g, [run(1, 'pm', 'done')])[endId]).toBe('done')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w codey-mac -- teamRunModel`
Expected: FAIL — `synthesizeChainGraph` / `nodeStatuses` not exported.

- [ ] **Step 3: Write minimal implementation** (append to `teamRunModel.ts`)

```ts
import type { TeamGraph, TeamGraphNode, TeamGraphEdge } from '../../../packages/core/src/team-graph'

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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w codey-mac -- teamRunModel`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add codey-mac/src/components/teamRunModel.ts codey-mac/src/components/teamRunModel.test.ts
git commit -m "feat(codey-mac): synthesizeChainGraph + nodeStatuses"
```

---

### Task 3: Extract shared graph renderer into `flowGraph.tsx`

This is a refactor: move the node/edge renderers and helpers out of `FlowEditor.tsx` into a shared module, add optional `status` styling to worker/terminal nodes, and have `FlowEditor` import them. **No behavior change to FlowEditor.**

**Files:**
- Create: `codey-mac/src/components/flowGraph.tsx`
- Modify: `codey-mac/src/components/FlowEditor.tsx`

- [ ] **Step 1: Create `flowGraph.tsx`** — move these verbatim from `FlowEditor.tsx` (lines 14–124): `EDGE_COLOR`, `resolveColor`, `HANDLE_IDS`, `HANDLE_POS`, `NodeHandles`, `ring`, `WorkerNodeView`, `ConditionNodeView`, `TerminalNodeView`, `nodeTypes`, `FlowEdgeView`, `edgeTypes`. Add the imports they need and the new `status` styling + `rfNodeType`. Full file:

```tsx
// codey-mac/src/components/flowGraph.tsx
import {
  Handle, Position, NodeResizer,
  BaseEdge, EdgeLabelRenderer, getBezierPath,
  type NodeProps, type EdgeProps,
} from '@xyflow/react'
import { C } from '../theme'
import type { NodeRunStatus } from './teamRunModel'

export const EDGE_COLOR = C.accent

export const resolveColor = (cssVar: string) =>
  getComputedStyle(document.documentElement).getPropertyValue(cssVar.slice(4, -1)).trim()

const HANDLE_IDS = ['t', 'r', 'b', 'l'] as const
const HANDLE_POS = { t: Position.Top, r: Position.Right, b: Position.Bottom, l: Position.Left }

function NodeHandles() {
  return (
    <>
      {HANDLE_IDS.map(id => (
        <Handle key={id} type="source" id={id} position={HANDLE_POS[id]} style={{ width: 9, height: 9, background: C.accent }} />
      ))}
    </>
  )
}

function ring(selected?: boolean, bad?: boolean): string | undefined {
  if (selected) return `0 0 0 3px ${C.accent}, 0 0 14px 2px ${C.accent}`
  if (bad) return `0 0 0 1px ${C.red}`
  return undefined
}

// Status-driven accents for the read-only run view. Returns undefined for
// authoring (no status) so FlowEditor renders exactly as before.
function statusBorder(status?: NodeRunStatus): string | undefined {
  switch (status) {
    case 'done': return C.green
    case 'running': return C.accent
    case 'failed': return C.red
    case 'askedUser': return C.accent
    default: return undefined
  }
}
function statusGlow(status?: NodeRunStatus): string | undefined {
  if (status === 'running') return `0 0 12px 1px ${C.accent}`
  return undefined
}
const STATUS_ICON: Record<NodeRunStatus, string> = {
  done: '✓', running: '◐', failed: '✕', askedUser: '？', pending: '○',
}

export function WorkerNodeView({ data, selected }: NodeProps) {
  const d = data as { label: string; role?: string; bad?: boolean; status?: NodeRunStatus }
  const sBorder = statusBorder(d.status)
  return (
    <div style={{ minWidth: 100, padding: '8px 12px', borderRadius: 8, background: C.surface2, border: `1px solid ${d.bad ? C.red : sBorder ?? C.border}`, color: C.fg, boxSizing: 'border-box', boxShadow: ring(selected, d.bad) ?? statusGlow(d.status), opacity: d.status === 'pending' ? 0.5 : 1 }}>
      <NodeResizer isVisible={selected} minWidth={100} minHeight={44} />
      <div style={{ fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap' }}>
        {d.status && <span style={{ marginRight: 6, color: sBorder ?? C.fg2 }}>{STATUS_ICON[d.status]}</span>}
        {d.label}
      </div>
      {d.role && <div style={{ fontSize: 11, color: C.fg2, marginTop: 2, maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.role}</div>}
      <NodeHandles />
    </div>
  )
}

export function ConditionNodeView({ data, selected }: NodeProps) {
  const d = data as { condition?: string; bad?: boolean }
  const text = d.condition?.trim() || 'condition?'
  return (
    <div style={{ width: 130, height: 130, display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative' }}>
      <div style={{ position: 'absolute', inset: 19, transform: 'rotate(45deg)', background: C.surface2, border: `1px solid ${d.bad ? C.red : C.accent}`, borderRadius: 8, boxShadow: ring(selected, d.bad) }} />
      <span style={{ position: 'relative', fontSize: 10, lineHeight: 1.25, color: C.fg, width: 78, textAlign: 'center', display: '-webkit-box', WebkitLineClamp: 5, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{text}</span>
      <NodeHandles />
    </div>
  )
}

export function TerminalNodeView({ data, selected }: NodeProps) {
  const d = data as { label: string; bad?: boolean }
  return (
    <div style={{ padding: '10px 22px', borderRadius: 999, background: C.bg, border: `1px solid ${d.bad ? C.red : C.border}`, color: C.fg, fontSize: 14, fontWeight: 600, boxShadow: ring(selected, d.bad) }}>
      {d.label}
      <NodeHandles />
    </div>
  )
}

export const nodeTypes = { workerNode: WorkerNodeView, conditionNode: ConditionNodeView, terminalNode: TerminalNodeView }

export function FlowEdgeView({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd, label, data, selected }: EdgeProps) {
  const [edgePath, labelX, labelY] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition })
  const running = (data as any)?.running
  const stroke = selected ? C.accent : running ? EDGE_COLOR : C.fg2
  return (
    <>
      {selected && <path d={edgePath} fill="none" stroke={C.accent} strokeWidth={9} strokeLinecap="round" style={{ opacity: 0.25 }} />}
      <BaseEdge id={id} path={edgePath} markerEnd={markerEnd} style={{ stroke, strokeWidth: selected ? 3.5 : 1.5 }} />
      {running && (
        <circle r={4} fill={stroke}>
          <animateMotion dur="1.6s" repeatCount="indefinite" path={edgePath} rotate="auto" />
        </circle>
      )}
      {label != null && label !== '' && (
        <EdgeLabelRenderer>
          <div style={{
            position: 'absolute', transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            background: C.bg, color: C.fg2, fontSize: 10, padding: '1px 5px', borderRadius: 4,
            border: `1px solid ${C.border}`, pointerEvents: 'none',
          }}>{String(label)}</div>
        </EdgeLabelRenderer>
      )}
    </>
  )
}

export const edgeTypes = { flowEdge: FlowEdgeView }

// data.type -> React Flow node type (mirrors the inline mapping FlowEditor used).
export const rfNodeType = (t: string): string =>
  t === 'worker' ? 'workerNode' : t === 'condition' ? 'conditionNode' : 'terminalNode'
```

- [ ] **Step 2: Update `FlowEditor.tsx` to import from `flowGraph`**

Delete the moved blocks (lines 14–124: `EDGE_COLOR` through `const edgeTypes`) and the now-unused imports they pulled in (`Handle`, `Position`, `NodeResizer`, `BaseEdge`, `EdgeLabelRenderer`, `getBezierPath`, `NodeProps`, `EdgeProps` — keep any still used elsewhere in the file). Add:

```tsx
import { nodeTypes, edgeTypes, EDGE_COLOR, resolveColor, rfNodeType } from './flowGraph'
```

Then replace the inline node-type mapping at the old `FlowEditor.tsx:142-143`:

```tsx
    const t = (n.data as any).type
    const rfType = t === 'worker' ? 'workerNode' : t === 'condition' ? 'conditionNode' : 'terminalNode'
```

with:

```tsx
    const t = (n.data as any).type
    const rfType = rfNodeType(t)
```

- [ ] **Step 3: Type-check**

Run: `cd codey-mac && npx tsc --noEmit`
Expected: no errors. (Fix any leftover unused-import errors by trimming the `@xyflow/react` import list in `FlowEditor.tsx`.)

- [ ] **Step 4: Verify existing tests still pass**

Run: `npm test -w codey-mac`
Expected: PASS — existing `flowEditorModel`/other suites unaffected.

- [ ] **Step 5: Commit**

```bash
git add codey-mac/src/components/flowGraph.tsx codey-mac/src/components/FlowEditor.tsx
git commit -m "refactor(codey-mac): extract shared flow graph renderer with status styling"
```

---

### Task 4: The overlay — `TeamRunFlow.tsx`

**Files:**
- Create: `codey-mac/src/components/TeamRunFlow.tsx`

- [ ] **Step 1: Write the component**

```tsx
// codey-mac/src/components/TeamRunFlow.tsx
import { useMemo, useState, useEffect } from 'react'
import { ReactFlow, ReactFlowProvider, type Node, type Edge } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import type { ChatMessage } from '../types'
import type { TeamGraph } from '../../../packages/core/src/team-graph'
import { toFlow } from './flowEditorModel'
import { nodeTypes, edgeTypes, rfNodeType } from './flowGraph'
import { deriveWorkerRuns, synthesizeChainGraph, nodeStatuses } from './teamRunModel'
import { C, useEffectiveTheme } from '../theme'
import Markdown from './Markdown'

interface Props {
  turn: ChatMessage
  isStreaming: boolean
  teamGraph?: TeamGraph
  askingWorker?: string
  onClose: () => void
}

const secondaryBtn = { fontSize: 12, background: C.surface2, color: C.fg, border: `1px solid ${C.border2}`, borderRadius: 6, padding: '4px 12px', cursor: 'pointer' } as const

function TeamRunFlowInner({ turn, isStreaming, teamGraph, askingWorker, onClose }: Props) {
  const effectiveTheme = useEffectiveTheme()
  const runs = useMemo(() => deriveWorkerRuns(turn, isStreaming), [turn.content, turn.thinkingByStep, isStreaming])
  const graph: TeamGraph = useMemo(() => teamGraph ?? synthesizeChainGraph(runs), [teamGraph, runs])
  const statuses = useMemo(() => nodeStatuses(graph, runs, askingWorker), [graph, runs, askingWorker])

  const runByWorker = useMemo(() => {
    const m = new Map<string, ReturnType<typeof deriveWorkerRuns>[number]>()
    for (const r of runs) m.set(r.worker, r) // latest wins
    return m
  }, [runs])

  const { nodes, edges } = useMemo(() => {
    const f = toFlow(graph)
    const rfNodes: Node[] = f.nodes.map(n => ({
      ...n,
      type: rfNodeType((n.data as any).type),
      data: { ...n.data, status: statuses[n.id] },
    })) as any
    const rfEdges: Edge[] = f.edges.map(e => ({ ...e, type: 'flowEdge' })) as any
    return { nodes: rfNodes, edges: rfEdges }
  }, [graph, statuses])

  // Default selection: the running worker, else the last run.
  const [selWorker, setSelWorker] = useState<string | null>(null)
  useEffect(() => {
    if (selWorker && runByWorker.has(selWorker)) return
    const running = runs.find(r => r.status === 'running')
    setSelWorker((running ?? runs[runs.length - 1])?.worker ?? null)
  }, [runs, selWorker, runByWorker])

  const sel = selWorker ? runByWorker.get(selWorker) : undefined
  const [showThinking, setShowThinking] = useState(false)

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div onClick={e => e.stopPropagation()} style={{ width: '90vw', height: '85vh', background: C.bg, border: `1px solid ${C.border}`, borderRadius: 10, display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px', borderBottom: `1px solid ${C.border}` }}>
          <strong style={{ flex: 1 }}>Workflow run</strong>
          <button onClick={onClose} style={secondaryBtn}>Close</button>
        </div>
        <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
          <div style={{ flex: 1.4, minWidth: 0, borderRight: `1px solid ${C.border}` }}>
            <ReactFlow
              nodes={nodes} edges={edges}
              nodeTypes={nodeTypes} edgeTypes={edgeTypes}
              onNodeClick={(_, n) => { const w = (n.data as any)?.worker; if (w) setSelWorker(w) }}
              nodesDraggable={false} nodesConnectable={false} elementsSelectable
              fitView fitViewOptions={{ maxZoom: 1, padding: 0.2 }} minZoom={0.2} maxZoom={1.5}
              colorMode={effectiveTheme}
            />
          </div>
          <div style={{ flex: 1, minWidth: 260, padding: 16, overflowY: 'auto' }}>
            {sel ? (
              <>
                <div style={{ fontWeight: 600, color: C.fg, marginBottom: 2 }}>{sel.worker}</div>
                <div style={{ fontSize: 11, color: C.fg2, marginBottom: 12 }}>Step {sel.step} · {sel.status}</div>
                <div style={{ fontSize: 11, textTransform: 'uppercase', color: C.fg3, marginBottom: 6 }}>Output</div>
                <Markdown>{sel.output || '(no output yet)'}</Markdown>
                {sel.thinking && (
                  <div style={{ marginTop: 14 }}>
                    <button onClick={() => setShowThinking(s => !s)} style={{ ...secondaryBtn, fontSize: 11 }}>
                      {showThinking ? 'Hide thinking' : 'Thinking ▸'}
                    </button>
                    {showThinking && <div style={{ marginTop: 8, fontSize: 12, color: C.fg2, whiteSpace: 'pre-wrap' }}>{sel.thinking}</div>}
                  </div>
                )}
              </>
            ) : (
              <div style={{ fontSize: 12, color: C.fg3 }}>Select a worker to see its output.</div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

export default function TeamRunFlow(props: Props) {
  return <ReactFlowProvider><TeamRunFlowInner {...props} /></ReactFlowProvider>
}
```

- [ ] **Step 2: Type-check**

Run: `cd codey-mac && npx tsc --noEmit`
Expected: no errors. If `Markdown`'s export is named rather than default, adjust the import to match `FlowEditor`/`ChatTab` usage (`grep "import .*Markdown" codey-mac/src/components/ChatTab.tsx`).

- [ ] **Step 3: Commit**

```bash
git add codey-mac/src/components/TeamRunFlow.tsx
git commit -m "feat(codey-mac): TeamRunFlow overlay (graph + worker output/thinking drawer)"
```

---

### Task 5: Wire the trigger into `ChatContextPanel` + fetch graph in `ChatTab`

**Files:**
- Modify: `codey-mac/src/components/ChatContextPanel.tsx`
- Modify: `codey-mac/src/components/ChatTab.tsx`

- [ ] **Step 1: Fetch the team graph in `ChatTab.tsx`**

Near the existing teams refresh (`ChatTab.tsx:393`, `apiService.getTeams(ws).then(setTeamNames)`), add state and a fetch for the selected team's graph:

```tsx
const [panelTeamGraph, setPanelTeamGraph] = useState<import('../../../packages/core/src/team-graph').TeamGraph | undefined>(undefined)

useEffect(() => {
  if (!panelTeamName) { setPanelTeamGraph(undefined); return }
  apiService.getGlobalTeams()
    .then(teams => setPanelTeamGraph((teams[panelTeamName] as any)?.graph))
    .catch(() => setPanelTeamGraph(undefined))
}, [panelTeamName])
```

Pass it to the panel (at the existing `<ChatContextPanel ... teamName={panelTeamName}` around line 1391):

```tsx
              teamGraph={panelTeamGraph}
```

- [ ] **Step 2: Accept the prop + render the trigger/overlay in `ChatContextPanel.tsx`**

Add to the `Props` interface (near `teamName`):

```tsx
  /** Authored flow graph for the chat's team, if any. */
  teamGraph?: import('../../../packages/core/src/team-graph').TeamGraph
```

Add `teamGraph` to the destructured props (the list starting `effectiveAgent, effectiveModel, workerName, teamName, workingDir,`).

Add overlay state at the top of the component body:

```tsx
  const [flowOpen, setFlowOpen] = React.useState(false)
```

In the `tab === 'current'` branch, replace the existing `TeamFlow` block:

```tsx
            {turn && (
              <TeamFlow
                turn={turn}
                isStreaming={isTurnStreaming}
                onScrollToStep={onScrollToStep}
              />
            )}
```

with a version that adds the button (only meaningful for team turns — `TeamFlow` already returns null for non-team turns, and `deriveWorkerRuns` echoes that):

```tsx
            {turn && teamName && (
              <Section title="Team flow">
                <button onClick={() => setFlowOpen(true)} style={{ fontSize: 12, background: C.surface2, color: C.fg, border: `1px solid ${C.border2}`, borderRadius: 6, padding: '4px 12px', cursor: 'pointer', marginBottom: 8 }}>
                  View flow ⤢
                </button>
              </Section>
            )}
            {turn && (
              <TeamFlow
                turn={turn}
                isStreaming={isTurnStreaming}
                onScrollToStep={onScrollToStep}
              />
            )}
```

Add the overlay mount just before the closing `</>` of the `tab === 'current'` branch (after the `{!turn && ...}` line):

```tsx
            {flowOpen && turn && (
              <TeamRunFlow
                turn={turn}
                isStreaming={isTurnStreaming}
                teamGraph={teamGraph}
                askingWorker={chat.pendingTeam?.askingWorker}
                onClose={() => setFlowOpen(false)}
              />
            )}
```

Add the import at the top of `ChatContextPanel.tsx`:

```tsx
import TeamRunFlow from './TeamRunFlow'
```

- [ ] **Step 3: Type-check**

Run: `cd codey-mac && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Build the renderer to confirm no runtime import cycles**

Run: `npm run build -w codey-mac` (or the app's existing build script — check `codey-mac/package.json` `scripts`)
Expected: build succeeds.

- [ ] **Step 5: Commit**

```bash
git add codey-mac/src/components/ChatContextPanel.tsx codey-mac/src/components/ChatTab.tsx
git commit -m "feat(codey-mac): View flow button + TeamRunFlow overlay wiring"
```

---

### Task 6: Manual verification

- [ ] **Step 1:** Launch the Mac app, open a chat whose selection is a team, and run a multi-worker `/team` task.
- [ ] **Step 2:** In the TOOLS tab, click **View flow ⤢**. Confirm: the graph matches the FlowEditor canvas style; the running worker glows and is auto-selected; the drawer shows that worker's output (Markdown) and a collapsible Thinking section.
- [ ] **Step 3:** Click other worker nodes — the drawer swaps to each worker's output/thinking. Done workers show ✓, unreached show dim ○.
- [ ] **Step 4:** Confirm an authored-graph team (one with a workflow in FlowEditor) renders its real branches; an `auto`/`parallel` team renders the synthesized chain.
- [ ] **Step 5:** Toggle dark/light (and classic/terminal) — node colors and drawer stay legible.
```

