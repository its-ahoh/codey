import * as readline from 'readline';
import { marked } from 'marked';
import { markedTerminal } from 'marked-terminal';
import { BaseChannelHandler } from './base';
import { GatewayResponse, UserMessage } from '../types';

marked.use(markedTerminal() as any);

const SEPARATOR = '─'.repeat(60);

export class TuiHandler extends BaseChannelHandler {
  name = 'tui';
  private rl?: readline.Interface;
  private running = false;
  private streaming = false;
  private streamStartTime = 0;
  private timerInterval?: NodeJS.Timeout;

  async start(): Promise<void> {
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    this.running = true;

    console.log('Type a message to send to the coding agent. Use /help for commands. Ctrl+C to exit.\n');

    this.promptLoop();
  }

  private promptLoop(): void {
    if (!this.running || !this.rl) return;

    this.rl.question('> ', (input) => {
      const text = input.trim();
      if (!text) {
        this.promptLoop();
        return;
      }

      const message: UserMessage = {
        id: `tui-${Date.now()}`,
        channel: 'tui',
        userId: 'tui-user',
        username: 'tui',
        chatId: 'tui',
        text,
        timestamp: Date.now(),
      };

      this.streaming = false;

      // Pause readline so the agent process can use stdin for permissions
      this.rl?.pause();
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(false);
      }

      this.emitMessage(message);
    });
  }

  streamText(text: string): void {
    console.log('[TUI-STREAM] Received stream text, streaming:', this.streaming);
    if (!this.streaming) {
      this.streaming = true;
      this.streamStartTime = Date.now();
      console.log('[TUI-STREAM] Starting timer');

      // Start timer display on a separate line
      this.timerInterval = setInterval(() => {
        const elapsed = Math.round((Date.now() - this.streamStartTime) / 1000);
        const mins = Math.floor(elapsed / 60);
        const secs = elapsed % 60;
        const timeStr = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;

        // Print timer on a new line
        process.stdout.write(`\r\x1b[2K\x1b[90m⏱️ Thinking... ${timeStr}\x1b[0m\r`);
      }, 1000);

      process.stdout.write('\n');
    }
    process.stdout.write(text);
  }

  private renderMarkdown(text: string): string {
    try {
      return (marked(text) as string).trimEnd();
    } catch {
      return text;
    }
  }

  async sendMessage(response: GatewayResponse): Promise<void> {
    // Clear timer
    if (this.timerInterval) {
      clearInterval(this.timerInterval);
      this.timerInterval = undefined;
    }

    // Clear the "Thinking..." line if we were streaming
    if (this.streaming) {
      process.stdout.write('\r\x1b[J'); // clear current line
    }

    if (response.text) {
      console.log(`\n${this.renderMarkdown(response.text)}`);
    }

    console.log(`\n${SEPARATOR}\n`);
    this.streaming = false;

    // Resume readline for next prompt
    this.rl?.resume();
    this.promptLoop();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timerInterval) {
      clearInterval(this.timerInterval);
    }
    this.rl?.close();
  }
}
