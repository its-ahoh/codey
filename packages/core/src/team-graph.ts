export type TeamGraphNodeType = 'start' | 'bot' | 'condition' | 'end';

export interface TeamGraphNode {
  id: string;
  type: TeamGraphNodeType;
  /** Bot name; required when type === 'bot'. */
  bot?: string;
  /** Decision question the judge evaluates; used when type === 'condition'. */
  condition?: string;
  /** Max consecutive runs of this (self-looping) bot before a forced exit. */
  maxCalls?: number;
  x: number;
  y: number;
  /** Presentation-only: editor card size. Ignored by the runtime. */
  width?: number;
  height?: number;
}

export interface TeamGraphEdge {
  id: string;
  from: string;
  to: string;
  /** Natural-language condition the judge evaluates, e.g. "tests pass". */
  condition?: string;
  /** Fallback edge taken when no conditioned edge matches. */
  isDefault?: boolean;
  /** Outcome of a diamond's decision. Only set on edges leaving a 'condition' node. */
  branch?: 'yes' | 'no';
  /** Presentation-only: React Flow source handle id. Ignored by the runtime. */
  sourceHandle?: string;
  /** Presentation-only: React Flow target handle id. Ignored by the runtime. */
  targetHandle?: string;
}

export interface TeamGraph {
  entry: string;
  maxHops: number;
  nodes: TeamGraphNode[];
  edges: TeamGraphEdge[];
}

export const DEFAULT_MAX_HOPS = 20;
/** Default cap on consecutive self-loops for a bot node that doesn't set maxCalls. */
export const DEFAULT_MAX_SELF_LOOP = 3;

/**
 * Returns a list of human-readable problems with the graph. Empty array means
 * the graph is runnable. Used by both the gateway (refuse to run, report why)
 * and the Mac editor (surface inline).
 */
export function validateGraph(graph: TeamGraph, knownBots: string[]): string[] {
  const problems: string[] = [];
  const known = new Set(knownBots.map(w => w.toLowerCase()));
  const nodeById = new Map(graph.nodes.map(n => [n.id, n]));

  if (!nodeById.has(graph.entry)) {
    problems.push(`entry node "${graph.entry}" does not exist`);
  }

  for (const node of graph.nodes) {
    if (node.type === 'bot') {
      if (!node.bot) {
        problems.push(`bot node "${node.id}" is missing a bot`);
      } else if (!known.has(node.bot.toLowerCase())) {
        problems.push(`node "${node.id}" references unknown bot "${node.bot}"`);
      }
      const outs = graph.edges.filter(e => e.from === node.id);
      if (outs.some(e => e.to === node.id) && !outs.some(e => e.to !== node.id)) {
        problems.push(`bot node "${node.id}" self-loops with no exit edge`);
      }
      if (node.maxCalls !== undefined && (!Number.isInteger(node.maxCalls) || node.maxCalls < 1)) {
        problems.push(`bot node "${node.id}" maxCalls must be >= 1`);
      }
    } else if (node.type === 'condition') {
      if (node.bot) {
        problems.push(`condition node "${node.id}" must not reference a bot`);
      }
      if (!node.condition || !node.condition.trim()) {
        problems.push(`condition node "${node.id}" needs a question`);
      }
      const outs = graph.edges.filter(e => e.from === node.id);
      const yes = outs.filter(e => e.branch === 'yes').length;
      const no = outs.filter(e => e.branch === 'no').length;
      if (outs.length !== 2 || yes !== 1 || no !== 1) {
        problems.push(`condition node "${node.id}" needs exactly one yes and one no outgoing edge`);
      }
    }
  }

  const outgoing = new Map<string, TeamGraphEdge[]>();
  for (const edge of graph.edges) {
    if (!nodeById.has(edge.from)) {
      problems.push(`edge "${edge.id}" comes from missing node "${edge.from}"`);
    }
    if (!nodeById.has(edge.to)) {
      problems.push(`edge "${edge.id}" points to missing node "${edge.to}"`);
    }
    if (!outgoing.has(edge.from)) outgoing.set(edge.from, []);
    outgoing.get(edge.from)!.push(edge);
  }

  for (const node of graph.nodes) {
    const hasOut = (outgoing.get(node.id)?.length ?? 0) > 0;
    if ((node.type === 'bot' || node.type === 'start' || node.type === 'condition') && !hasOut) {
      const label = node.type === 'start' ? 'start node' : node.type === 'condition' ? 'condition node' : 'bot node';
      problems.push(`${label} "${node.id}" has no outgoing edge`);
    }
  }

  // Reachability from entry.
  if (nodeById.has(graph.entry)) {
    const seen = new Set<string>([graph.entry]);
    const stack = [graph.entry];
    while (stack.length) {
      const cur = stack.pop()!;
      for (const edge of outgoing.get(cur) ?? []) {
        if (nodeById.has(edge.to) && !seen.has(edge.to)) {
          seen.add(edge.to);
          stack.push(edge.to);
        }
      }
    }
    for (const node of graph.nodes) {
      if (!seen.has(node.id)) {
        problems.push(`node "${node.id}" is unreachable from entry`);
      }
    }
  }

  return problems;
}

