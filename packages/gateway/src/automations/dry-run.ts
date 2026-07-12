// packages/gateway/src/automations/dry-run.ts
import { buildDryRunPrompt } from '@codey/core';
import type { AutomationDraft, DryRunVerdict } from '@codey/core';

export interface DryRunDeps {
  /** One-shot no-act prompt execution in a workspace (agent-adapter path). */
  execute: (workspaceName: string, prompt: string) => Promise<string>;
  /** Aide classification of the agent's dry-run report. */
  classify: (output: string) => Promise<DryRunVerdict>;
  /** Team definitions to inline for team targets (undefined = none found). */
  teamContext: (workspaceName: string, teamName: string) => string | undefined;
  /** Delivered once per surviving run; superseded/cancelled runs are silent. */
  onResult: (sessionId: string, verdict: DryRunVerdict) => void;
  log?: (msg: string) => void;
}

/**
 * Fire-and-forget dry-runs keyed by authoring-chat session. At most one
 * verdict is delivered per session generation: a newer start() or a cancel()
 * makes any in-flight run's result be dropped on arrival (the underlying
 * agent process is not killed - the adapter's own timeout bounds it).
 */
export class DryRunManager {
  private generations = new Map<string, number>();

  constructor(private deps: DryRunDeps) {}

  start(sessionId: string, draft: AutomationDraft): void {
    const gen = (this.generations.get(sessionId) ?? 0) + 1;
    this.generations.set(sessionId, gen);
    void this.run(sessionId, gen, draft);
  }

  /** Drop any in-flight run's result (authoring UI closed / session over). */
  cancel(sessionId: string): void {
    this.generations.delete(sessionId);
  }

  private async run(sessionId: string, gen: number, draft: AutomationDraft): Promise<void> {
    let verdict: DryRunVerdict;
    try {
      if (!draft.target || !draft.brief) throw new Error('Draft is missing target or brief');
      const team = draft.target.kind === 'team'
        ? this.deps.teamContext(draft.target.workspaceName, draft.target.teamName)
        : undefined;
      const prompt = buildDryRunPrompt(draft.brief, draft.params ?? {}, team);
      const output = await this.deps.execute(draft.target.workspaceName, prompt);
      verdict = await this.deps.classify(output);
    } catch (err) {
      verdict = { status: 'error', message: (err as Error).message };
    }
    if (this.generations.get(sessionId) !== gen) {
      this.deps.log?.(`dry-run for ${sessionId} superseded; verdict dropped`);
      return;
    }
    this.generations.delete(sessionId);
    this.deps.onResult(sessionId, verdict);
  }
}
