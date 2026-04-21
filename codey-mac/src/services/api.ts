import { GatewayConfig, GatewayStatus } from '../types';

export interface WorkerDto {
  name: string;
  personality: { role: string; soul: string; instructions: string };
  config: { codingAgent: 'claude-code' | 'opencode' | 'codex'; model: string; tools: string[] };
}

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
    conversationId?: string,
  ): Promise<{ response: string; conversationId?: string }> {
    const response = await fetch(`${this.baseUrl}/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, conversationId }),
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
    let returnedConversationId: string | undefined;
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
          case 'conversationId':
            returnedConversationId = typeof parsed === 'string' ? parsed : JSON.stringify(parsed);
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

    return { response: finalResponse, conversationId: returnedConversationId };
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

  async listWorkers(): Promise<WorkerDto[]> {
    try {
      const res = await fetch(`${this.baseUrl}/workers`);
      if (!res.ok) return [];
      const data = await res.json();
      return data.workers || [];
    } catch {
      return [];
    }
  }

  async updateWorker(name: string, body: Partial<WorkerDto>): Promise<WorkerDto> {
    const res = await fetch(`${this.baseUrl}/workers/${encodeURIComponent(name)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ personality: body.personality, config: body.config }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data.worker;
  }

  async deleteWorker(name: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/workers/${encodeURIComponent(name)}`, { method: 'DELETE' });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `HTTP ${res.status}`);
    }
  }

  async generateWorker(prompt: string): Promise<WorkerDto> {
    const res = await fetch(`${this.baseUrl}/workers/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data.worker;
  }

  async getTeams(workspace: string): Promise<Record<string, string[]>> {
    try {
      const res = await fetch(`${this.baseUrl}/workspaces/${encodeURIComponent(workspace)}/teams`);
      if (!res.ok) return {};
      const data = await res.json();
      return data.teams || {};
    } catch {
      return {};
    }
  }

  async setTeams(workspace: string, teams: Record<string, string[]>): Promise<void> {
    const res = await fetch(`${this.baseUrl}/workspaces/${encodeURIComponent(workspace)}/teams`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ teams }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      const err: any = new Error(data.error || `HTTP ${res.status}`);
      if (data.unknown) err.unknown = data.unknown;
      throw err;
    }
  }
}

export const apiService = new ApiService();
