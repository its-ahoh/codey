# Workflow routing: programmatic walk, aide only at diamonds

Date: 2026-06-18
Status: Approved (design)

## Problem

A Sequential (`dispatch: 'all'`) team may define a workflow graph that routes
execution between worker nodes, condition diamonds, `start`, and `end`. Today
the gateway calls a **judge LLM on the large Advisor model after every worker
and at every diamond** (`pickNextGraphEdge` → `runJudge` with
`getAdvisorAgentAndModel()`), even when a node has a single outgoing edge and
there is no decision to make.

This is wasteful: following a straight sequence or a loop needs no LLM, and
where a real choice exists at a worker the worker — itself an LLM that already
has the full task context — can choose its own next edge. The only place that
genuinely needs separate routing logic is a **condition diamond**, and that is
a narrow yes/no classification that should run on the small **aide** model, not
the Advisor.

## Goals

- No LLM call is made purely to advance the flow through single-edge workers,
  `start`, or loops.
- A worker with multiple outgoing edges routes itself (picks exactly one edge).
- Condition diamonds are judged by the **aide** (small model), not the Advisor.
- No graph-schema change, no new config, no FlowEditor change.

## Non-goals (v1)

- **Fan-out.** A worker activates exactly one outgoing edge. Activating several
  branches (parallel sub-flows + merge) is explicitly out of scope and would be
  modeled later, likely via an explicit fan-out node.
- Changing `maxHops`, `maxCalls`/`eligibleEdges`, `[ASK_USER]` pause/resume, the
  blackboard, or `resolveEdge` fallback semantics.
- Changing graph validation. Multi-edge workers are already valid; flows are
  still expected to reach an `end` node.

## Design

### Per-node behavior in `continueGraphRun` (packages/gateway/src/gateway.ts)

The walk remains a single-cursor `GraphRunState` (one `currentNodeId`).

1. **Worker, exactly 1 eligible outgoing edge** — follow it programmatically.
   No LLM call. Emit the existing `↪️` status.
2. **Worker, ≥2 eligible outgoing edges** — the worker self-routes:
   - Before the worker runs, its prompt gains a short **"Next step"** section
     listing each outgoing edge as a stable choice: the target (`worker name`
     or `end`) plus the edge's condition/label text.
   - The worker emits its choice as a marker in its output, e.g.
     `[NEXT: <target>]`, parsed alongside the existing `[ASK_USER]` /
     `[ASK_ADVISOR]` handling.
   - Resolve the marker to one outgoing edge. Fallback order if the marker is
     missing or does not match: the `isDefault` edge, else the first outgoing
     edge. No judge LLM is involved.
3. **Worker, 0 outgoing edges** — stop (end of flow). Safety stop only;
   validation still expects an `end` node.
4. **Condition diamond** — judge with the **aide**: `runJudge` is called with
   `getAideAgentAndModel()` and the aide runner (instead of
   `getAdvisorAgentAndModel()` + `advisorRunner`). This is the only LLM call
   made purely for routing. `resolveEdge` keeps its current fallback (the `no`
   branch when the judge's pick is invalid).

`[ASK_USER]` pause/resume is unchanged. A self-routing worker that also asks the
user pauses first (as today); on resume it completes and its `[NEXT: …]` choice
is parsed from the resumed output.

### Marker parsing and prompt snippet (packages/core)

- Add `parseNextEdge(output, options)` — extracts the `[NEXT: <target>]` choice
  and matches it to one of the offered targets (case-insensitive, tolerant of
  the worker echoing the label). Returns the chosen edge id or `null`.
- Add a small builder that renders the "Next step" options list, reused by the
  worker-prompt assembly (`buildSequentialWorkerPrompt` gains the options, or a
  sibling helper appends them).
- The worker chooses by **target/label**, never by internal edge id.

### Configuration

Reuse the existing `aide.{agent, model}` in `gateway.json` (already falls back
to the gateway default agent/model). No `judge` config is added.

## Data flow

```
settle(start) → worker
  worker: build prompt (+ Next-step options iff >1 edge) → run → ingest output
    1 edge  → advance(edge)                         [no LLM]
    >1 edge → parseNextEdge(output) → resolve → advance   [no routing LLM]
    0 edges → stop
  diamond: runJudge(aide) → resolveEdge → advance   [aide LLM only here]
loop until end (done) or maxHops (capped)
```

## Testing

- Single-edge worker advances with **no** routing LLM call (assert the
  judge/aide runner is not invoked).
- Multi-edge worker follows its emitted `[NEXT: …]` choice; falls back to the
  default edge, then the first edge, when the marker is absent/invalid.
- Condition diamond invokes the **aide** runner/model (not the Advisor).
- Existing graph-walk tests (loops, `maxHops` cap, `[ASK_USER]` pause/resume)
  continue to pass.

## Risks

- A worker may omit or malform the `[NEXT: …]` marker. Mitigated by the
  default→first-edge fallback and by clear prompt instructions.
- Worker self-routing relies on the worker prompt clearly describing the edge
  targets; ambiguous condition labels degrade choice quality (falls back
  gracefully).
