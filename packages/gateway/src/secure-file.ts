import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Read/write primitives for the files that hold credentials.
 *
 * Two rules, applied in one place so both the API token store and the secret
 * store obey them identically:
 *
 * 1. Mode `0600`, re-asserted on every read — a file restored from a backup,
 *    copied between machines or created by an older build must not stay wide.
 * 2. A corrupt file is not fatal. These files gate access; failing closed
 *    ("no credentials") is correct, crashing the gateway is not.
 */

export const SECURE_FILE_MODE = 0o600;

/** Base dir for Codey's own state: CODEY_HOME override, else ~/.codey. */
export function codeyHome(): string {
  return process.env.CODEY_HOME ?? path.join(os.homedir(), '.codey');
}

/**
 * Tighten permissions if something widened them. Best effort: a filesystem
 * without POSIX modes is not a failure.
 */
export function enforceSecureMode(filePath: string): void {
  try {
    const mode = fs.statSync(filePath).mode & 0o777;
    if (mode !== SECURE_FILE_MODE) {
      console.warn(`[secure-file] ${filePath} was mode ${mode.toString(8)}; tightening to 600`);
      fs.chmodSync(filePath, SECURE_FILE_MODE);
    }
  } catch { /* best effort */ }
}

/**
 * Parse a credential file, or return `fallback` when it is missing, unreadable
 * or malformed. Never throws.
 */
export function readSecureJson<T>(filePath: string, fallback: T): T {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    enforceSecureMode(filePath);
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
  } catch (err) {
    console.error(`[secure-file] unreadable ${filePath}: ${(err as Error).message}`);
    return fallback;
  }
}

/** Write a credential file, creating its directory, always at mode 0600. */
export function writeSecureJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  // `mode` applies only when the file is created, so chmod afterwards too:
  // an existing file would otherwise keep its old, possibly wider, mode.
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), { mode: SECURE_FILE_MODE });
  enforceSecureMode(filePath);
}
