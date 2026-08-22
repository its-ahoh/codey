import * as http from 'http';
import { ConfigManager, stripSecrets } from './config';
import { ApiTokenStore, parseBearer } from './api-tokens';
import { VoiceConverseEvent } from '@codey/core';

/**
 * Endpoints that require a bearer token.
 *
 * `/config` serves the whole gateway configuration and used to be readable,
 * and writable, by anyone who could reach the port. It is now behind a token
 * AND has its secrets redacted — the credentials themselves live in the 0600
 * secret store and are never served. `/health`, `/metrics` and `/ready` stay
 * open: they are what process supervisors poll, and expose only counters.
 *
 * `/voice/*` is not listed because it has its own guard (no-Origin native
 * clients only) and is called by the Swift helper, which has no way to hold a
 * token yet.
 *
 * `/v1/*` is reserved for the Router API, which currently lives on the
 * `router-api` branch rather than here. The prefix stays behind the token so
 * that nothing under it can ever be reachable unauthenticated — today those
 * paths authenticate and then 404.
 */
function requiresAuth(url: string | undefined): boolean {
  if (!url) return false;
  return url === '/config' || url.startsWith('/v1/');
}

export type HealthStatusType = 'healthy' | 'degraded' | 'down';

export interface HealthStatus {
  status: HealthStatusType;
  uptime: number;
  timestamp: string;
  channels: {
    telegram: boolean;
    discord: boolean;
    imessage: boolean;
  };
  stats: {
    messagesProcessed: number;
    activeConversations: number;
    errors: number;
  };
}

export class ApiServer {
  private server?: http.Server;
  private port: number;
  private getStatus: () => HealthStatus;
  private configManager: ConfigManager;
  private _voiceStatus: string = 'idle';
  private runVoiceConverse?: (
    transcript: string,
    conversationId: string | undefined,
    emit: (event: VoiceConverseEvent) => void,
  ) => Promise<void>;
  private runVoiceSpeak?: (
    text: string,
    emit: (event: VoiceConverseEvent) => void,
    conversationId?: string,
    verbatim?: boolean,
  ) => Promise<void>;
  private onConverseHotkey?: () => void;
  private onOpenSettings?: () => void;
  private tokens: ApiTokenStore;

  constructor(
    port: number,
    getStatus: () => HealthStatus,
    configManager: ConfigManager,
    runVoiceConverse?: (
      transcript: string,
      conversationId: string | undefined,
      emit: (event: VoiceConverseEvent) => void,
    ) => Promise<void>,
    runVoiceSpeak?: (
      text: string,
      emit: (event: VoiceConverseEvent) => void,
      conversationId?: string,
      verbatim?: boolean,
    ) => Promise<void>,
    onConverseHotkey?: () => void,
    onOpenSettings?: () => void,
    tokens?: ApiTokenStore,
  ) {
    this.port = port;
    this.getStatus = getStatus;
    this.configManager = configManager;
    this.runVoiceConverse = runVoiceConverse;
    this.runVoiceSpeak = runVoiceSpeak;
    this.onConverseHotkey = onConverseHotkey;
    this.onOpenSettings = onOpenSettings;
    this.tokens = tokens ?? new ApiTokenStore();
  }

  /**
   * Authorize a request, writing the error response itself when it fails.
   * Returns false when the caller should stop handling the request.
   */
  private authorize(req: http.IncomingMessage, res: http.ServerResponse): boolean {
    // Re-read the store per request: `api-token create` runs in a separate
    // process, so a long-lived gateway would otherwise reject tokens minted
    // after it booted until restarted.
    this.tokens.reload();
    if (this.tokens.verify(parseBearer(req.headers.authorization))) return true;
    res.writeHead(401, { 'Content-Type': 'application/json', 'WWW-Authenticate': 'Bearer' });
    res.end(JSON.stringify({
      error: 'Unauthorized',
      hint: 'Send Authorization: Bearer <token>. Create one with: npm run api-token -- create <name>',
    }));
    return false;
  }

  async start(): Promise<void> {
    this.server = http.createServer(async (req, res) => {
      // CORS: reflect only configured origins. The former blanket `*` let any
      // web page the user had open read `/config` — including every API key in
      // it — straight out of the browser.
      const origin = req.headers.origin;
      const allowedOrigins = this.configManager.getApiAllowedOrigins();
      if (origin && allowedOrigins.includes(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      }

      if (req.method === 'OPTIONS') {
        res.writeHead(origin && !allowedOrigins.includes(origin) ? 403 : 200);
        res.end();
        return;
      }

      const url = req.url?.split('?')[0];

      // A browser-origin request to a protected endpoint is refused outright,
      // regardless of the token: a page that can reach this port is not a
      // client we have any reason to serve.
      if (requiresAuth(url) && origin && !allowedOrigins.includes(origin)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Origin not allowed' }));
        return;
      }

      if (requiresAuth(url) && !this.authorize(req, res)) return;

      if (url === '/health' || url === '/') {
        const status = this.getStatus();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(status, null, 2));
        return;
      }

      if (url === '/metrics') {
        const status = this.getStatus();
        const metrics = {
          uptime_seconds: status.uptime,
          messages_total: status.stats.messagesProcessed,
          errors_total: status.stats.errors,
          active_conversations: status.stats.activeConversations,
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(metrics, null, 2));
        return;
      }

      if (url === '/ready') {
        const status = this.getStatus();
        const ready = status.status !== 'down';
        res.writeHead(ready ? 200 : 503);
        res.end(JSON.stringify({ ready }));
        return;
      }

      // ── Voice endpoints ───────────────────────────────────────────

      // CORS: block browser-origin requests to /voice/* (native clients send no Origin)
      if (url?.startsWith('/voice/') && req.headers.origin) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Browser requests to voice endpoints are not allowed' }));
        return;
      }

      if (url?.startsWith('/voice/') && process.platform !== 'darwin') {
        res.writeHead(501, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Voice input is only supported on macOS' }));
        return;
      }

      if (url === '/voice/status' && req.method === 'GET') {
        const voice = this.configManager.get().voice;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          configured: !!voice,
          enabled: (voice?.dictationEnabled ?? voice?.enabled ?? false)
            || (voice?.conversationEnabled ?? voice?.enabled ?? false),
          dictationEnabled: voice?.dictationEnabled ?? voice?.enabled ?? false,
          conversationEnabled: voice?.conversationEnabled ?? voice?.enabled ?? false,
          state: this._voiceStatus ?? null,
        }));
        return;
      }

