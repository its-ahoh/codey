/** Run `fn` with a hard timeout and an optional parent abort signal. The
 *  child signal aborts on timeout or parent abort, and the timer + listener
 *  are always cleaned up in `finally`. */
export async function runWithTimeout<T>(
  timeoutMs: number,
  signal: AbortSignal | undefined,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const ac = new AbortController();
  const onAbort = () => ac.abort();
  if (signal) {
    if (signal.aborted) ac.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await fn(ac.signal);
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}
