/**
 * Format a byte count into a human-readable string (KB, MB, GB, etc.).
 * Uses base-1024 (binary) units.
 */
export function formatBytes(bytes: number, decimals = 2): string {
  if (bytes < 0) return `-${formatBytes(-bytes, decimals)}`;
  if (bytes === 0) return '0 B';

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const k = 1024;
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), units.length - 1);
  const value = bytes / Math.pow(k, i);

  return `${parseFloat(value.toFixed(decimals))} ${units[i]}`;
}

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
