/**
 * Condense a block of worker output to a short preview: the last non-empty
 * paragraph, truncated to `maxChars` with a trailing ellipsis. Used to keep
 * per-step team output compact in chat surfaces. Returns '' for blank input.
 */
export function lastParagraphPreview(output: string, maxChars = 200): string {
  const trimmed = (output ?? '').trim();
  if (!trimmed) return '';
  const paragraphs = trimmed
    .split(/\n\s*\n/)
    .map(p => p.trim())
    .filter(Boolean);
  const last = paragraphs[paragraphs.length - 1] ?? trimmed;
  if (last.length <= maxChars) return last;
  return last.slice(0, maxChars).trimEnd() + '…';
}
