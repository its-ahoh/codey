// packages/core/src/agents/idle-timer.ts
//
// The turn limit every adapter shares. It measures silence, not total run
// time: each chunk the CLI writes pushes the deadline back, so a long task
// that keeps reporting is never cut off, while a CLI that has gone quiet for
// the whole window is treated as hung.

/** Silence allowed before a turn is treated as hung (15 minutes). */
export const DEFAULT_IDLE_TIMEOUT_MS = 900_000;

export interface IdleTimer {
  /** The CLI showed signs of life; start the silence window over. */
  touch(): void;
  /** Stop watching. Safe to call more than once. */
  stop(): void;
}

/** Call `onIdle` once after `ms` of uninterrupted silence. `touch()` after the
 *  timer fired or was stopped does nothing, so late output from a process that
 *  is already being terminated cannot re-arm it. */
export function startIdleTimer(ms: number, onIdle: () => void): IdleTimer {
  let done = false;
  const timer = setTimeout(() => {
    done = true;
    onIdle();
  }, ms);
  return {
    touch() {
      if (!done) timer.refresh();
    },
    stop() {
      done = true;
      clearTimeout(timer);
    },
  };
}

/** The failure text for an idle stop. The gateway recognises this exact shape
 *  (`isOwnTimeoutFailure`) to tell Codey's own limit from a network timeout. */
export function idleTimeoutMessage(ms: number): string {
  const minutes = Math.round(ms / 60000);
  return `No output for ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
}
