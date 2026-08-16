// packages/core/src/playbook-induction.ts
//
// Deciding whether runs repeat is a computation, not an impression. This
// module holds the parts that run in plain code, before any LLM is involved:
//
//   shapeOf / stepsFrom  — abstract a run's tool calls into a comparable shape
//   clusterProcedures    — group runs that ran the same procedure
//
// Design note (see docs/superpowers/specs/2026-07-28-playbook-induction-design.md):
// argument VALUES never leave the run. What persists is their shape, which is
// enough to tell a constant from a slot without putting user content into a
// trace file or a prompt.
//
// Deliberately free of imports from skill-crystallizer.ts: the clustering
// entry points take structural types so the dependency runs one way only.

// ── Argument shapes ────────────────────────────────────────────────

export type ArgShape =
  | { kind: 'url'; host: string }
  | { kind: 'path'; ext: string; depth: number }
  | { kind: 'enum'; value: string }
  | { kind: 'text'; len: number }
  | { kind: 'number' }
  | { kind: 'bool' }
  | { kind: 'other' };

export interface TraceStep {
  tool: string;
  args: Record<string, ArgShape>;
}

/** Upper bounds of the length buckets for free text. A run that writes 300
 *  chars and one that writes 500 are the same step; bucketing keeps trivial
 *  differences from splitting a cluster. TEXT_LEN_MAX marks "10k or more". */
export const TEXT_LEN_BUCKETS = [100, 1_000, 10_000];
export const TEXT_LEN_MAX = 100_000;

/** Values at or below this length are compared literally (kind 'enum').
 *  Longer ones are reduced to a length bucket. */
const ENUM_MAX_LEN = 32;
// Glob and brace characters are included deliberately: a search pattern like
// "**/*.test.ts" is an identifying value, and reducing it to a length bucket
// would make two unrelated searches look like the same argument. Observed on a
// real opencode run (glob(pattern: "**/note.txt")).
const ENUM_PATTERN = /^[\w.\-/*?[\]{},]+$/;  // comma: brace expansion, e.g. src/**/{a,b}.ts
const PATH_PATTERN = /^[~.]?\/|^[\w\-./]+\.[a-z]{1,5}$/i;

function bucketLen(len: number): number {
  for (const bucket of TEXT_LEN_BUCKETS) {
    if (len < bucket) return bucket;
  }
  return TEXT_LEN_MAX;
}

/** Abstract one argument value. Pure and synchronous — no value it is given
 *  is retained anywhere. */
export function shapeOf(value: unknown): ArgShape {
  if (typeof value === 'boolean') return { kind: 'bool' };
  if (typeof value === 'number') return { kind: 'number' };
  if (typeof value !== 'string') return { kind: 'other' };

  const text = value.trim();
  if (!text) return { kind: 'text', len: bucketLen(0) };

  // Host is kept because "always the same site" versus "a different site each
  // run" is exactly the constant-versus-slot question. Path and query are not.
  if (/^https?:\/\//i.test(text)) {
    try {
      return { kind: 'url', host: new URL(text).host };
    } catch {
      // Malformed URL — fall through to the string rules.
    }
  }

  if (text.length <= ENUM_MAX_LEN && PATH_PATTERN.test(text) && text.includes('.')) {
    const base = text.slice(text.lastIndexOf('/') + 1);
    const dot = base.lastIndexOf('.');
    return {
      kind: 'path',
      ext: dot > 0 ? base.slice(dot + 1).toLowerCase() : '',
      depth: text.split('/').filter(Boolean).length,
    };
  }

  if (text.length <= ENUM_MAX_LEN && ENUM_PATTERN.test(text)) {
    return { kind: 'enum', value: text };
  }

  return { kind: 'text', len: bucketLen(text.length) };
}

/** True when two shapes are the same kind AND the same value — i.e. this
 *  argument was constant across the runs being compared. Slot discovery is
 *  the inverse: same kind, different value. */
export function sameShape(a: ArgShape, b: ArgShape): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'url' && b.kind === 'url') return a.host === b.host;
  if (a.kind === 'enum' && b.kind === 'enum') return a.value === b.value;
  if (a.kind === 'path' && b.kind === 'path') return a.ext === b.ext && a.depth === b.depth;
  if (a.kind === 'text' && b.kind === 'text') return a.len === b.len;
  return true;
}

/** How many arguments of one tool call are abstracted. A tool with 30
 *  parameters contributes noise, not signal. */
export const MAX_ARGS_PER_STEP = 8;
/** Steps kept per trace. */
export const MAX_STEPS = 12;

