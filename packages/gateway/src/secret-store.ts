import * as path from 'path';
import { codeyHome, readSecureJson, writeSecureJson } from './secure-file';

/**
 * The credentials that used to live inline in `gateway.json`: provider API
 * keys and chat-platform bot tokens.
 *
 * `gateway.json` is the wrong home for a secret. It is world-readable by
 * default, watched, rewritten on every settings change, diffed, copied between
 * machines, pasted into bug reports, and — until the Router API work — served
 * over HTTP to anyone who could reach the port. It also has to stay readable,
 * because everything else in it is ordinary configuration.
 *
 * So the split is by sensitivity, not by feature: non-secret metadata (key
 * name, base URL, purpose; channel enabled/disabled) stays in `gateway.json`,
 * and only the secret string moves here, to a `0600` file next to
 * `api-tokens.json`.
 *
 * Values are stored in plaintext. This is not a vault — it is the same
 * trust model as `~/.ssh/id_rsa` or `~/.aws/credentials`: readable by the user
 * who owns the process, nobody else. Encrypting at rest would need a key,
 * which would need somewhere to live, which is the problem we started with.
 */

const STORE_VERSION = 1;

/** Namespaced so a provider key named "telegram" cannot collide with the bot token. */
export type SecretKey = `apiKey:${string}` | `channel:${string}`;

export function apiKeySecret(name: string): SecretKey { return `apiKey:${name}`; }
export function channelSecret(channel: string): SecretKey { return `channel:${channel}`; }

interface SecretFile {
  version: number;
  secrets: Record<string, string>;
}

export function defaultSecretFilePath(): string {
  return path.join(codeyHome(), 'secrets.json');
}

export class SecretStore {
  private readonly filePath: string;
  private file: SecretFile;

  constructor(filePath: string = defaultSecretFilePath()) {
    this.filePath = filePath;
    this.file = this.read();
  }

  private read(): SecretFile {
    const parsed = readSecureJson<Partial<SecretFile>>(this.filePath, {});
    const raw = parsed.secrets;
    const secrets: Record<string, string> = {};
    if (raw && typeof raw === 'object') {
      for (const [k, v] of Object.entries(raw)) {
        if (typeof v === 'string') secrets[k] = v;
      }
    }
    return { version: typeof parsed.version === 'number' ? parsed.version : STORE_VERSION, secrets };
  }

  get(key: SecretKey): string | undefined {
    return this.file.secrets[key];
  }

  /** Setting an empty value deletes the entry — an empty secret is not a secret. */
  set(key: SecretKey, value: string): void {
    if (!value) {
      this.delete(key);
      return;
    }
    if (this.file.secrets[key] === value) return;
    this.file.secrets[key] = value;
    this.write();
  }

  delete(key: SecretKey): boolean {
    if (!(key in this.file.secrets)) return false;
    delete this.file.secrets[key];
    this.write();
    return true;
  }

  /** Rename in place, preserving the value. Used when an API key entry is renamed. */
  rename(from: SecretKey, to: SecretKey): void {
    const value = this.file.secrets[from];
    if (value === undefined) return;
    delete this.file.secrets[from];
    this.file.secrets[to] = value;
    this.write();
  }

  keys(): SecretKey[] {
    return Object.keys(this.file.secrets) as SecretKey[];
  }

  /**
   * Write several secrets in one go. Used by the migration so importing a
   * config full of inline keys touches the disk once, not once per key.
   */
  setMany(entries: Array<[SecretKey, string]>): void {
    let changed = false;
    for (const [key, value] of entries) {
      if (!value) continue;
      if (this.file.secrets[key] === value) continue;
      this.file.secrets[key] = value;
      changed = true;
    }
    if (changed) this.write();
  }

  private write(): void {
    writeSecureJson(this.filePath, this.file);
  }

  /** Re-read from disk. Another process (the Mac app, the daemon) may have written. */
  reload(): void {
    this.file = this.read();
  }
}
