import { describe, it, expect } from 'vitest';
import { localParts, slotId, shouldFire } from './schedule';
import type { AutomationSchedule } from '@codey/core';

// 2026-07-02T09:00:00 in Asia/Shanghai is 2026-07-02T01:00:00Z
const SH_9AM = Date.UTC(2026, 6, 2, 1, 0, 0);
const sched = (over: Partial<AutomationSchedule> = {}): AutomationSchedule =>
  ({ hour: 9, minute: 0, tz: 'Asia/Shanghai', ...over });

describe('localParts', () => {
  it('converts an instant into tz-local wall-clock parts', () => {
    const p = localParts(SH_9AM, 'Asia/Shanghai');
    expect(p).toMatchObject({ hour: 9, minute: 0, dayOfWeek: 4 }); // Thursday
  });
  it('handles midnight as hour 0, not 24', () => {
    const p = localParts(Date.UTC(2026, 6, 1, 16, 0, 0), 'Asia/Shanghai'); // 2026-07-02 00:00 SH
    expect(p.hour).toBe(0);
  });
});

describe('shouldFire', () => {
  it('fires when local hour:minute matches and no prior fire', () => {
    expect(shouldFire(sched(), undefined, SH_9AM)).toBe(true);
  });
  it('does not fire off-slot', () => {
    expect(shouldFire(sched(), undefined, SH_9AM + 60_000)).toBe(false);
  });
  it('does not double-fire within the same minute slot', () => {
    expect(shouldFire(sched(), SH_9AM, SH_9AM + 30_000)).toBe(false);
  });
  it('fires again the next day', () => {
    expect(shouldFire(sched(), SH_9AM, SH_9AM + 24 * 3600_000)).toBe(true);
  });
  it('never back-fires: a missed slot simply does not match', () => {
    // Process restarts at 12:00 having missed the 09:00 slot.
    expect(shouldFire(sched(), undefined, SH_9AM + 3 * 3600_000)).toBe(false);
  });
  it('respects daysOfWeek', () => {
    // SH_9AM is a Thursday (4)
    expect(shouldFire(sched({ daysOfWeek: [4] }), undefined, SH_9AM)).toBe(true);
    expect(shouldFire(sched({ daysOfWeek: [0, 6] }), undefined, SH_9AM)).toBe(false);
  });
  it('evaluates in the schedule tz, not UTC (DST-safe)', () => {
    // 09:00 NY on 2026-11-01 (fall back day) is 14:00Z.
    const nyFallBack9am = Date.UTC(2026, 10, 1, 14, 0, 0);
    expect(shouldFire(sched({ tz: 'America/New_York' }), undefined, nyFallBack9am)).toBe(true);
  });
});

describe('slotId', () => {
  it('is stable within a minute and distinct across minutes', () => {
    expect(slotId(SH_9AM, 'Asia/Shanghai')).toBe(slotId(SH_9AM + 59_000, 'Asia/Shanghai'));
    expect(slotId(SH_9AM, 'Asia/Shanghai')).not.toBe(slotId(SH_9AM + 60_000, 'Asia/Shanghai'));
  });
});
