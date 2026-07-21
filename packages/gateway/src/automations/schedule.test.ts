import { describe, it, expect } from 'vitest';
import { localParts, slotId, shouldFire } from './schedule';
import type { AutomationSchedule } from '@codey/core';

// 2026-07-02T09:00:00 in Asia/Shanghai is 2026-07-02T01:00:00Z
const SH_9AM = Date.UTC(2026, 6, 2, 1, 0, 0);
const sched = (over: Partial<AutomationSchedule> = {}): AutomationSchedule =>
  ({ slots: [{ hour: 9, minute: 0 }], tz: 'Asia/Shanghai', ...over });

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
  it('fires at each time of a multi-time schedule, independently', () => {
    const multi = sched({ slots: [{ hour: 9, minute: 0 }, { hour: 18, minute: 0 }] });
    const SH_6PM = SH_9AM + 9 * 3600_000;
    expect(shouldFire(multi, undefined, SH_9AM)).toBe(true);
    // The 09:00 fire does not consume the 18:00 slot of the same day.
    expect(shouldFire(multi, SH_9AM, SH_6PM)).toBe(true);
    expect(shouldFire(multi, undefined, SH_9AM + 3600_000)).toBe(false);
  });
  it('never back-fires: a missed slot simply does not match', () => {
    // Process restarts at 12:00 having missed the 09:00 slot.
    expect(shouldFire(sched(), undefined, SH_9AM + 3 * 3600_000)).toBe(false);
  });
  it('respects the weekdays linked to each slot', () => {
    // SH_9AM is a Thursday (4)
    expect(shouldFire(sched({ slots: [{ hour: 9, minute: 0, daysOfWeek: [4] }] }), undefined, SH_9AM)).toBe(true);
    expect(shouldFire(sched({ slots: [{ hour: 9, minute: 0, daysOfWeek: [0, 6] }] }), undefined, SH_9AM)).toBe(false);
  });
  it('treats an empty daysOfWeek as daily defensively', () => {
    expect(shouldFire(sched({ slots: [{ hour: 9, minute: 0, daysOfWeek: [] }] }), undefined, SH_9AM)).toBe(true);
  });
  it('does not cross a time onto another slot\'s weekdays', () => {
    const linked = sched({ slots: [
      { hour: 21, minute: 0, daysOfWeek: [1, 2, 3] },
      { hour: 12, minute: 0, daysOfWeek: [4, 5] },
    ] });
    const thursdayNoon = Date.UTC(2026, 6, 2, 4, 0, 0);
    const thursday9pm = Date.UTC(2026, 6, 2, 13, 0, 0);
    expect(shouldFire(linked, undefined, thursdayNoon)).toBe(true);
    expect(shouldFire(linked, undefined, thursday9pm)).toBe(false);
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
