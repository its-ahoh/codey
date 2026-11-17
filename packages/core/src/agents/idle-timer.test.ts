import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { idleTimeoutMessage, startIdleTimer } from './idle-timer';

describe('idle timer', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('fires after a full window of silence', () => {
    const onIdle = vi.fn();
    startIdleTimer(1000, onIdle);
    vi.advanceTimersByTime(999);
    expect(onIdle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onIdle).toHaveBeenCalledOnce();
  });

  it('never fires while output keeps arriving, however long the run', () => {
    const onIdle = vi.fn();
    const timer = startIdleTimer(1000, onIdle);
    for (let i = 0; i < 50; i++) {
      vi.advanceTimersByTime(900);
      timer.touch();
    }
    expect(onIdle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(onIdle).toHaveBeenCalledOnce();
  });

  it('does not re-arm when output arrives after it fired', () => {
    const onIdle = vi.fn();
    const timer = startIdleTimer(1000, onIdle);
    vi.advanceTimersByTime(1000);
    timer.touch();
    vi.advanceTimersByTime(5000);
    expect(onIdle).toHaveBeenCalledOnce();
  });

  it('stays quiet once stopped', () => {
    const onIdle = vi.fn();
    const timer = startIdleTimer(1000, onIdle);
    timer.stop();
    timer.touch();
    timer.stop();
    vi.advanceTimersByTime(5000);
    expect(onIdle).not.toHaveBeenCalled();
  });

  it('words the failure the way the gateway recognises', () => {
    expect(idleTimeoutMessage(900_000)).toBe('No output for 15 minutes');
    expect(idleTimeoutMessage(60_000)).toBe('No output for 1 minute');
  });
});
