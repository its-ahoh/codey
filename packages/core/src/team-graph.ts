export type TeamGraphNodeType = 'start' | 'worker' | 'end';

export interface TeamGraphNode {
  id: string;
  type: TeamGraphNodeType;
  /** Worker name; required when type === 'worker'. */
  worker?: string;
  x: number;
  y: number;
}

export interface TeamGraphEdge {
  id: string;
  from: string;
  to: string;
  /** Natural-language condition the judge evaluates, e.g. "tests pass". */
  condition?: string;
  /** Fallback edge taken when no conditioned edge matches. */
  isDefault?: boolean;
}

export interface TeamGraph {
  entry: string;
  maxHops: number;
  nodes: TeamGraphNode[];
  edges: TeamGraphEdge[];
}

export const DEFAULT_MAX_HOPS = 20;

/**
 * Returns a list of human-readable problems with the graph. Empty array means
 * the graph is runnable. Used by both the gateway (refuse to run, report why)
 * and the Mac editor (surface inline).
 */
export function validateGraph(graph: TeamGraph, knownWorkers: string[]): string[] {
  const problems: string[] = [];
  const known = new Set(knownWorkers.map(w => w.toLowerCase()));
  const nodeById = new Map(graph.nodes.map(n => [n.id, n]));

  if (!nodeById.has(graph.entry)) {
    problems.push(`entry node "${graph.entry}" does not exist`);
  }

  for (const node of graph.nodes) {
    if (node.type === 'worker') {
      if (!node.worker) {
        problems.push(`worker node "${node.id}" is missing a worker`);
      } else if (!known.has(node.worker.toLowerCase())) {
        problems.push(`node "${node.id}" references unknown worker "${node.worker}"`);
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
    if ((node.type === 'worker' || node.type === 'start') && !hasOut) {
      const label = node.type === 'start' ? 'start node' : 'worker node';
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
  /** Node ids visited in order (worker nodes only), for progress/history. */
  visited: string[];
}

function nodeMap(graph: TeamGraph): Map<string, TeamGraphNode> {
  return new Map(graph.nodes.map(n => [n.id, n]));
}

export function outgoingEdges(graph: TeamGraph, nodeId: string): TeamGraphEdge[] {
  return graph.edges.filter(e => e.from === nodeId);
}

/** Follow non-worker nodes (start) forward to the first worker/end node. */
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
  if (node.type === 'end') return { ...state, currentNodeId: cur, status: 'done' };
  return {
    ...state,
    currentNodeId: cur,
    status: 'running',
    visited: [...state.visited, cur],
  };
}

export function startRun(graph: TeamGraph): GraphRunState {
  return settle(graph, graph.entry, { currentNodeId: graph.entry, hops: 0, status: 'running', visited: [] });
}

/**
 * Move from the current node along `edgeId`. Increments the hop counter,
 * enforces maxHops, and settles onto the next worker/end node.
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
  return edges.find(e => e.isDefault) ?? null;
}
