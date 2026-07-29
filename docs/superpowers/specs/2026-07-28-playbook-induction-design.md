# Playbook Induction — Design

Date: 2026-07-28
Status: Implemented behind `skills.induction` (off by default); thresholds unfit

## Problem

No playbook has ever crystallized. Every workspace under
`~/.codey/workspaces/*/skills/` carries a `traces.json` and no `index.json`.

The proximate causes were fixed in PR #194 (traces now carry a `toolSequence`,
the distill prompt shows `Did:` and `Result:`, continuation turns no longer
occupy window slots, automation runs contribute traces, and every distill
verdict is logged). What that PR did **not** change is how recurrence is
decided:

```
distillCandidate(deps, recentTraces, existing, rejected, minRecurrence)
  -> one LLM call: "find a repeatable sub-process appearing in 2+ runs, else NONE"
```

Recurrence is a model's impression of a 7-item list. There is no comparison, no
similarity measure, no clustering. The `steps` it returns are prose the model
composed, not a procedure observed from the run. And because a playbook has no
notion of a parameter, the best a distilled skill can express is one specific
instance of the work.

## The criterion

From the user, and adopted here as the definition:

> If several runs produce similar output through a similar procedure, and the
> only thing that varies is the input, that is a playbook — and the varying
> inputs are its parameters.

This is decidable in code. It moves crystallization from "ask a model to notice
something" to "compute the recurring procedure, then ask a model to name it."

Consequences that follow directly:

- **Procedure is the identity of a playbook.** Two runs with the same tool
  sequence are the same work even when the requests are worded nothing alike.
  This is the case that defeats the current design — the real traces show the
  same social-media outreach procedure requested four different ways.
- **Variance is not noise; it is the parameter list.** What differs across
  members of a cluster is exactly what the playbook should take as input.
- **The LLM's job shrinks** to naming, phrasing, and writing `whenToUse` — the
  tasks it is good at — over a cluster that code has already established.

## What Codey can observe (revised)

The 2026-07-01 design assumed Codey sees only prompt-in / response-out for solo
runs, and that real process was observable only in team runs. That is no longer
true for the default agent:

- **claude-code** emits `tool_start` / `tool_result` events with the tool name
  **and its input object** (`packages/core/src/agents/claude-code.ts:277`).
  The chat surface collects these into `ToolCallEntry[]` and persists them on
  the assistant message; the channel surface gets the same via
  `ContextManager.extractMeta`.
- **opencode** and **codex** emit no tool events at all.

So tool observability is per-adapter, and the design must degrade rather than
assume. See "Degradation" below.

## Decisions

- **Detection moves into code.** Clustering by procedure is deterministic,
  testable, and cheap. The LLM is called once per *confirmed* cluster, not once
  per hopeful window.
- **Store input shapes, never raw values, in `traces.json`.** Crystallizer
  prompts embed user content and deliberately run on a tool-less runner
  (`skill-crystallizer.ts:460`). Raw tool inputs are strictly more sensitive
  than what already flows there.
- **Diff locally, abstract before the prompt.** Slot discovery runs over values
  held in memory during the run; only the resulting template (`«url»`,
  `«topic»`) reaches the model.
- **Suggestion stays opt-in.** Unchanged: detect -> propose -> user confirms.
  A computed cluster is stronger evidence, not a license to auto-save.
- **The existing LLM-only path stays as a fallback**, not as the primary.

## 1. Trace schema v2

`RunTrace.toolSequence: string[]` becomes a structured step list. `traces.json`
goes to `version: 2`; a v1 file loads with `steps: []` on every trace rather
than being migrated (traces roll over within ~20 runs anyway).

```ts
export interface TraceStep {
  /** Tool name, e.g. "browser_navigate", "Edit". */
  tool: string;
  /** Argument shape — keys with abstracted values. Never raw content. */
  args: Record<string, ArgShape>;
}

export type ArgShape =
  | { kind: 'url'; host: string }          // https://x.com/foo -> host only
  | { kind: 'path'; ext: string; depth: number }
  | { kind: 'enum'; value: string }        // short, low-cardinality literals
  | { kind: 'text'; len: number }          // free text: length bucket only
  | { kind: 'number' }
  | { kind: 'bool' }
  | { kind: 'other' };
```

`toolSequence` remains as a derived convenience (`steps.map(s => s.tool)`) so
nothing downstream of #194 breaks.

