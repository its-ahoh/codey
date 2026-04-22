import TelegramBot from 'node-telegram-bot-api';
import { BaseChannelHandler } from './base';
import { UserMessage, GatewayResponse } from '@codey/core';

/**
 * Convert markdown to Telegram HTML.
 * Handles code blocks, inline code, bold, italic, and escapes HTML entities.
 */
function markdownToTelegramHtml(text: string): string {
  // Escape HTML entities first (but we'll restore them in formatted sections)
  const escapeHtml = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const result: string[] = [];
  const lines = text.split('\n');
  let inCodeBlock = false;
  let codeBlockLang = '';
  let codeBlockContent: string[] = [];

  for (const line of lines) {
    // Code block toggle
    const codeBlockMatch = line.match(/^```(\w*)$/);
    if (codeBlockMatch) {
      if (!inCodeBlock) {
        inCodeBlock = true;
        codeBlockLang = codeBlockMatch[1];
        codeBlockContent = [];
      } else {
        // Close code block
        const langAttr = codeBlockLang ? ` class="language-${codeBlockLang}"` : '';
        result.push(`<pre><code${langAttr}>${escapeHtml(codeBlockContent.join('\n'))}</code></pre>`);
        inCodeBlock = false;
        codeBlockLang = '';
      }
      continue;
    }

    if (inCodeBlock) {
      codeBlockContent.push(line);
      continue;
    }

    // Process inline formatting
    let processed = escapeHtml(line);

    // Inline code (must be before bold/italic to avoid conflicts)
    processed = processed.replace(/`([^`]+)`/g, '<code>$1</code>');

    // Bold
    processed = processed.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');

    // Italic
    processed = processed.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '<i>$1</i>');

    result.push(processed);
  }

  // Handle unclosed code block
  if (inCodeBlock) {
    result.push(`<pre><code>${escapeHtml(codeBlockContent.join('\n'))}</code></pre>`);
  }

  return result.join('\n');
}

export class TelegramHandler extends BaseChannelHandler {
  name = 'telegram';
  private bot?: TelegramBot;
  private typingIntervals: Map<string, NodeJS.Timeout> = new Map();

  private notifyChatId?: string;

  async start(config: { botToken: string; notifyChatId?: string }): Promise<void> {
    this.notifyChatId = config.notifyChatId;
    this.bot = new TelegramBot(config.botToken, {
      polling: {
        autoStart: true,
        params: { timeout: 30 },
      },
    });

    // Log transient polling errors at debug level (ECONNRESET, ETIMEDOUT, etc.)
    this.bot.on('polling_error', (err: Error) => {
      console.log(`[Telegram] Polling error: ${err.message}`);
    });

    // Register bot commands menu
    this.bot.setMyCommands([
      { command: 'start', description: 'Welcome & current config' },
      { command: 'help', description: 'Show help message' },
      { command: 'status', description: 'Show gateway status' },
      { command: 'workers', description: 'List workers in current workspace' },
      { command: 'workspaces', description: 'List all workspaces' },
      { command: 'workspace', description: 'Switch workspace' },
      { command: 'worker', description: 'Run a specific worker' },
      { command: 'team', description: 'Run workers in sequence' },
      { command: 'clear', description: 'Clear conversation history' },
      { command: 'reset', description: 'Start new conversation' },
      { command: 'model', description: 'Show or set model' },
      { command: 'agent', description: 'Switch default agent' },
      { command: 'parallel', description: 'Run all agents in parallel' },
    ]);

    this.bot.on('message', (msg) => {
      if (!msg.text) return;
      if (!msg.from || !msg.chat) return;

      const chatId = msg.chat.id.toString();

      // Show typing indicator while processing
      this.startTyping(chatId);

      const message: UserMessage = {
        id: msg.message_id.toString(),
        channel: 'telegram',
        userId: msg.from.id.toString(),
        username: msg.from.username || msg.from.first_name || 'unknown',
        chatId,
        text: msg.text,
        timestamp: msg.date * 1000,
      };

      this.emitMessage(message);
    });

    console.log('[Telegram] Handler started');
  }

  async stop(): Promise<void> {
    // Clear all typing intervals
    for (const interval of this.typingIntervals.values()) {
      clearInterval(interval);
    }
    this.typingIntervals.clear();

    if (this.bot) {
      this.bot.stopPolling();
      this.bot = undefined;
    }
  }

  async sendMessage(response: GatewayResponse): Promise<void> {
    if (!this.bot) return;

    // Stop typing indicator when sending a response
    this.stopTyping(response.chatId);

    const options: TelegramBot.SendMessageOptions = {
      parse_mode: 'HTML',
    };
    if (response.replyTo) {
      options.reply_to_message_id = parseInt(response.replyTo);
    }

    await this.bot.sendMessage(response.chatId, markdownToTelegramHtml(response.text), options);
  }

  private startTyping(chatId: string): void {
    if (!this.bot || this.typingIntervals.has(chatId)) return;

    // Send immediately, then repeat every 4s (Telegram typing expires after 5s)
    this.bot.sendChatAction(chatId, 'typing').catch(() => {});
    const interval = setInterval(() => {
      this.bot?.sendChatAction(chatId, 'typing').catch(() => {});
    }, 4000);

    this.typingIntervals.set(chatId, interval);
  }

  private stopTyping(chatId: string): void {
    const interval = this.typingIntervals.get(chatId);
    if (interval) {
      clearInterval(interval);
      this.typingIntervals.delete(chatId);
    }
  }

  async sendStartupMessage(text: string): Promise<void> {
    if (!this.bot || !this.notifyChatId) return;
    await this.bot.sendMessage(this.notifyChatId, markdownToTelegramHtml(text), {
      parse_mode: 'HTML',
    });
  }
}
