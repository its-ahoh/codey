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