/** Build the persisted step list from a run's tool calls.
 *
 *  Accepts both shapes the gateway has on hand — the chat surface's
 *  ToolCallEntry (paired 'tool_start'/'tool_end' records) and the channel
 *  surface's ContextManager ToolCallRecord (one record per call, no `type`).
 *  Only the start half of a pair is counted so calls aren't doubled. */
export function stepsFrom(
  entries: { tool?: string; type?: string; input?: unknown }[] | undefined,
): TraceStep[] {
  if (!entries || entries.length === 0) return [];
  const steps: TraceStep[] = [];
  for (const entry of entries) {
    if (!entry.tool) continue;
    if (entry.type === 'tool_end' || entry.type === 'info') continue;
    // A loop over 20 files is one step in a procedure, not 20.
    if (steps[steps.length - 1]?.tool === entry.tool) continue;

    const args: Record<string, ArgShape> = {};
    const input = entry.input;
    if (input && typeof input === 'object' && !Array.isArray(input)) {
      for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
        if (Object.keys(args).length >= MAX_ARGS_PER_STEP) break;
        args[key] = shapeOf(value);
      }
    }
    steps.push({ tool: entry.tool, args });
    if (steps.length >= MAX_STEPS) break;
  }
  return steps;
}

// ── Clustering ─────────────────────────────────────────────────────

/** A run reduced to what clustering needs. Structural on purpose — callers
 *  pass RunTrace values directly without this module importing that type. */
export interface ProcedureInput {
  runId: string;
  steps?: TraceStep[];
  /** Team runs observe process at a coarser grain; worker names stand in for
   *  tools so both kinds cluster on the same machinery. */
  workerSequence?: string[];
}

export interface ProcedureCluster {
  runIds: string[];
  /** The shared tool sequence, taken from the cluster's longest member. */
  signature: string[];
  /** Mean rarity of the signature's tools, in [0, 1). Low means the procedure
   *  is built from tools that appear in nearly every recent run. */
  distinctiveness: number;
  /** members * distinctiveness — ranks a big cluster of common tools below a
   *  smaller cluster of distinctive ones. */
  score: number;
}

export interface ClusterOptions {
  /** Minimum runs before a procedure counts as recurring. */
  minMembers: number;
  /** Weighted-LCS ratio above which two runs are the same procedure. */
  similarityThreshold?: number;
  /** Distinct tools a procedure needs before it is a procedure at all. */
  minProcedureLen?: number;
  /** Distinctiveness floor. Read -> Edit -> Bash is in nearly every coding run
   *  and must not crystallize into a playbook. */
  minDistinctiveness?: number;
}

// Unfit guesses — no ground truth exists yet. The spec's sequencing runs
// clustering in log-only mode precisely so these can be tuned against real
// traces before anything is proposed to a user.
export const DEFAULT_SIMILARITY_THRESHOLD = 0.7;
export const DEFAULT_MIN_PROCEDURE_LEN = 3;
export const DEFAULT_MIN_DISTINCTIVENESS = 0.4;

/** Tool sequence with consecutive repeats collapsed. */
export function signatureOf(input: ProcedureInput): string[] {
  const names = (input.steps ?? []).map(s => s.tool);
  if (names.length === 0 && input.workerSequence) names.push(...input.workerSequence);
  const collapsed: string[] = [];
  for (const name of names) {
    if (collapsed[collapsed.length - 1] !== name) collapsed.push(name);
  }
  return collapsed;
}

/** Fraction of runs a tool did NOT appear in, in [0, 1).
 *
 *  Plain rarity rather than a log-scaled idf: idf is unstable at the sizes
 *  this operates on (a procedure repeated twice in a 4-run window scores as
 *  "common"), while `1 - frequency` reads the same at every window size and
 *  is directly interpretable — 0.4 means "absent from at least 40% of runs".
 *
 *  `totalRuns` counts every run considered, including ones that observed no
 *  tools at all. A workspace where two runs used the browser and eight did
 *  nothing observable should still see the browser as distinctive. */
export function computeRarity(signatures: string[][], totalRuns: number): Map<string, number> {
  const total = Math.max(totalRuns, signatures.length, 1);
  const containing = new Map<string, number>();
  for (const sig of signatures) {
    for (const tool of new Set(sig)) {
      containing.set(tool, (containing.get(tool) ?? 0) + 1);
    }
  }
  const rarity = new Map<string, number>();
  for (const [tool, count] of containing) {
    rarity.set(tool, 1 - count / total);
  }
  return rarity;
}

