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
