import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Bearer tokens for the Router API.
 *
 * The plaintext token exists exactly once — at creation, when it is printed to
 * the operator. On disk we keep only `sha256(token)`, so a leaked
 * `api-tokens.json` (committed by accident, copied into a log, read through the
 * `/config` endpoint) yields nothing usable.
 *
 * A slow hash (bcrypt/argon2) is deliberately NOT used: those defend low-entropy
 * human passwords against offline brute force. These tokens are 256 bits of
 * `crypto.randomBytes`, so there is nothing to brute-force and a slow hash would
 * only tax every request.
 *
 * The file lives outside `gateway.json` so that config — which is dumped to
 * disk, watched, diffed and served over HTTP — never carries a credential.
 */

export const TOKEN_PREFIX = 'codey_';
const FILE_MODE = 0o600;
const STORE_VERSION = 1;

/** A token as persisted. `hash` never leaves this module. */
interface StoredToken {
  id: string;
  name: string;
  hash: string;
  createdAt: number;
  lastUsedAt?: number;
}

/** A token as shown to the operator — same fields minus the secret material. */
export type ApiTokenRecord = Omit<StoredToken, 'hash'>;

interface TokenFile {
  version: number;
  tokens: StoredToken[];
}

/** Base dir mirrors workspace.ts / gateway.ts: CODEY_HOME override, else ~/.codey. */
export function defaultTokenFilePath(): string {
  const home = process.env.CODEY_HOME ?? path.join(os.homedir(), '.codey');
  return path.join(home, 'api-tokens.json');
}

function sha256(input: string): string {
  return crypto.createHash('sha256').update(input, 'utf-8').digest('hex');
}

/**
 * Constant-time compare of two hex digests. Both sides are fixed-length sha256
 * output, so a length mismatch can only mean a malformed store — treat it as a
 * non-match rather than letting timingSafeEqual throw.
 */
function hashesEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a, 'utf-8'), Buffer.from(b, 'utf-8'));
}

export class ApiTokenStore {
  private readonly filePath: string;
  private file: TokenFile;

  constructor(filePath: string = defaultTokenFilePath()) {
    this.filePath = filePath;
    this.file = this.read();
  }

  private read(): TokenFile {
    try {
      if (!fs.existsSync(this.filePath)) return { version: STORE_VERSION, tokens: [] };
      // The file may have been created by an older build, restored from a
      // backup, or copied around — re-assert 0600 on every read rather than
      // trusting whatever mode it arrived with.
      this.enforceMode();
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
      const tokens = Array.isArray(parsed?.tokens) ? parsed.tokens : [];
      return {
        version: typeof parsed?.version === 'number' ? parsed.version : STORE_VERSION,
        tokens: tokens.filter((t: unknown): t is StoredToken =>
          !!t && typeof (t as StoredToken).id === 'string' && typeof (t as StoredToken).hash === 'string'),
      };
    } catch (err) {
      // A broken token file must not take the gateway down; it means "no valid
      // tokens", which the auth layer already handles as 401.
      console.error(`[api-tokens] unreadable ${this.filePath}: ${(err as Error).message}`);
      return { version: STORE_VERSION, tokens: [] };
    }
  }

  private enforceMode(): void {
    try {
      const mode = fs.statSync(this.filePath).mode & 0o777;
      if (mode !== FILE_MODE) {
        console.warn(`[api-tokens] ${this.filePath} was mode ${mode.toString(8)}; tightening to 600`);
        fs.chmodSync(this.filePath, FILE_MODE);
      }
    } catch { /* best effort — a filesystem without POSIX modes is not a failure */ }
  }

  private write(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    // `mode` only applies when the file is created, so chmod afterwards too:
    // an existing file keeps its old (possibly wider) mode otherwise.
    fs.writeFileSync(this.filePath, JSON.stringify(this.file, null, 2), { mode: FILE_MODE });
    this.enforceMode();
  }

  /**
   * Mint a token. The returned plaintext is the only copy that will ever
   * exist — the caller must show it to the operator and then drop it.
   */
  create(name: string): { token: string; record: ApiTokenRecord } {
    const secret = crypto.randomBytes(32).toString('base64url');
    const token = `${TOKEN_PREFIX}${secret}`;
    const hash = sha256(token);
    const stored: StoredToken = {
      // Derived from the hash, not the token: an id is displayed freely, so it
      // must not be a prefix of the secret.
      id: `tok_${hash.slice(0, 8)}`,
      name,
      hash,
      createdAt: Date.now(),
    };
    this.file.tokens.push(stored);
    this.write();
    return { token, record: redact(stored) };
  }

  list(): ApiTokenRecord[] {
    return this.file.tokens.map(redact);
  }

  isEmpty(): boolean {
    return this.file.tokens.length === 0 && !process.env.CODEY_API_TOKEN;
  }

  revoke(id: string): boolean {
    const before = this.file.tokens.length;
    this.file.tokens = this.file.tokens.filter(t => t.id !== id);
    if (this.file.tokens.length === before) return false;
    this.write();
    return true;
  }

  /**
   * Returns the matching record, or null. `CODEY_API_TOKEN` is honoured as an
   * additional valid token so containers and CI can inject one without a
   * writable home directory; it reports as the synthetic id `env`.
   */
  verify(presented: string | undefined | null): ApiTokenRecord | null {
    if (!presented) return null;
    const presentedHash = sha256(presented);

    const envToken = process.env.CODEY_API_TOKEN;
    if (envToken && hashesEqual(presentedHash, sha256(envToken))) {
      return { id: 'env', name: 'CODEY_API_TOKEN', createdAt: 0 };
    }

    // Compare against every entry rather than returning early, so the work done
    // does not depend on which token was presented.
    let matched: StoredToken | undefined;
    for (const t of this.file.tokens) {
      if (hashesEqual(presentedHash, t.hash)) matched = t;
    }
    if (!matched) return null;

    matched.lastUsedAt = Date.now();
    try { this.write(); } catch { /* a read-only home must not break auth */ }
    return redact(matched);
  }

  /** Re-read from disk. Used after the CLI mints a token in another process. */
  reload(): void {
    this.file = this.read();
  }
}

function redact(t: StoredToken): ApiTokenRecord {
  const { hash: _hash, ...rest } = t;
  return rest;
}

/** Pulls the bearer token out of an Authorization header. */
export function parseBearer(header: string | string[] | undefined): string | null {
  const raw = Array.isArray(header) ? header[0] : header;
  if (!raw) return null;
  const match = /^Bearer\s+(.+)$/i.exec(raw.trim());
  return match ? match[1].trim() : null;
}