function weightOf(tool: string, rarity: Map<string, number>): number {
  // Floor at a small positive value: a tool present in every run should
  // contribute almost nothing, but never zero (which would make a sequence
  // of ubiquitous tools score 0/0 rather than "similar but worthless").
  return Math.max(rarity.get(tool) ?? 0, 0.01);
}

/** Weighted longest-common-subsequence ratio. Subsequence rather than set
 *  overlap because order is part of a procedure: navigate -> read -> write is
 *  not write -> read -> navigate. */
export function similarity(a: string[], b: string[], rarity: Map<string, number>): number {
  if (a.length === 0 || b.length === 0) return 0;
  const table: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      table[i][j] = a[i - 1] === b[j - 1]
        ? table[i - 1][j - 1] + weightOf(a[i - 1], rarity)
        : Math.max(table[i - 1][j], table[i][j - 1]);
    }
  }
  const matched = table[a.length][b.length];
  const totalWeight = a.reduce((sum, t) => sum + weightOf(t, rarity), 0)
    + b.reduce((sum, t) => sum + weightOf(t, rarity), 0);
  return totalWeight === 0 ? 0 : (2 * matched) / totalWeight;
}

/** Why a run or group didn't produce a cluster. Logged so "no playbook yet"
 *  is answerable with a number instead of a shrug. */
export interface ClusterReport {
  clusters: ProcedureCluster[];
  /** How many runs were looked at. `considered === withoutSteps` means the
   *  window holds no procedure data at all — the one case where prose
   *  distillation is the only thing that could find anything. */
  considered: number;
  /** Runs carrying no procedure data at all (adapter emits no tool events). */
  withoutSteps: number;
  /** Runs whose procedure was too short to mean anything. */
  tooShort: number;
  /** Groups that recurred but are built from ubiquitous tools. */
  rejectedByDistinctiveness: number;
  /** Groups that were distinctive enough but haven't recurred yet. */
  tooFewMembers: number;
}

/** True when at least one run in the window left a procedure behind. Distinct
 *  from "clustering found nothing": a window full of observed-but-unclusterable
 *  runs has data, it just did not recur distinctively enough. */
export function hasProcedureData(report: ClusterReport): boolean {
  return report.considered > report.withoutSteps;
}

/** Group runs by the procedure they executed. Pure; no I/O, no LLM. */
export function clusterProcedures(
  inputs: ProcedureInput[],
  opts: ClusterOptions,
): ClusterReport {
  const threshold = opts.similarityThreshold ?? DEFAULT_SIMILARITY_THRESHOLD;
  const minLen = opts.minProcedureLen ?? DEFAULT_MIN_PROCEDURE_LEN;
  const minDistinctiveness = opts.minDistinctiveness ?? DEFAULT_MIN_DISTINCTIVENESS;

  const report: ClusterReport = {
    clusters: [], considered: inputs.length, withoutSteps: 0, tooShort: 0,
    rejectedByDistinctiveness: 0, tooFewMembers: 0,
  };

  const eligible: { runId: string; sig: string[] }[] = [];
  for (const input of inputs) {
    const sig = signatureOf(input);
    if (sig.length === 0) { report.withoutSteps++; continue; }
    if (new Set(sig).size < minLen) { report.tooShort++; continue; }
    eligible.push({ runId: input.runId, sig });
  }
  if (eligible.length < opts.minMembers) return report;

  // Rarity is measured against every run considered, not just the eligible
  // ones: "common" means common in THIS workspace's recent work. Counting only
  // eligible runs would make a procedure look ubiquitous precisely when it is
  // the only observable thing in the window.
  const rarity = computeRarity(eligible.map(e => e.sig), inputs.length);

  // Single-link agglomerative clustering via union-find over the pairs that
  // clear the threshold.
  const parent = eligible.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
    return i;
  };
  const union = (i: number, j: number) => { parent[find(i)] = find(j); };

  for (let i = 0; i < eligible.length; i++) {
    for (let j = i + 1; j < eligible.length; j++) {
      if (similarity(eligible[i].sig, eligible[j].sig, rarity) >= threshold) union(i, j);
    }
  }

  const groups = new Map<number, number[]>();
  for (let i = 0; i < eligible.length; i++) {
    const root = find(i);
    const group = groups.get(root);
    if (group) group.push(i); else groups.set(root, [i]);
  }

  for (const members of groups.values()) {
    // The longest member is the fullest observation of the procedure; shorter
    // members are runs where a step was skipped or the cap truncated.
    const signature = members
      .map(i => eligible[i].sig)
      .reduce((longest, sig) => (sig.length > longest.length ? sig : longest), [] as string[]);
    const tools = [...new Set(signature)];
    const distinctiveness = tools.reduce((sum, t) => sum + weightOf(t, rarity), 0) / tools.length;

    if (members.length < opts.minMembers) {
      if (distinctiveness >= minDistinctiveness) report.tooFewMembers++;
      continue;
    }
    if (distinctiveness < minDistinctiveness) { report.rejectedByDistinctiveness++; continue; }

    report.clusters.push({
      runIds: members.map(i => eligible[i].runId),
      signature,
      distinctiveness,
      score: members.length * distinctiveness,
    });
  }

  report.clusters.sort((a, b) => b.score - a.score);
  return report;
}

