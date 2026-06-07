/**
 * Per-team-run shared blackboard.
 *
 * Workers emit single-line markers in their output to contribute structured
 * facts, decisions, handoffs, and open questions. The blackboard collects
 * them across steps, exposes a compact view for prompt injection on the next
 * step, and renders a clean summary for the user when the run completes.
 *
 * Markers are STRIPPED from the visible output — the user sees prose, the
 * structured data lives in the blackboard.
 */

export type MarkerKind = 'fact' | 'decision' | 'handoff' | 'open';

export interface BlackboardEntry {
  worker: string;
  step: number;
  text: string;
}

export interface HandoffEntry extends BlackboardEntry {
  /** Target worker name; null means "for whoever runs next". */
  to: string | null;
}

export interface Marker {
  kind: MarkerKind;
  text: string;
  /** Only set for HANDOFF. */
  to?: string | null;
}

export interface ParseResult {
  markers: Marker[];
  /** Output with marker lines removed and surrounding blank lines collapsed. */
  stripped: string;
}

// Workers often emit markers as list items (`- [DECISION]: …`, `1. [FACT]: …`)
// rather than at the start of the line. Tolerate an optional leading bullet so
// the tag never leaks into the user-visible prose. The required `]: <body>`
// shape excludes real markdown checkboxes like `- [ ]` / `- [x]`.
const MARKER_RE = /^\s*(?:[-*•]\s+|\d+[.)]\s+)?\[(FACT|DECISION|OPEN|HANDOFF(?:\s*:\s*[^\]]+)?)\]\s*:\s*(.+?)\s*$/i;

/**
 * Pull `[FACT]:`, `[DECISION]:`, `[OPEN]:`, `[HANDOFF: name]:` markers out
 * of free-form worker output. Lines that match are removed from the prose.
 */
export function parseMarkers(text: string): ParseResult {
  if (!text) return { markers: [], stripped: text ?? '' };
  const lines = text.split(/\r?\n/);
  const markers: Marker[] = [];
  const kept: string[] = [];

  for (const line of lines) {
    const m = line.match(MARKER_RE);
    if (!m) { kept.push(line); continue; }

    const tagRaw = m[1].trim();
    const body = m[2].trim();
    const tag = tagRaw.split(/\s*:\s*/, 1)[0].toUpperCase();

    if (tag === 'FACT') markers.push({ kind: 'fact', text: body });
    else if (tag === 'DECISION') markers.push({ kind: 'decision', text: body });
    else if (tag === 'OPEN') markers.push({ kind: 'open', text: body });
    else if (tag === 'HANDOFF') {
      // Capture optional target after the colon: `HANDOFF: alice`
      const colonIdx = tagRaw.indexOf(':');
      const to = colonIdx >= 0 ? tagRaw.slice(colonIdx + 1).trim() || null : null;
      markers.push({ kind: 'handoff', to, text: body });
    }
  }

  // Collapse extra blank lines created by stripped markers.
  const stripped = kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return { markers, stripped };
}

export interface BlackboardSnapshot {
  facts: BlackboardEntry[];
  decisions: BlackboardEntry[];
  handoffs: HandoffEntry[];
  open: BlackboardEntry[];
}

export class TeamBlackboard {
  readonly facts: BlackboardEntry[] = [];
  readonly decisions: BlackboardEntry[] = [];
  readonly handoffs: HandoffEntry[] = [];
  readonly open: BlackboardEntry[] = [];

  /** Serialize to a plain JSON-safe object for persistence. */
  toJSON(): BlackboardSnapshot {
    return {
      facts: [...this.facts],
      decisions: [...this.decisions],
      handoffs: [...this.handoffs],
      open: [...this.open],
    };
  }

