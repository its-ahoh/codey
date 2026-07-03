import * as fs from 'fs';
import * as path from 'path';

interface LeaseFile { pid: number; role: 'daemon' | 'embedded'; heartbeatAt: number }

export const DEFAULT_STALE_MS = 90_000; // 3 × 30s ticks

/**
 * Single-scheduler lease over a lockfile. Daemon wins over embedded; anyone
 * takes a stale lock. Steal is unlink + exclusive create — a same-host race
 * loses one write and converges next tick, which is acceptable at 30s cadence.
 */
export class SchedulerLease {
  constructor(
    private readonly lockPath: string,
    private readonly role: 'daemon' | 'embedded',
    private readonly staleMs: number = DEFAULT_STALE_MS,
  ) {}

  private read(): LeaseFile | null {
    try {
      const raw = JSON.parse(fs.readFileSync(this.lockPath, 'utf8'));
      if (typeof raw?.pid === 'number' && typeof raw?.heartbeatAt === 'number' && (raw.role === 'daemon' || raw.role === 'embedded')) return raw;
    } catch { /* absent or corrupt */ }
    return null;
  }

  private write(now: number): void {
    fs.mkdirSync(path.dirname(this.lockPath), { recursive: true });
    fs.writeFileSync(this.lockPath, JSON.stringify({ pid: process.pid, role: this.role, heartbeatAt: now }));
  }

  /** True when this process holds the lease after the call. */
  tryAcquire(now: number): boolean {
    const cur = this.read();
    if (cur && cur.pid === process.pid) { this.write(now); return true; }
    const stale = !cur || now - cur.heartbeatAt > this.staleMs;
    const daemonSteal = this.role === 'daemon' && cur?.role === 'embedded';
    if (cur && !stale && !daemonSteal) return false;
    try {
      // Unlink unconditionally: a corrupt lock reads as null but the file
      // still exists and would make the exclusive create below fail forever.
      try { fs.unlinkSync(this.lockPath); } catch { /* already gone */ }
      fs.mkdirSync(path.dirname(this.lockPath), { recursive: true });
      fs.writeFileSync(this.lockPath, JSON.stringify({ pid: process.pid, role: this.role, heartbeatAt: now }), { flag: 'wx' });
      return true;
    } catch {
      return false; // lost the race
    }
  }

  /** Refresh if we still hold it; false = someone else claimed → stand down. */
  heartbeat(now: number): boolean {
    const cur = this.read();
    if (!cur || cur.pid !== process.pid) return false;
    this.write(now);
    return true;
  }

  release(): void {
    const cur = this.read();
    if (cur && cur.pid === process.pid) {
      try { fs.unlinkSync(this.lockPath); } catch { /* already gone */ }
    }
  }
}