// ── Template induction ─────────────────────────────────────────────

export interface InducedStep {
  tool: string;
  /** Arguments that held the same identifying value in every member. */
  constants: Record<string, string>;
  /** Arguments that varied — the playbook's inputs. Names index into
   *  InducedTemplate.parameters. */
  slots: string[];
}

export interface TemplateParameter {
  name: string;
  kind: ArgShape['kind'];
  /** Extension seen for path parameters — "a .ts file" is a better prompt than
   *  "a path". Absent for other kinds. */
  ext?: string;
}

export interface InducedTemplate {
  steps: InducedStep[];
  parameters: TemplateParameter[];
  memberRunIds: string[];
}

/** Only two shapes retain a value identifying enough to call an argument
 *  constant. Two `text` arguments in the same length bucket are NOT the same
 *  text, and two paths with the same extension are not the same file — those
 *  are slots, however similar their shapes look. */
function constantValue(shape: ArgShape): string | null {
  if (shape.kind === 'url') return shape.host;
  if (shape.kind === 'enum') return shape.value;
  return null;
}

/** Collapsed step list, matching what signatureOf produces. */
function collapsedSteps(input: ProcedureInput): TraceStep[] {
  const steps: TraceStep[] = [];
  for (const step of input.steps ?? []) {
    if (steps[steps.length - 1]?.tool === step.tool) continue;
    steps.push(step);
  }
  return steps;
}

/** Turn a cluster into a procedure with holes.
 *
 *  Runs over the persisted SHAPES, not raw values — `sameShape` already
 *  encodes the distinction the diff needs, so induction never requires the
 *  values to have been stored.
 *
 *  Positional alignment: a step is induced only where every member called the
 *  same tool at that index. A member that diverges mid-procedure contributes
 *  its agreeing prefix and suffix positions, never a guess. */
export function induceTemplate(members: ProcedureInput[]): InducedTemplate | null {
  if (members.length < 2) return null;
  const stepLists = members.map(collapsedSteps);
  const length = Math.min(...stepLists.map(s => s.length));
  if (length === 0) return null;

  const steps: InducedStep[] = [];
  const parameters: TemplateParameter[] = [];
  const takenNames = new Set<string>();

  for (let i = 0; i < length; i++) {
    const tool = stepLists[0][i].tool;
    if (!stepLists.every(list => list[i].tool === tool)) continue;

    const constants: Record<string, string> = {};
    const slots: string[] = [];
    // Only arguments every member supplied can be reasoned about.
    const keys = Object.keys(stepLists[0][i].args)
      .filter(key => stepLists.every(list => list[i].args[key] !== undefined));

    for (const key of keys) {
      const shapes = stepLists.map(list => list[i].args[key]);
      const first = shapes[0];
      if (!shapes.every(shape => shape.kind === first.kind)) continue; // disagreeing kinds: not part of the template

      const constant = constantValue(first);
      if (constant !== null && shapes.every(shape => sameShape(shape, first))) {
        constants[key] = constant;
        continue;
      }

      let name = key;
      let suffix = 2;
      while (takenNames.has(name)) name = `${key}_${suffix++}`;
      takenNames.add(name);
      slots.push(name);
      parameters.push({
        name,
        kind: first.kind,
        ...(first.kind === 'path' ? { ext: first.ext } : {}),
      });
    }

    steps.push({ tool, constants, slots });
  }

  if (steps.length === 0) return null;
  return { steps, parameters, memberRunIds: members.map(m => m.runId) };
}

/** Render a template for a prompt or a confirmation. Contains only tool names,
 *  argument keys, constants (hosts and short literals), and slot names — never
 *  user content. */
export function renderTemplate(template: InducedTemplate): string {
  return template.steps.map((step, i) => {
    const args = [
      ...Object.entries(step.constants).map(([key, value]) => `${key}=${value}`),
      ...step.slots.map(slot => `${slot}=«${slot}»`),
    ];
    return `${i + 1}. ${step.tool}${args.length ? `(${args.join(', ')})` : ''}`;
  }).join('\n');
}