  /** Rebuild from a previously serialized snapshot. */
  static fromJSON(snap: BlackboardSnapshot | undefined | null): TeamBlackboard {
    const bb = new TeamBlackboard();
    if (!snap) return bb;
    if (Array.isArray(snap.facts)) bb.facts.push(...snap.facts);
    if (Array.isArray(snap.decisions)) bb.decisions.push(...snap.decisions);
    if (Array.isArray(snap.handoffs)) bb.handoffs.push(...snap.handoffs);
    if (Array.isArray(snap.open)) bb.open.push(...snap.open);
    return bb;
  }

  /**
   * Ingest a worker's raw output. Markers are parsed, recorded, and removed
   * from the returned `stripped` text — callers should use `stripped` as the
   * user-visible / next-worker-visible output.
   */
  ingest(worker: string, step: number, output: string): {
    stripped: string;
    added: { facts: number; decisions: number; handoffs: number; open: number };
  } {
    const { markers, stripped } = parseMarkers(output);
    const added = { facts: 0, decisions: 0, handoffs: 0, open: 0 };
    for (const m of markers) {
      if (m.kind === 'fact') { this.facts.push({ worker, step, text: m.text }); added.facts++; }
      else if (m.kind === 'decision') { this.decisions.push({ worker, step, text: m.text }); added.decisions++; }
      else if (m.kind === 'open') { this.open.push({ worker, step, text: m.text }); added.open++; }
      else if (m.kind === 'handoff') {
        this.handoffs.push({ worker, step, text: m.text, to: m.to ?? null });
        added.handoffs++;
      }
    }
    return { stripped, added };
  }

  isEmpty(): boolean {
    return this.facts.length === 0
      && this.decisions.length === 0
      && this.handoffs.length === 0
      && this.open.length === 0;
  }

  /**
   * Total entries across all marker kinds. Used by resume callers to
   * snapshot "everything this session has seen so far" and request only
   * the delta on the next turn.
   */
  totalCount(): number {
    return this.facts.length + this.decisions.length + this.handoffs.length + this.open.length;
  }

  /**
   * Render only the entries appended AFTER `sinceCount` total entries.
   * Each kind is sliced from its current position back to where it was
   * when sinceCount was recorded — see `renderForWorker` for the full
   * render. Returns empty string when nothing is new for this worker.
   *
   * Note: `sinceCount` is the snapshot of `totalCount()` at the previous
   * call, so the slice indices are recomputed from the running totals
   * each kind contributes — order matters: facts → decisions → handoffs
   * → open, matching `totalCount()`.
   */
  renderDeltaForWorker(workerName: string, sinceCount: number): string {
    if (sinceCount >= this.totalCount()) return '';

    // Walk the kinds in the same order totalCount() sums them. For each
    // kind we know how many entries existed at `sinceCount` and how many
    // exist now; the difference is the slice we want.
    let remaining = Math.max(0, sinceCount);
    const sliceTail = <T>(arr: T[]): T[] => {
      const skip = Math.min(remaining, arr.length);
      remaining -= skip;
      return arr.slice(skip);
    };
    const newFacts = sliceTail(this.facts);
    const newDecisions = sliceTail(this.decisions);
    const newHandoffsAll = sliceTail(this.handoffs);
    const newOpen = sliceTail(this.open);

    const newHandoffs = newHandoffsAll.filter(h => h.to === workerName || h.to === null);

    if (newFacts.length === 0 && newDecisions.length === 0 && newHandoffs.length === 0 && newOpen.length === 0) {
      return '';
    }
    const lines: string[] = ['## Blackboard updates since your last turn'];
    if (newFacts.length > 0) {
      lines.push('', '### New facts');
      for (const f of newFacts) lines.push(`- (${f.worker}) ${f.text}`);
    }
    if (newDecisions.length > 0) {
      lines.push('', '### New decisions');
      for (const d of newDecisions) lines.push(`- (${d.worker}) ${d.text}`);
    }
    if (newHandoffs.length > 0) {
      lines.push('', '### New handoffs to you');
      for (const h of newHandoffs) lines.push(`- from ${h.worker}: ${h.text}`);
    }
    if (newOpen.length > 0) {
      lines.push('', '### New open questions');
      for (const o of newOpen) lines.push(`- (${o.worker}) ${o.text}`);
    }
    return lines.join('\n');
  }