export type GraphRunStatus = 'running' | 'done' | 'capped' | 'stuck';

export interface GraphRunState {
  currentNodeId: string;
  hops: number;
  status: GraphRunStatus;
  /** Node ids visited in order (bot nodes only), for progress/history. */
  visited: string[];
  /** Consecutive runs of currentNodeId; resets when settling onto a different node. */
  runStreak: number;
}

function nodeMap(graph: TeamGraph): Map<string, TeamGraphNode> {
  return new Map(graph.nodes.map(n => [n.id, n]));
}

export function outgoingEdges(graph: TeamGraph, nodeId: string): TeamGraphEdge[] {
  return graph.edges.filter(e => e.from === nodeId);
}

/**
 * Outgoing edges the judge may choose from. Drops a bot's self-edge once its
 * consecutive-run streak has reached the node's maxCalls, forcing an exit.
 * Bot nodes that don't set maxCalls fall back to DEFAULT_MAX_SELF_LOOP.
 */
export function eligibleEdges(graph: TeamGraph, state: GraphRunState, nodeId: string): TeamGraphEdge[] {
  const edges = outgoingEdges(graph, nodeId);
  const node = nodeMap(graph).get(nodeId);
  if (node?.type === 'bot') {
    const cap = node.maxCalls ?? DEFAULT_MAX_SELF_LOOP;
    if (state.runStreak >= cap) {
      return edges.filter(e => e.to !== nodeId);
    }
  }
  return edges;
}

/** Follow non-bot nodes (start) forward to the first bot/end node. */
function settle(graph: TeamGraph, nodeId: string, state: GraphRunState): GraphRunState {
  const nodes = nodeMap(graph);
  let cur = nodeId;
  // start nodes have exactly one meaningful outgoing edge; walk through them.
  while (nodes.get(cur)?.type === 'start') {
    const next = outgoingEdges(graph, cur)[0];
    if (!next) return { ...state, currentNodeId: cur, status: 'stuck' };
    cur = next.to;
  }
  const node = nodes.get(cur);
  if (!node) return { ...state, currentNodeId: cur, status: 'stuck' };
  const runStreak = state.currentNodeId === cur ? state.runStreak : 0;
  if (node.type === 'end') return { ...state, currentNodeId: cur, status: 'done', runStreak };
  if (node.type === 'condition') {
    return { ...state, currentNodeId: cur, status: 'running', runStreak };
  }
  return {
    ...state,
    currentNodeId: cur,
    status: 'running',
    visited: [...state.visited, cur],
    runStreak,
  };
}

export function startRun(graph: TeamGraph): GraphRunState {
  return settle(graph, graph.entry, { currentNodeId: graph.entry, hops: 0, status: 'running', visited: [], runStreak: 0 });
}

/**
 * Move from the current node along `edgeId`. Increments the hop counter,
 * enforces maxHops, and settles onto the next bot/end node.
 */
export function advance(graph: TeamGraph, state: GraphRunState, edgeId: string): GraphRunState {
  const edge = graph.edges.find(e => e.id === edgeId && e.from === state.currentNodeId);
  if (!edge) return { ...state, status: 'stuck' };
  const hops = state.hops + 1;
  const settled = settle(graph, edge.to, { ...state, hops });
  if (settled.status === 'running' && hops >= graph.maxHops) {
    return { ...settled, status: 'capped' };
  }
  return settled;
}

/**
 * Pick the edge to follow given the judge's chosen edge id. Falls back to the
 * default edge when the judge's choice is absent/invalid, then to "stuck".
 */
export function resolveEdge(graph: TeamGraph, nodeId: string, chosenEdgeId: string | null): TeamGraphEdge | null {
  const edges = outgoingEdges(graph, nodeId);
  if (edges.length === 0) return null;
  const chosen = chosenEdgeId ? edges.find(e => e.id === chosenEdgeId) : undefined;
  if (chosen) return chosen;
  const node = nodeMap(graph).get(nodeId);
  if (node?.type === 'condition') {
    return edges.find(e => e.branch === 'no') ?? null;
  }
  return edges.find(e => e.isDefault) ?? null;
}
