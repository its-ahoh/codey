import { EventEmitter } from 'events';
import { exec } from 'child_process';
import { BaseChannelHandler } from './base';
import { UserMessage, GatewayResponse } from '@codey/core';

// iMessage handler using macOS AppleScript
// Note: Requires Mac OS and iMessage enabled
export class IMessageHandler extends BaseChannelHandler {
  name = 'imessage';
  private eventEmitter = new EventEmitter();

  async start(_config: { enabled: boolean }): Promise<void> {
    // iMessage polling would require a daemon or external service
    // For now, we'll support sending via applescript and a simple polling mechanism
    console.log('[iMessage] Handler started (send-only mode)');
    
    // Check for incoming messages via a simple approach
    // In production, you'd use a service like bluemail or apple-messages-js
  }

  async stop(): Promise<void> {
    // Cleanup if needed
  }

  async sendMessage(response: GatewayResponse): Promise<void> {
    const script = `
      tell application "Messages"
        send "${this.escapeString(response.text)}" to buddy "${response.chatId}"
      end tell
    `;

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

  onMessage(callback: (message: UserMessage) => Promise<void>): void {
    this.eventEmitter.on('message', callback);
  }

  private escapeString(str: string): string {
    return str.replace(/"/g, '\\"').replace(/\n/g, '\\n');
  }

  // Method to receive messages (would need external integration)
  receiveMessage(message: UserMessage): void {
    this.emitMessage(message);
  }
}
