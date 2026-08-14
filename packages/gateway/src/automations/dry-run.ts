// packages/gateway/src/automations/dry-run.ts
import { buildDryRunPrompt } from '@codey/core';
import type { AutomationDraft, AutomationTarget, DryRunVerdict } from '@codey/core';

export interface DryRunDeps {
  /** One-shot no-act prompt execution in a workspace (agent-adapter path). */
  execute: (target: AutomationTarget, prompt: string) => Promise<string>;
  /** Aide classification of the agent's dry-run report. */
  classify: (output: string) => Promise<DryRunVerdict>;
  /** Team definitions to inline for team targets (undefined = none found). */
  teamContext: (workspaceName: string, teamName: string) => string | undefined;
  /** Delivered once per surviving run; superseded/cancelled runs are silent. */
  onResult: (automationId: string, verdict: DryRunVerdict) => void;
  log?: (msg: string) => void;
}

/**
 * Fire-and-forget dry-runs keyed by automation id. At most one verdict is
 * delivered per automation generation: a newer start() or a cancel() makes any
 * in-flight run's result be dropped on arrival (the underlying agent process is
 * not killed - the adapter's own timeout bounds it). Runs are advisory and
 * start only after the automation is already persisted.
 */
export class DryRunManager {
  private generations = new Map<string, number>();
  /** Monotonic, never reset - a gen freed by cancel()/delivery is never
   *  reissued, so a surviving stale run can never match a newer start(). */
  private nextGen = 1;

  constructor(private deps: DryRunDeps) {}

  start(automationId: string, draft: AutomationDraft): void {
    const gen = this.nextGen++;
    this.generations.set(automationId, gen);
    void this.run(automationId, gen, draft);
  }

  /** Drop any in-flight run's result (superseded edit, or deleted automation). */
  cancel(automationId: string): void {
    this.generations.delete(automationId);
  }

  private async run(automationId: string, gen: number, draft: AutomationDraft): Promise<void> {
    let verdict: DryRunVerdict;
    try {
      if (!draft.target || !draft.brief) throw new Error('Draft is missing target or brief');
      const team = draft.target.kind === 'team'
        ? this.deps.teamContext(draft.target.workspaceName, draft.target.teamName)
        : undefined;
      const prompt = buildDryRunPrompt(draft.brief, draft.params ?? {}, team);
      const output = await this.deps.execute(draft.target, prompt);
      verdict = await this.deps.classify(output);
    } catch (err) {
      verdict = { status: 'error', message: (err as Error).message };
    }
    if (this.generations.get(automationId) !== gen) {
      this.deps.log?.(`dry-run for ${automationId} superseded; verdict dropped`);
      return;
    }
    this.generations.delete(automationId);
    try { this.deps.onResult(automationId, verdict); }
    catch (err) { this.deps.log?.(`dry-run onResult failed: ${(err as Error).message}`); }
  }
}
