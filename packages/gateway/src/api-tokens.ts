import * as crypto from 'crypto';
import * as path from 'path';
import { codeyHome, readSecureJson, writeSecureJson } from './secure-file';

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

export function defaultTokenFilePath(): string {
  return path.join(codeyHome(), 'api-tokens.json');
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
    // A broken token file must not take the gateway down; it means "no valid
    // tokens", which the auth layer already handles as 401.
    const parsed = readSecureJson<Partial<TokenFile>>(this.filePath, {});
    const tokens = Array.isArray(parsed.tokens) ? parsed.tokens : [];
    return {
      version: typeof parsed.version === 'number' ? parsed.version : STORE_VERSION,
      tokens: tokens.filter((t: unknown): t is StoredToken =>
        !!t && typeof (t as StoredToken).id === 'string' && typeof (t as StoredToken).hash === 'string'),
    };
  }

  private write(): void {
    writeSecureJson(this.filePath, this.file);
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

/**
 * The token from a request, accepting either convention.
 *
 * OpenAI clients send `Authorization: Bearer <key>`; Anthropic clients send
 * `x-api-key: <key>` and no Authorization header at all. Both are looked up in
 * the same store — the header a client happens to use says nothing about which
 * token is valid.
 */
export function tokenFromHeaders(headers: {
  authorization?: string | string[];
  'x-api-key'?: string | string[];
}): string | null {
  const bearer = parseBearer(headers.authorization);
  if (bearer) return bearer;
  const apiKey = Array.isArray(headers['x-api-key']) ? headers['x-api-key'][0] : headers['x-api-key'];
  return apiKey?.trim() || null;
}