  /**
   * Compact markdown block to inject into the NEXT worker's prompt.
   * Handoffs filter to those addressed to this worker (or to anyone).
   */
  renderForWorker(workerName: string): string {
    if (this.isEmpty()) return '';
    const lines: string[] = ['## Team Blackboard (so far)'];

    if (this.facts.length > 0) {
      lines.push('', '### Facts');
      for (const f of this.facts) lines.push(`- (${f.worker}) ${f.text}`);
    }
    if (this.decisions.length > 0) {
      lines.push('', '### Decisions');
      for (const d of this.decisions) lines.push(`- (${d.worker}) ${d.text}`);
    }
    if (this.open.length > 0) {
      lines.push('', '### Open questions');
      for (const o of this.open) lines.push(`- (${o.worker}) ${o.text}`);
    }
    const myHandoffs = this.handoffs.filter(h => h.to === workerName || h.to === null);
    if (myHandoffs.length > 0) {
      lines.push('', '### Handoffs addressed to you');
      for (const h of myHandoffs) lines.push(`- from ${h.worker}: ${h.text}`);
    }
    return lines.join('\n');
  }

  /**
   * Markdown summary appended to the user-visible final response.
   */
  renderForUser(): string {
    if (this.isEmpty()) return '';
    const lines: string[] = ['---', '', '### 🧠 Team blackboard'];
    if (this.decisions.length > 0) {
      lines.push('', '**Decisions:**');
      for (const d of this.decisions) lines.push(`- *${d.worker}* — ${d.text}`);
    }
    if (this.facts.length > 0) {
      lines.push('', '**Facts:**');
      for (const f of this.facts) lines.push(`- *${f.worker}* — ${f.text}`);
    }
    if (this.open.length > 0) {
      lines.push('', '**Open questions:**');
      for (const o of this.open) lines.push(`- *${o.worker}* — ${o.text}`);
    }
    return lines.join('\n');
  }

  /** Short one-liner used as a sink/info ticker after each step. */
  summarizeDelta(added: { facts: number; decisions: number; handoffs: number; open: number }): string {
    const parts: string[] = [];
    if (added.decisions) parts.push(`${added.decisions} decision${added.decisions > 1 ? 's' : ''}`);
    if (added.facts) parts.push(`${added.facts} fact${added.facts > 1 ? 's' : ''}`);
    if (added.handoffs) parts.push(`${added.handoffs} handoff${added.handoffs > 1 ? 's' : ''}`);
    if (added.open) parts.push(`${added.open} open question${added.open > 1 ? 's' : ''}`);
    return parts.length ? `📋 Blackboard +${parts.join(', +')}` : '';
  }
}

/**
 * Prompt fragment that teaches workers about the marker protocol. Kept short
 * so it doesn't dominate the per-step prompt.
 */
export const BLACKBOARD_MARKER_INSTRUCTIONS = [
  '## Team blackboard markers',
  'In addition to your normal output, you may surface structured notes for the rest of the team using single-line markers anywhere in your reply. These lines are EXTRACTED and STRIPPED from the user-visible output, so put them on their own line, exactly:',
  '- `[FACT]: <one line>` — something you discovered that the team should remember',
  '- `[DECISION]: <one line>` — a decision you made, ideally with a "because" clause',
  '- `[HANDOFF: <worker-name>]: <one line>` — a specific note for the next worker (omit `: <worker-name>` for "whoever runs next")',
  '- `[OPEN]: <one line>` — a question or unresolved item the team still needs to address',
  'Use these sparingly — only for items the next worker or a future run should clearly see. Do NOT use markers to communicate with the user; write prose for that.',
].join('\n');