      if (url === '/voice/status' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
          try {
            const { status } = JSON.parse(body);
            // Store latest helper status in memory (not persisted to config)
            this._voiceStatus = status;
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
          } catch {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid JSON' }));
          }
        });
        return;
      }

      if (url === '/voice/config' && req.method === 'GET') {
        const voice = this.configManager.getResolvedVoiceConfig();
        if (!voice) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Voice not configured' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(voice, null, 2));
        return;
      }

      if (url === '/voice/config' && req.method === 'PUT') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
          try {
            const patch = JSON.parse(body);

            const current = this.configManager.get();
            const updated = { ...current, voice: { ...current.voice, ...patch } };
            this.configManager.update(updated);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(updated.voice, null, 2));
          } catch {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid JSON' }));
          }
        });
        return;
      }

      if (url === '/voice/converse' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
          let transcript: string;
          let conversationId: string | undefined;
          try {
            const parsed = JSON.parse(body);
            transcript = typeof parsed.transcript === 'string' ? parsed.transcript.trim() : '';
            conversationId = typeof parsed.conversationId === 'string' ? parsed.conversationId : undefined;
          } catch {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid JSON' }));
            return;
          }
          if (!transcript) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'transcript is required' }));
            return;
          }
          if (!this.runVoiceConverse) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Voice conversation is not available' }));
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
          const emit = (event: VoiceConverseEvent) => {
            res.write(JSON.stringify(event) + '\n');
          };
          await this.runVoiceConverse(transcript, conversationId, emit);
          res.end();
        });
        return;
      }

      // Speaks text that already exists — no agent run, no command routing.
      // The in-chat voice button uses this: the chat message travels the
      // normal chat path (so it keeps that chat's context and working dir),
      // and only the reading-aloud happens here.
      if (url === '/voice/speak' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
          let text: string;
          let conversationId: string | undefined;
          let verbatim = false;
          try {
            const parsed = JSON.parse(body);
            text = typeof parsed.text === 'string' ? parsed.text.trim() : '';
            conversationId = typeof parsed.conversationId === 'string' ? parsed.conversationId : undefined;
            verbatim = parsed.verbatim === true;
          } catch {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid JSON' }));
            return;
          }
          if (!text) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'text is required' }));
            return;
          }
          if (!this.runVoiceSpeak) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Voice output is not available' }));
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
          await this.runVoiceSpeak(text, (event: VoiceConverseEvent) => {
            res.write(JSON.stringify(event) + '\n');
          }, conversationId, verbatim);
          res.end();
        });
        return;
      }

      // The Swift helper owns Fn-based bindings — Electron's globalShortcut
      // can't bind Fn at all — so when the converse hotkey involves Fn the
      // helper reports the press here and the app takes it from there.
      if (url === '/voice/converse-hotkey' && req.method === 'POST') {
        this.onConverseHotkey?.();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      // The helper's "Settings" menu item used to open `/config` in a browser,
      // which both dumped every credential into the browser and now returns
      // 401. It asks the app to open its own settings window instead.
      if (url === '/voice/open-settings' && req.method === 'POST') {
        if (!this.onOpenSettings) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'No settings UI is attached to this gateway' }));
          return;
        }
        this.onOpenSettings();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      // ── Existing endpoints ────────────────────────────────────────

      if (url === '/config' && req.method === 'GET') {
        try {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          // Serve the same shape that is written to disk — secrets blanked.
          // A bearer token authorizes reading configuration, not exfiltrating
          // every provider credential the user has stored.
          res.end(JSON.stringify(stripSecrets(this.configManager.get()), null, 2));
        } catch (error) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: String(error) }));
        }
        return;
      }

      if (url === '/config' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
          try {
            const config = JSON.parse(body);
            this.configManager.update(config);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true }));
          } catch (error) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: String(error) }));
          }
        });
        return;
      }

      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Not found' }));
    });

    return new Promise((resolve, reject) => {
      const server = this.server!;
      // Without an 'error' listener, a bind failure (e.g. EADDRINUSE when a
      // stale instance still holds the port) is thrown as an uncaughtException
      // instead of rejecting this promise.
      const onBindError = (err: Error) => reject(err);
      server.once('error', onBindError);
      const host = this.configManager.getApiBindHost();
      if (host !== '127.0.0.1' && host !== 'localhost') {
        console.warn(
          `[API] Binding ${host} — the HTTP server is reachable from other machines. ` +
          'Every protected endpoint relies on bearer tokens alone.',
        );
      }
      server.listen(this.port, host, () => {
        server.removeListener('error', onBindError);
        server.on('error', (err: Error) => {
          console.error(`[API] Server error: ${err.message}`);
        });
        console.log(`[API] Server running on ${host}:${this.port}`);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }
}
