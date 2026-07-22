import TelegramBot from 'node-telegram-bot-api';
import { BaseChannelHandler } from './base';
import { UserMessage, GatewayResponse, ChatRoute } from '@codey/core';

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

/**
 * Rewrite a Telegram deep-link start command (`/start pair_123456`, produced by
 * scanning the pairing QR code) into the equivalent `/pair 123456` command.
 * Any other text passes through unchanged.
 */
export function rewriteStartPairCommand(text: string): string {
  const m = text.match(/^\/start pair_(\d{6})$/);
  return m ? `/pair ${m[1]}` : text;
}

export class TelegramHandler extends BaseChannelHandler {
  name = 'telegram';
  private bot?: TelegramBot;
  private botUsername?: string;
  private typingIntervals: Map<string, NodeJS.Timeout> = new Map();
  private lastChoiceMessageByChat = new Map<string, number>(); // chatId → message_id

  async start(config: { botToken: string }): Promise<void> {
    this.bot = new TelegramBot(config.botToken, {
      polling: {
        autoStart: true,
        params: { timeout: 30 },
      },
    });

    // Bot username powers the t.me pairing deep link; pairing falls back to
    // manual code entry if this lookup fails.
    this.bot.getMe()
      .then(me => { this.botUsername = me.username; })
      .catch(err => console.log(`[Telegram] getMe failed: ${err.message}`));

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
      { command: 'pair', description: 'Pair with Mac app using 6-digit code' },
      { command: 'new', description: 'Start a new chat' },
      { command: 'list', description: 'List linked chats' },
      { command: 'switch', description: 'Switch to a different chat' },
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
        text: rewriteStartPairCommand(msg.text),
        timestamp: msg.date * 1000,
      };

      this.emitMessage(message);
    });

    this.bot.on('callback_query', async (query: TelegramBot.CallbackQuery) => {
      const data = query.data;
      const fromId = query.from?.id?.toString();
      const chatId = query.message?.chat?.id?.toString();
      if (!data || !fromId || !chatId) {
        this.bot!.answerCallbackQuery(query.id).catch(() => {});
        return;
      }
      // Resolve indexed payload to a digit so the gateway's digit-mapping picks it up.
      let text = data;
      if (/^opt:\d+$/.test(data)) {
        const idx = parseInt(data.slice(4), 10);
        text = String(idx + 1);
      }
      this.bot!.answerCallbackQuery(query.id).catch(() => {}); // dismiss the spinner
      // Clear buttons on the clicked message so it can't be clicked again
      try {
        await this.bot!.editMessageReplyMarkup(
          { inline_keyboard: [] },
          { chat_id: chatId, message_id: query.message?.message_id },
        );
      } catch { /* message too old or already edited; ignore */ }
      this.lastChoiceMessageByChat.delete(chatId);
      const message: UserMessage = {
        id: `tg-${Date.now()}`,
        channel: 'telegram',
        userId: fromId,
        username: query.from?.username ?? fromId,
        chatId,
        text,
        timestamp: Date.now(),
      };
      this.emitMessage(message);
    });

    console.log('[Telegram] Handler started');
  }

  getBotUsername(): string | undefined {
    return this.botUsername;
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

    const chatId = response.chatId;

    // Stop typing indicator when sending a response
    this.stopTyping(chatId);

    // Clear stale choice buttons from the previous bot message (if any)
    const prior = this.lastChoiceMessageByChat.get(chatId);
    if (prior !== undefined) {
      try {
        await this.bot.editMessageReplyMarkup(
          { inline_keyboard: [] },
          { chat_id: chatId, message_id: prior },
        );
      } catch { /* message too old or already edited; ignore */ }
      this.lastChoiceMessageByChat.delete(chatId);
    }

    const options: TelegramBot.SendMessageOptions = {
      parse_mode: 'HTML',
    };
    if (response.replyTo) {
      options.reply_to_message_id = parseInt(response.replyTo);
    }

    if (response.choices && response.choices.length > 0) {
      // Telegram callback_data limit is 64 bytes. Long labels fall back to indexed
      // payload ("opt:N"); the channel intake below maps "opt:N" back to digit "N+1"
      // and the gateway's digit-mapping helper resolves it via pendingTeam.options /
      // lastAskedOptions.options.
      const buttons = response.choices.map((label, idx) => {
        const data = Buffer.byteLength(label, 'utf8') <= 60 ? label : `opt:${idx}`;
        return { text: label, callback_data: data };
      });
      const rows: TelegramBot.InlineKeyboardButton[][] = [];
      for (let i = 0; i < buttons.length; i += 3) rows.push(buttons.slice(i, i + 3));
      options.reply_markup = { inline_keyboard: rows };
    }

    const sent = await this.bot.sendMessage(chatId, markdownToTelegramHtml(response.text), options);
    // Track this message so the next sendMessage can clear its buttons if the user
    // types a free-text reply instead of clicking
    if (response.choices && response.choices.length > 0) {
      this.lastChoiceMessageByChat.set(chatId, sent.message_id);
    }
  }

  async sendToRoute(route: ChatRoute, text: string): Promise<void> {
    if (route.channel !== 'telegram' || !this.bot || !route.channelChatId) return;
    await this.bot.sendMessage(route.channelChatId, text);
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

}
