/**
 * If `text` is a bare digit `n` and `options[n-1]` exists, return that option.
 * Otherwise return null (caller should pass the original text through unchanged).
 */
export function resolveChoiceDigit(text: string, options: string[]): string | null {
  if (!options || options.length === 0) return null;
  const m = text.match(/^\s*(\d+)\s*$/);
  if (!m) return null;
  const idx = parseInt(m[1], 10) - 1;
  if (idx < 0 || idx >= options.length) return null;
  return options[idx];
}
