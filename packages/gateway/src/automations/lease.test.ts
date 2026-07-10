import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SchedulerLease } from './lease';

let lock: string;
beforeEach(() => {
  lock = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lease-')), 'scheduler.lock');
});

const STALE = 90_000;
const write = (pid: number, role: 'daemon' | 'embedded', heartbeatAt: number) =>
  fs.writeFileSync(lock, JSON.stringify({ pid, role, heartbeatAt }));

describe('SchedulerLease', () => {
  it('acquires when no lock exists', () => {
    expect(new SchedulerLease(lock, 'embedded', STALE).tryAcquire(1000)).toBe(true);
    expect(JSON.parse(fs.readFileSync(lock, 'utf8')).pid).toBe(process.pid);
  });

  it('embedded does not steal a live daemon lock', () => {
    write(99999, 'daemon', 1000);
    expect(new SchedulerLease(lock, 'embedded', STALE).tryAcquire(2000)).toBe(false);
  });

  it('daemon steals a live embedded lock', () => {
    write(99999, 'embedded', 1000);
    expect(new SchedulerLease(lock, 'daemon', STALE).tryAcquire(2000)).toBe(true);
  });

  it('anyone steals a stale lock', () => {
    write(99999, 'daemon', 1000);
    expect(new SchedulerLease(lock, 'embedded', STALE).tryAcquire(1000 + STALE + 1)).toBe(true);
  });

  it('re-acquire by the same pid refreshes the heartbeat', () => {
    const l = new SchedulerLease(lock, 'daemon', STALE);
    l.tryAcquire(1000);
    expect(l.tryAcquire(5000)).toBe(true);
    expect(JSON.parse(fs.readFileSync(lock, 'utf8')).heartbeatAt).toBe(5000);
  });

  it('heartbeat returns false after another process claims (stand-down)', () => {
    const l = new SchedulerLease(lock, 'embedded', STALE);
    l.tryAcquire(1000);
    write(99999, 'daemon', 2000); // daemon stole it
    expect(l.heartbeat(3000)).toBe(false);
  });

  it('treats a corrupt lock file as absent', () => {
    fs.writeFileSync(lock, 'not json');
    expect(new SchedulerLease(lock, 'embedded', STALE).tryAcquire(1000)).toBe(true);
  });

  it('release removes our lock but not a foreign one', () => {
    const l = new SchedulerLease(lock, 'daemon', STALE);
    l.tryAcquire(1000);
    l.release();
    expect(fs.existsSync(lock)).toBe(false);
    write(99999, 'daemon', 1000);
    l.release();
    expect(fs.existsSync(lock)).toBe(true);
  });
});
