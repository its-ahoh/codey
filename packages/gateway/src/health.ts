import * as http from 'http';
import { ConfigManager } from './config';
import { VoiceConverseEvent } from '@codey/core';

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
  ) {
    this.port = port;
    this.getStatus = getStatus;
    this.configManager = configManager;
    this.runVoiceConverse = runVoiceConverse;
    this.runVoiceSpeak = runVoiceSpeak;
    this.onConverseHotkey = onConverseHotkey;
  }

  async start(): Promise<void> {
    this.server = http.createServer(async (req, res) => {
      // CORS headers
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

      if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
      }

      const url = req.url?.split('?')[0];

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
          enabled: voice?.enabled ?? false,
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
        const voice = this.configManager.get().voice;
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

      // ── Existing endpoints ────────────────────────────────────────

      if (url === '/config' && req.method === 'GET') {
        try {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(this.configManager.get(), null, 2));
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
      server.listen(this.port, () => {
        server.removeListener('error', onBindError);
        server.on('error', (err: Error) => {
          console.error(`[API] Server error: ${err.message}`);
        });
        console.log(`[API] Server running on port ${this.port}`);
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
