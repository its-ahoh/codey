import { GatewayConfig, GatewayStatus } from '../types';

const DEFAULT_PORT = 3000;

class ApiService {
  private baseUrl: string = `http://localhost:${DEFAULT_PORT}`;

  setPort(port: number): void {
    this.baseUrl = `http://localhost:${port}`;
  }

  async getStatus(): Promise<GatewayStatus> {
    try {
      const response = await fetch(`${this.baseUrl}/health`);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const data = await response.json();
      return {
        status: data.status,
        uptime: data.uptime,
        messagesProcessed: data.stats?.messagesProcessed || 0,
        errors: data.stats?.errors || 0,
        channels: data.channels || { telegram: false, discord: false, imessage: false },
      };
    } catch (error) {
      return {
        status: 'stopped',
        uptime: 0,
        messagesProcessed: 0,
        errors: 0,
        channels: { telegram: false, discord: false, imessage: false },
      };
    }
  }

  async sendMessage(
    prompt: string,
    onStatus?: (update: { type: string; tool?: string; message: string; input?: Record<string, unknown>; output?: string }) => void,
    onStream?: (text: string) => void,
  ): Promise<string> {
    const response = await fetch(`${this.baseUrl}/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt }),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    // Parse SSE stream
    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('No response body');
    }

    const decoder = new TextDecoder();
    let finalResponse = '';
    let eventType = '';
    let dataBuffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      dataBuffer += chunk;

      // SSE lines end with \n. Process complete lines.
      // Blank line (\n\n or trailing \n) ends a multi-line data block.
      const lines = dataBuffer.split('\n');
      dataBuffer = lines.pop() || ''; // keep unterminated line in buffer

      for (const rawLine of lines) {
        const line = rawLine.trimEnd(); // strip trailing \r if present

        if (line === '') {
          // Blank line = end of current data block, dispatch what we have
          if (dataBuffer !== undefined && eventType) {
            dispatchEvent(eventType, dataBuffer);
            dataBuffer = '';
            eventType = '';
          }
          continue;
        }

        if (line.startsWith('event: ')) {
          // New event type starts — dispatch any pending data first
          if (dataBuffer !== '' && eventType) {
            dispatchEvent(eventType, dataBuffer);
            dataBuffer = '';
          }
          eventType = line.slice(7);
          continue;
        }

        if (line.startsWith('data: ')) {
          const dataContent = line.slice(6);
          // Append to data buffer (SSE data can span multiple lines)
          dataBuffer += (dataBuffer ? '\n' : '') + dataContent;
          continue;
        }

        // Continuation line (indented, no field prefix) — append to data buffer
        dataBuffer += '\n' + line;
      }
    }

    // Dispatch any remaining buffered data after stream ends
    if (dataBuffer !== '' && eventType) {
      dispatchEvent(eventType, dataBuffer);
    }

    function dispatchEvent(type: string, rawData: string) {
      try {
        const parsed = JSON.parse(rawData);
        switch (type) {
          case 'status':
            onStatus?.(parsed);
            break;
          case 'stream':
            onStream?.(parsed);
            break;
          case 'done':
            finalResponse = typeof parsed === 'string' ? parsed : JSON.stringify(parsed);
            break;
          case 'error':
            throw new Error(typeof parsed === 'string' ? parsed : JSON.stringify(parsed));
        }
      } catch (e) {
        if (type === 'error') throw e;
        // Skip unparseable events
      }
    }

    return finalResponse;
  }

  async getConfig(): Promise<GatewayConfig> {
    const response = await fetch(`${this.baseUrl}/config`);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return response.json();
  }

  async setConfig(config: GatewayConfig): Promise<void> {
    const response = await fetch(`${this.baseUrl}/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
  }

  async getWorkspaces(): Promise<string[]> {
    try {
      const response = await fetch(`${this.baseUrl}/workspaces`);
      if (!response.ok) return [];
      return response.json();
    } catch {
      return [];
    }
  }

  async switchWorkspace(name: string): Promise<void> {
    const response = await fetch(`${this.baseUrl}/workspace`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
  }
}

export const apiService = new ApiService();
