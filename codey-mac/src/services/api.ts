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

  async sendMessage(prompt: string): Promise<string> {
    const response = await fetch(`${this.baseUrl}/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt }),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();
    return data.response || data.text || '';
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
