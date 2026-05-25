import { exec } from 'child_process';
import Database from 'better-sqlite3';
import * as os from 'os';
import * as path from 'path';
import { BaseChannelHandler, formatChoicesAsText } from './base';
import { UserMessage, GatewayResponse, ChatRoute } from '@codey/core';

const CHAT_DB_PATH = path.join(os.homedir(), 'Library', 'Messages', 'chat.db');
const CORE_DATA_EPOCH_OFFSET = 978307200;
const DEFAULT_POLL_INTERVAL_MS = 3000;

interface IMessageConfig {
  enabled: boolean;
  allowedSenders?: string[];
  pollIntervalMs?: number;
}

function coreDataToUnixMs(coreDataTimestamp: number): number {
  return (coreDataTimestamp / 1e9 + CORE_DATA_EPOCH_OFFSET) * 1000;
}

export class IMessageHandler extends BaseChannelHandler {
  name = 'imessage';
  private db?: Database.Database;
  private pollInterval?: ReturnType<typeof setInterval>;
  private lastSeenRowId = 0;
  private allowedSenders: Set<string> = new Set();

  async start(config: IMessageConfig): Promise<void> {
    const senders = config.allowedSenders ?? [];
    if (senders.length === 0) {
      console.log('[iMessage] No allowedSenders configured — receive disabled, send-only mode');
    }
    this.allowedSenders = new Set(senders.map(s => s.toLowerCase()));

    try {
      this.db = new Database(CHAT_DB_PATH, { readonly: true, fileMustExist: true });
    } catch (err: any) {
      if (err.code === 'SQLITE_CANTOPEN' || err.message?.includes('unable to open')) {
        console.error(
          '[iMessage] Cannot open chat.db. Grant Full Disk Access to this process:\n' +
          '  System Settings → Privacy & Security → Full Disk Access\n' +
          '  Add: Terminal / iTerm / Node.js'
        );
      } else {
        console.error('[iMessage] Failed to open chat.db:', err.message);
      }
      console.log('[iMessage] Handler started (send-only mode, database unavailable)');
      return;
    }

    const row = this.db.prepare('SELECT MAX(ROWID) AS maxId FROM message').get() as { maxId: number | null } | undefined;
    this.lastSeenRowId = row?.maxId ?? 0;

    const intervalMs = config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.pollInterval = setInterval(() => this.poll(), intervalMs);

    console.log(`[iMessage] Handler started — polling every ${intervalMs}ms, ${senders.length} allowed sender(s)`);
  }

  async stop(): Promise<void> {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = undefined;
    }
    if (this.db) {
      this.db.close();
      this.db = undefined;
    }
  }

  private poll(): void {
    if (!this.db) return;

    try {
      const rows = this.db.prepare(
        `SELECT m.ROWID, m.text, m.date, h.id AS handle
         FROM message m
         JOIN handle h ON m.handle_id = h.ROWID
         WHERE m.ROWID > ? AND m.is_from_me = 0 AND m.text IS NOT NULL AND m.text != ''
         ORDER BY m.ROWID ASC`
      ).all(this.lastSeenRowId) as Array<{ ROWID: number; text: string; date: number; handle: string }>;

      for (const row of rows) {
        this.lastSeenRowId = row.ROWID;

        if (this.allowedSenders.size > 0 && !this.allowedSenders.has(row.handle.toLowerCase())) {
          continue;
        }

        const message: UserMessage = {
          id: String(row.ROWID),
          channel: 'imessage',
          userId: row.handle,
          username: row.handle,
          chatId: row.handle,
          text: row.text,
          timestamp: coreDataToUnixMs(row.date),
        };

        this.emitMessage(message);
      }
    } catch (err: any) {
      console.error('[iMessage] Poll error:', err.message);
    }
  }

  async sendMessage(response: GatewayResponse): Promise<void> {
    const text = formatChoicesAsText(response.text, response.choices);
    await this.runAppleScript(response.chatId, text);
  }

  async sendToRoute(route: ChatRoute, text: string): Promise<void> {
    if (route.channel !== 'imessage') return;
    await this.runAppleScript(route.channelChatId, text);
  }

  private runAppleScript(recipient: string, text: string): Promise<void> {
    const escaped = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
    const script = `tell application "Messages" to send "${escaped}" to buddy "${recipient}"`;
    return new Promise((resolve, reject) => {
      exec(`osascript -e '${script}'`, (error) => {
        if (error) {
          console.error('[iMessage] Send error:', error.message);
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }
}
