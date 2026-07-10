import type { Automation, AutomationRun } from '@codey/core';

const PREVIEW = 400;

/** Human-readable one-message summary for channel posts / notifications. */
export function formatRunSummary(a: Automation, run: AutomationRun): string {
  const head =
    run.status === 'success' ? `✅ Automation "${a.name}" succeeded` :
    run.status === 'parked' ? `⏸ Automation "${a.name}" is parked on a question` :
    run.status === 'resumed' ? `✅ Automation "${a.name}" resumed and finished` :
    `❌ Automation "${a.name}" failed`;
  // Parked options are intentionally not embedded here — the engine/notification
  // layer carries run.options separately.
  const body =
    run.status === 'parked' ? (run.question ?? '') :
    run.status === 'failed' ? (run.error ?? '') :
    (run.output ?? '');
  const trimmed = body.trim();
  const cut = trimmed.slice(0, PREVIEW - 1);
  // Don't split a surrogate pair at the truncation boundary (astral emoji → "�").
  const safe = /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
  const preview = trimmed.length > PREVIEW ? `${safe}…` : trimmed;
  return preview ? `${head}\n\n${preview}` : head;
}