**Shape extraction** (`shapeOf(value)`) is pure, synchronous, and lives in
core. Rules, in order:

1. String parses as a URL -> `{kind:'url', host}`. Host is retained because
   "always x.com" vs "a different host each time" is exactly the constant-vs-
   slot distinction; the path and query are dropped.
2. String looks like a path -> `{kind:'path', ext, depth}`.
3. String, `len <= 32`, matches `/^[\w.\-\/]+$/` -> `{kind:'enum', value}`.
   Short identifier-ish values are the ones worth comparing literally.
4. Any longer string -> `{kind:'text', len}` with `len` bucketed
   (`<100`, `<1k`, `<10k`, `10k+`) so trivial length differences don't split a
   cluster.
5. Numbers, booleans, everything else -> the trivial shapes.

Objects and arrays are walked one level; deeper structure collapses to
`{kind:'other'}`. Step count per trace stays capped (`TOOL_SEQUENCE_MAX`).

**Raw values** are held only for the duration of the run, passed to induction
(§3) alongside the trace, and dropped. They are never written to
`traces.json` and never placed in a prompt.

## 2. Clustering

Given the trace window (all 20, not the current 7 — clustering is cheap):

**Step 1 — signature.** Each trace becomes its tool-name sequence with
consecutive repeats collapsed (already the #194 behavior).

**Step 2 — pairwise similarity.** LCS ratio over the two sequences:

```
sim(a, b) = 2 * |LCS(a, b)| / (|a| + |b|)
```

LCS rather than set overlap because order carries meaning — "navigate, read,
write" is not "write, read, navigate".

**Step 3 — distinctiveness weighting.** This is what keeps the whole thing from
firing on every coding run. `Read -> Edit -> Bash` is nearly universal and
means nothing; `browser_navigate -> browser_interact -> Write` is a procedure.
Weight each tool by how *rare* it is across the window:

```
rarity(tool) = 1 - tracesContaining(tool) / totalRuns
```

LCS matches are weighted by `rarity`, so a match on ubiquitous tools
contributes almost nothing. Reject a cluster whose mean rarity falls below
`MIN_DISTINCTIVENESS`, and reject signatures shorter than `MIN_PROCEDURE_LEN`
(3 distinct tools) regardless of similarity.

> Revised during implementation. This started as `ln(total / (1 + containing))`
> — textbook idf — which turns out to be unusable at these window sizes: a
> procedure repeated twice in a 4-run window scores 0.29 and reads as "common",
> so the very clusters worth finding were rejected. Plain `1 - frequency` means
> the same thing at every window size and is directly interpretable ("absent
> from at least 40% of runs"). Two related details:
>
> - `totalRuns` counts **every** run considered, including ones that observed
>   no tools. Counting only runs with steps makes a procedure look ubiquitous
>   at exactly the moment it is the only observable thing in the window.
> - Distinctiveness still needs a corpus. Early on, with a handful of traces,
>   real clusters will be withheld for looking too common. That is acceptable
>   while the pass is log-only, and is itself a reason to keep it log-only
>   until the window fills.

**Step 4 — group.** Single-link agglomerative clustering at
`SIMILARITY_THRESHOLD` (start at 0.7, tune against the real `traces.json`).
Take clusters with `>= suggestOnRepeat` members. If several qualify, take the
one with the highest `members * meanIdf`.

Every rejection reason is logged — cluster too small, procedure too short,
`idf` below floor. "Why no playbook?" should be answerable with a number.

## 3. Template induction

For a cluster, align members by step position (members share a signature by
construction, so alignment is positional after collapsing).

For each step, for each argument key, compare the shapes across members:

- **Identical shape and identical value across all members** -> a **constant**,
  baked into the step text: "open x.com".
- **Same shape, differing values** -> a **slot**, named from the argument key;
  collisions get a numeric suffix.
- **Differing kinds** -> not part of the template. Where members disagree on
  the tool called at a position, the step is dropped rather than guessed.

> Sharpened during implementation: **only `url` and `enum` shapes can produce a
> constant.** The other shapes don't retain an identifying value, so "same
> shape" doesn't mean "same value" — two `text` arguments in the same length
> bucket are not the same text, and two paths with the same extension are not
> the same file. Treating those as constants would bake one run's content into
> the playbook. They are always slots.

Output:

```ts
interface InducedTemplate {
  steps: { tool: string; constants: Record<string, string>; slots: string[] }[];
  parameters: { name: string; shape: ArgShape['kind']; examples: string[] }[];
  memberRunIds: string[];
}
```

`examples` holds up to 2 sample values **for the confirmation prompt shown to
the user only** — they never enter an LLM prompt.

## 4. The LLM's remaining job

One call, over an already-established cluster:

```
Here is a procedure observed in N runs:
  1. browser_navigate(host=x.com, url=«target_url»)
  2. browser_read
  3. browser_interact(«comment_text»)
Parameters: target_url (url), comment_text (text)

Name it, describe it in one line, say when to use it, and write the steps as
prose a coding agent can follow. Refer to parameters by their «name».
```

No raw user content, no tool outputs, no prompt text from the runs. The model
returns `{name, description, whenToUse, steps}` as today, so `tryParseDistill`
and the name validation are reused unchanged.

## 5. Parameterized skills

```ts
interface SkillParameter {
  name: string;
  shape: ArgShape['kind'];
  /** Filled from the induced constant when the value never varied. */
  default?: string;
}

interface SkillEntry {
  // ...existing fields
  parameters?: SkillParameter[];
  /** Provenance: the runs the template was induced from. */
  inducedFrom?: string[];
}
```

`applySkill` (`skill-crystallizer.ts:740`) currently prepends free text. With
parameters it must bind them:

1. If the new task text plainly supplies a value (a URL when the slot is a
   `url`), bind it directly — a cheap regex/heuristic pass, no LLM.
2. Otherwise leave the slot as `«name»` in the injected steps and instruct the
   agent to determine it from the task. **Do not** invent a value.
3. Never block a run to ask. Asking the user for slot values is a possible
   later refinement; the failure mode of a wrong auto-bound value is worse than
   an unfilled slot the agent resolves itself.

Rendering stays a banner plus steps, so the surface behavior is unchanged for
skills without parameters.

## 6. Degradation

- **No tool events (opencode, codex):** traces have empty `steps`. Clustering
  finds nothing, logs "no procedure data", and the existing LLM-only
  `distillCandidate` runs as today. Users on those adapters keep current
  behavior; users on claude-code get induction.
- **Mixed adapters in one workspace:** cluster only over traces that have
  steps. A trace with no steps never joins a cluster.
- **Team runs:** `workerSequence` is a procedure at a coarser grain. Treat a
  worker name as a pseudo-tool so team runs cluster on the same machinery.

## 7. Testing

Pure functions, so unit-testable without a gateway:

- `shapeOf` — each rule, plus the bucketing boundaries and one-level walking.
- `signature` / `lcsRatio` — order sensitivity, collapse behavior.
- `idf` weighting — a `Read/Edit/Bash` corpus produces no cluster; a corpus with
  a distinctive repeated sequence does.
- `cluster` — threshold behavior, minimum size, tie-break by `members * meanIdf`.
- `induce` — constant vs slot vs dropped-step, slot naming and collisions.
- Redaction — property test: no raw value from a tool input appears in the
  composed prompt.
- End-to-end on a fixture built from the real `traces.json` shape: the
  social-media runs cluster; the coding runs do not.

## Open questions

1. **Threshold tuning has no ground truth yet.** 0.7 / 3 tools / idf floor are
   guesses. They should be fit against real traces once a few hundred
   accumulate — which argues for shipping trace schema v2 first and letting
   data collect before the clustering lands.
2. **Cross-workspace clustering.** Procedures probably recur across
   workspaces (the same outreach flow in `codey` and `default`), but skills are
   per-workspace state today. Out of scope here; worth revisiting.
3. **How much does `Result:` still matter?** Once procedure drives detection,
   output similarity may add nothing. Keep it in the prompt, but it should not
   enter the clustering math.
4. **Retiring the LLM-only path.** If induction proves out on claude-code, the
   fallback exists solely for adapters without tool events. Whether to invest
   in a heuristic procedure extractor for those adapters is a separate call.

## Sequencing

1. Trace schema v2 + `shapeOf` + logging (no behavior change; starts collecting
   the data everything else needs).
2. Clustering + distinctiveness weighting, behind a config flag, logging what it
   *would* have clustered without proposing anything.
3. Template induction + the reduced LLM call, still flagged.
4. Parameterized `SkillEntry` + binding in `applySkill`.
5. Flip the default once (2) has been observed against real traces.
