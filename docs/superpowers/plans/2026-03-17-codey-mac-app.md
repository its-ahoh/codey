# Codey Mac App Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a macOS menu bar application with chat, config editing, workspace management, and gateway process control

**Architecture:** React Native macOS app with menu bar icon. Spawns Codey gateway as child process. Main window with tabbed interface (Chat, Status, Settings, Workspaces). HTTP communication with gateway for chat.

**Tech Stack:** React Native macOS, TypeScript, IPC for child process, HTTP for API

---

## File Structure

```
codey-mac/                           # New React Native macOS app
├── index.js                         # Entry point
├── App.tsx                          # Main app component
├── app.json                         # React Native config
├── package.json                     # Dependencies
├── tsconfig.json                    # TypeScript config
├── src/
│   ├── components/
│   │   ├── MenuBar.tsx             # Menu bar icon & context menu
│   │   ├── ChatTab.tsx             # Chat interface
│   │   ├── StatusTab.tsx           # Status & gateway logs
│   │   ├── SettingsTab.tsx         # Config editor
│   │   └── WorkspacesTab.tsx       # Workspace manager
│   ├── hooks/
│   │   ├── useGateway.ts           # Gateway process management
│   │   └── useConfig.ts            # Config state
│   ├── services/
│   │   ├── ipc.ts                  # Child process management
│   │   └── api.ts                  # HTTP client for gateway
│   └── types/
│       └── index.ts                # TypeScript types
└── assets/
    └── icon.png                    # Menu bar icon (placeholder)
```

---

## Task 1: Initialize React Native macOS Project

**Files:**
- Create: `codey-mac/package.json`
- Create: `codey-mac/app.json`
- Create: `codey-mac/tsconfig.json`
- Create: `codey-mac/index.js`
- Create: `codey-mac/App.tsx`

- [ ] **Step 1: Create package.json**

```json
{
  "name": "codey-mac",
  "version": "1.0.0",
  "private": true,
  "scripts": {
    "start": "react-native start",
    "macos": "react-native run-macos",
    "build": "react-native build-macos"
  },
  "dependencies": {
    "react": "19.0.0",
    "react-native": "0.79.0"
  },
  "devDependencies": {
    "@types/react": "^19.0.0",
    "typescript": "^5.0.0"
  }
}
```

- [ ] **Step 2: Create app.json**

```json
{
  "name": "CodeyMac",
  "displayName": "Codey"
}
```

- [ ] **Step 3: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "commonjs",
    "strict": true,
    "jsx": "react-native",
    "outDir": "./dist",
    "rootDir": "./",
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true
  },
  "include": ["**/*.ts", "**/*.tsx"],
  "exclude": ["node_modules"]
}
```

- [ ] **Step 4: Create index.js**

```javascript
import {AppRegistry} from 'react-native';
import App from './App';
import {name as appName} from './app.json';

AppRegistry.registerComponent(appName, () => App);
```

- [ ] **Step 5: Create basic App.tsx**

```tsx
import React from 'react';
import {View, Text, StyleSheet} from 'react-native';

const App = () => {
  return (
    <View style={styles.container}>
      <Text>Codey Mac App</Text>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
});

export default App;
```

- [ ] **Step 6: Commit**

```bash
git add codey-mac/
git commit -m "feat(mac): scaffold React Native macOS project"
```

---

## Task 2: Create TypeScript Types

**Files:**
- Create: `codey-mac/src/types/index.ts`

- [ ] **Step 1: Write types**

```typescript
export interface GatewayConfig {
  gateway: {
    port: number;
    defaultAgent: string;
  };
  channels: {
    telegram?: { enabled: boolean; botToken: string; notifyChatId?: string };
    discord?: { enabled: boolean; botToken: string };
    imessage?: { enabled: boolean };
  };
  agents: {
    'claude-code'?: AgentConfig;
    'opencode'?: AgentConfig;
    'codex'?: AgentConfig;
  };
  apiKeys: {
    anthropic?: string;
    openai?: string;
    google?: string;
  };
  dev: {
    logLevel: 'debug' | 'info' | 'warn' | 'error';
  };
}

export interface AgentConfig {
  enabled: boolean;
  defaultModel: string;
  models: { provider: string; model: string }[];
}

export interface GatewayStatus {
  status: 'healthy' | 'degraded' | 'stopped';
  uptime: number;
  messagesProcessed: number;
  errors: number;
  channels: {
    telegram: boolean;
    discord: boolean;
    imessage: boolean;
  };
}

export interface Workspace {
  name: string;
  path: string;
  isActive: boolean;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}
```

- [ ] **Step 2: Commit**

```bash
git add codey-mac/src/types/index.ts
git commit -m "feat(mac): add TypeScript types"
```

---

## Task 3: Implement IPC Service for Gateway Process

**Files:**
- Create: `codey-mac/src/services/ipc.ts`

- [ ] **Step 1: Write IPC service**

```typescript
import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export type LogCallback = (line: string, isError: boolean) => void;

class IPCService {
  private process: ChildProcess | null = null;
  private isRunning = false;
  private logCallback: LogCallback | null = null;

  start(gatewayPath: string, onLog?: LogCallback): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.isRunning) {
        resolve();
        return;
      }

      this.logCallback = onLog || null;

      // Check if gateway exists
      const distPath = path.join(gatewayPath, 'dist', 'index.js');
      const srcPath = path.join(gatewayPath, 'src', 'index.ts');

      let entryPoint: string;
      if (fs.existsSync(distPath)) {
        entryPoint = 'node';
        this.process = spawn('node', [distPath], {
          cwd: gatewayPath,
          env: process.env,
        });
      } else if (fs.existsSync(srcPath)) {
        entryPoint = 'npx ts-node';
        this.process = spawn('npx', ['ts-node', 'src/index.ts'], {
          cwd: gatewayPath,
          env: process.env,
        });
      } else {
        reject(new Error('Gateway not found. Run npm run build first.'));
        return;
      }

      this.process.stdout?.on('data', (data: Buffer) => {
        const lines = data.toString().split('\n').filter(Boolean);
        lines.forEach(line => {
          this.logCallback?.(line, false);
        });
      });

      this.process.stderr?.on('data', (data: Buffer) => {
        const lines = data.toString().split('\n').filter(Boolean);
        lines.forEach(line => {
          this.logCallback?.(line, true);
        });
      });

      this.process.on('error', (error) => {
        this.isRunning = false;
        this.logCallback?.(`Process error: ${error.message}`, true);
      });

      this.process.on('exit', (code) => {
        this.isRunning = false;
        this.logCallback?.(`Process exited with code ${code}`, true);
      });

      // Give it a moment to start
      setTimeout(() => {
        this.isRunning = true;
        resolve();
      }, 1000);
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.process || !this.isRunning) {
        resolve();
        return;
      }

      this.process.on('exit', () => {
        this.isRunning = false;
        this.process = null;
        resolve();
      });

      this.process.kill('SIGTERM');

      setTimeout(() => {
        if (this.process) {
          this.process.kill('SIGKILL');
        }
        this.isRunning = false;
        this.process = null;
        resolve();
      }, 5000);
    });
  }

  getRunning(): boolean {
    return this.isRunning;
  }
}

export const ipcService = new IPCService();
```

- [ ] **Step 2: Commit**

```bash
git add codey-mac/src/services/ipc.ts
git commit -m "feat(mac): add IPC service for gateway process management"
```

---

## Task 4: Implement API Service for HTTP Communication

**Files:**
- Create: `codey-mac/src/services/api.ts`

- [ ] **Step 1: Write API service**

```typescript
import { GatewayConfig, GatewayStatus, ChatMessage } from '../types';

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
```

- [ ] **Step 2: Commit**

```bash
git add codey-mac/src/services/api.ts
git commit -m "feat(mac): add API service for HTTP communication"
```

---

## Task 5: Implement useGateway Hook

**Files:**
- Create: `codey-mac/src/hooks/useGateway.ts`

- [ ] **Step 1: Write useGateway hook**

```typescript
import { useState, useCallback, useEffect } from 'react';
import { ipcService } from '../services/ipc';
import { apiService } from '../services/api';
import { GatewayStatus } from '../types';

export const useGateway = (gatewayPath: string) => {
  const [isRunning, setIsRunning] = useState(false);
  const [status, setStatus] = useState<GatewayStatus>({
    status: 'stopped',
    uptime: 0,
    messagesProcessed: 0,
    errors: 0,
    channels: { telegram: false, discord: false, imessage: false },
  });
  const [logs, setLogs] = useState<string[]>([]);

  const addLog = useCallback((line: string, isError: boolean) => {
    const timestamp = new Date().toLocaleTimeString();
    const prefix = isError ? '❌' : '📝';
    setLogs(prev => [...prev.slice(-100), `${timestamp} ${prefix} ${line}`]);
  }, []);

  const start = useCallback(async () => {
    try {
      await ipcService.start(gatewayPath, addLog);
      setIsRunning(true);
      addLog('Gateway started', false);
    } catch (error) {
      addLog(`Failed to start: ${error}`, true);
    }
  }, [gatewayPath, addLog]);

  const stop = useCallback(async () => {
    try {
      await ipcService.stop();
      setIsRunning(false);
      addLog('Gateway stopped', false);
    } catch (error) {
      addLog(`Failed to stop: ${error}`, true);
    }
  }, [addLog]);

  const toggle = useCallback(() => {
    if (isRunning) {
      stop();
    } else {
      start();
    }
  }, [isRunning, start, stop]);

  // Poll for status when running
  useEffect(() => {
    if (!isRunning) return;

    const pollStatus = async () => {
      const newStatus = await apiService.getStatus();
      setStatus(newStatus);
    };

    pollStatus();
    const interval = setInterval(pollStatus, 5000);
    return () => clearInterval(interval);
  }, [isRunning]);

  return {
    isRunning,
    status,
    logs,
    start,
    stop,
    toggle,
  };
};
```

- [ ] **Step 2: Commit**

```bash
git add codey-mac/src/hooks/useGateway.ts
git commit -m "feat(mac): add useGateway hook"
```

---

## Task 6: Implement MenuBar Component

**Files:**
- Create: `codey-mac/src/components/MenuBar.tsx`

- [ ] **Step 1: Write MenuBar component**

```typescript
import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';

interface MenuBarProps {
  isRunning: boolean;
  onToggle: () => void;
  onOpenWindow: () => void;
  onQuit: () => void;
}

export const MenuBar: React.FC<MenuBarProps> = ({
  isRunning,
  onToggle,
  onOpenWindow,
  onQuit,
}) => {
  return (
    <View style={styles.container}>
      <TouchableOpacity onPress={onOpenWindow} style={styles.iconContainer}>
        <View style={[styles.statusDot, isRunning ? styles.running : styles.stopped]} />
        <Text style={styles.iconText}>Codey</Text>
      </TouchableOpacity>
      <TouchableOpacity onPress={onToggle} style={styles.menuItem}>
        <Text>{isRunning ? 'Stop Gateway' : 'Start Gateway'}</Text>
      </TouchableOpacity>
      <TouchableOpacity onPress={onOpenWindow} style={styles.menuItem}>
        <Text>Open Window</Text>
      </TouchableOpacity>
      <TouchableOpacity onPress={onQuit} style={styles.menuItem}>
        <Text>Quit</Text>
      </TouchableOpacity>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    backgroundColor: '#2d2d2d',
    borderRadius: 8,
    padding: 8,
    minWidth: 150,
  },
  iconContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 8,
    marginBottom: 4,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: 8,
  },
  running: {
    backgroundColor: '#4CAF50',
  },
  stopped: {
    backgroundColor: '#9E9E9E',
  },
  iconText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
  menuItem: {
    padding: 8,
    borderTopWidth: 1,
    borderTopColor: '#444',
  },
});
```

- [ ] **Step 2: Commit**

```bash
git add codey-mac/src/components/MenuBar.tsx
git commit -m "feat(mac): add MenuBar component"
```

---

## Task 7: Implement ChatTab Component

**Files:**
- Create: `codey-mac/src/components/ChatTab.tsx`

- [ ] **Step 1: Write ChatTab component**

```typescript
import React, { useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, ScrollView, StyleSheet } from 'react-native';
import { ChatMessage } from '../types';
import { apiService } from '../services/api';

interface ChatTabProps {
  isGatewayRunning: boolean;
}

export const ChatTab: React.FC<ChatTabProps> = ({ isGatewayRunning }) => {
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  const sendMessage = async () => {
    if (!input.trim() || !isGatewayRunning) return;

    const userMessage: ChatMessage = {
      id: Date.now().toString(),
      role: 'user',
      content: input,
      timestamp: Date.now(),
    };

    setMessages(prev => [...prev, userMessage]);
    setInput('');
    setIsLoading(true);

    try {
      const response = await apiService.sendMessage(input);
      const assistantMessage: ChatMessage = {
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        content: response,
        timestamp: Date.now(),
      };
      setMessages(prev => [...prev, assistantMessage]);
    } catch (error) {
      const errorMessage: ChatMessage = {
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        content: `Error: ${error}`,
        timestamp: Date.now(),
      };
      setMessages(prev => [...prev, errorMessage]);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <View style={styles.container}>
      <ScrollView style={styles.messages}>
        {messages.map(msg => (
          <View key={msg.id} style={msg.role === 'user' ? styles.userMsg : styles.assistantMsg}>
            <Text style={msg.role === 'user' ? styles.userText : styles.assistantText}>
              {msg.content}
            </Text>
          </View>
        ))}
        {isLoading && <Text style={styles.loading}>Thinking...</Text>}
      </ScrollView>
      <View style={styles.inputContainer}>
        <TextInput
          style={styles.input}
          value={input}
          onChangeText={setInput}
          placeholder={isGatewayRunning ? 'Type a message...' : 'Start gateway first'}
          placeholderTextColor="#888"
          multiline
          editable={isGatewayRunning}
        />
        <TouchableOpacity
          style={[styles.sendButton, !isGatewayRunning && styles.sendButtonDisabled]}
          onPress={sendMessage}
          disabled={!isGatewayRunning}
        >
          <Text style={styles.sendButtonText}>Send</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1 },
  messages: { flex: 1, padding: 16 },
  userMsg: { alignItems: 'flex-end', marginBottom: 12 },
  assistantMsg: { alignItems: 'flex-start', marginBottom: 12 },
  userText: { backgroundColor: '#007AFF', color: '#fff', padding: 12, borderRadius: 12 },
  assistantText: { backgroundColor: '#3a3a3a', color: '#fff', padding: 12, borderRadius: 12 },
  loading: { color: '#888', fontStyle: 'italic' },
  inputContainer: { flexDirection: 'row', padding: 12, borderTopWidth: 1, borderTopColor: '#333' },
  input: { flex: 1, backgroundColor: '#2a2a2a', color: '#fff', padding: 12, borderRadius: 8, minHeight: 44 },
  sendButton: { backgroundColor: '#007AFF', padding: 12, borderRadius: 8, marginLeft: 8 },
  sendButtonDisabled: { backgroundColor: '#444' },
  sendButtonText: { color: '#fff', fontWeight: '600' },
});
```

- [ ] **Step 2: Commit**

```bash
git add codey-mac/src/components/ChatTab.tsx
git commit -m "feat(mac): add ChatTab component"
```

---

## Task 8: Implement StatusTab Component

**Files:**
- Create: `codey-mac/src/components/StatusTab.tsx`

- [ ] **Step 1: Write StatusTab component**

```typescript
import React from 'react';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet } from 'react-native';
import { GatewayStatus } from '../types';

interface StatusTabProps {
  status: GatewayStatus;
  logs: string[];
  isRunning: boolean;
  onToggle: () => void;
}

const formatUptime = (seconds: number): string => {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${h}h ${m}m ${s}s`;
};

export const StatusTab: React.FC<StatusTabProps> = ({ status, logs, isRunning, onToggle }) => {
  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>Gateway Status</Text>
        <TouchableOpacity
          style={[styles.toggleButton, isRunning ? styles.stopButton : styles.startButton]}
          onPress={onToggle}
        >
          <Text style={styles.toggleText}>{isRunning ? 'Stop' : 'Start'}</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.statsGrid}>
        <View style={styles.statItem}>
          <Text style={styles.statLabel}>Status</Text>
          <Text style={[styles.statValue, isRunning ? styles.running : styles.stopped]}>
            {isRunning ? 'Running' : 'Stopped'}
          </Text>
        </View>
        <View style={styles.statItem}>
          <Text style={styles.statLabel}>Uptime</Text>
          <Text style={styles.statValue}>{isRunning ? formatUptime(status.uptime) : '-'}</Text>
        </View>
        <View style={styles.statItem}>
          <Text style={styles.statLabel}>Messages</Text>
          <Text style={styles.statValue}>{status.messagesProcessed}</Text>
        </View>
        <View style={styles.statItem}>
          <Text style={styles.statLabel}>Errors</Text>
          <Text style={styles.statValue}>{status.errors}</Text>
        </View>
      </View>

      <Text style={styles.sectionTitle}>Channels</Text>
      <View style={styles.channels}>
        <Text style={styles.channel}>Telegram: {status.channels.telegram ? '✓' : '✗'}</Text>
        <Text style={styles.channel}>Discord: {status.channels.discord ? '✓' : '✗'}</Text>
        <Text style={styles.channel}>iMessage: {status.channels.imessage ? '✓' : '✗'}</Text>
      </View>

      <Text style={styles.sectionTitle}>Logs</Text>
      <ScrollView style={styles.logs}>
        {logs.map((log, index) => (
          <Text key={index} style={styles.logLine}>{log}</Text>
        ))}
      </ScrollView>
    </View>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 },
  title: { fontSize: 20, fontWeight: '600', color: '#fff' },
  toggleButton: { paddingHorizontal: 20, paddingVertical: 10, borderRadius: 8 },
  startButton: { backgroundColor: '#4CAF50' },
  stopButton: { backgroundColor: '#f44336' },
  toggleText: { color: '#fff', fontWeight: '600' },
  statsGrid: { flexDirection: 'row', flexWrap: 'wrap', marginBottom: 20 },
  statItem: { width: '50%', paddingVertical: 8 },
  statLabel: { color: '#888', fontSize: 12 },
  statValue: { color: '#fff', fontSize: 18, fontWeight: '600' },
  running: { color: '#4CAF50' },
  stopped: { color: '#9E9E9E' },
  sectionTitle: { color: '#888', fontSize: 14, marginBottom: 8, marginTop: 12 },
  channels: { flexDirection: 'row', gap: 16 },
  channel: { color: '#ccc' },
  logs: { flex: 1, backgroundColor: '#1a1a1a', borderRadius: 8, padding: 12 },
  logLine: { color: '#888', fontSize: 11, fontFamily: 'monospace' },
});
```

- [ ] **Step 2: Commit**

```bash
git add codey-mac/src/components/StatusTab.tsx
git commit -m "feat(mac): add StatusTab component"
```

---

## Task 9: Implement SettingsTab Component

**Files:**
- Create: `codey-mac/src/components/SettingsTab.tsx`

- [ ] **Step 1: Write SettingsTab component**

```typescript
import React, { useState, useEffect } from 'react';
import { View, Text, TextInput, TouchableOpacity, ScrollView, Switch, StyleSheet } from 'react-native';
import { GatewayConfig } from '../types';
import { apiService } from '../services/api';

interface SettingsTabProps {
  isGatewayRunning: boolean;
}

export const SettingsTab: React.FC<SettingsTabProps> = ({ isGatewayRunning }) => {
  const [config, setConfig] = useState<GatewayConfig | null>(null);
  const [editedConfig, setEditedConfig] = useState<GatewayConfig | null>(null);
  const [port, setPort] = useState('3000');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (isGatewayRunning) {
      loadConfig();
    }
  }, [isGatewayRunning]);

  const loadConfig = async () => {
    try {
      const cfg = await apiService.getConfig();
      setConfig(cfg);
      setEditedConfig(cfg);
      setPort(cfg.gateway.port.toString());
    } catch (error) {
      console.error('Failed to load config:', error);
    }
  };

  const saveConfig = async () => {
    if (!editedConfig) return;
    setSaving(true);
    try {
      await apiService.setConfig(editedConfig);
      setConfig(editedConfig);
    } catch (error) {
      console.error('Failed to save config:', error);
    } finally {
      setSaving(false);
    }
  };

  const updateField = (path: string, value: any) => {
    if (!editedConfig) return;
    const parts = path.split('.');
    // @ts-ignore
    let obj = editedConfig;
    for (let i = 0; i < parts.length - 1; i++) {
      obj = obj[parts[i]];
    }
    obj[parts[parts.length - 1]] = value;
    setEditedConfig({ ...editedConfig });
  };

  if (!isGatewayRunning) {
    return (
      <View style={styles.container}>
        <Text style={styles.offline}>Start the gateway to edit settings</Text>
      </View>
    );
  }

  return (
    <ScrollView style={styles.container}>
      <Text style={styles.section}>Gateway</Text>
      <View style={styles.field}>
        <Text style={styles.label}>Port</Text>
        <TextInput
          style={styles.input}
          value={port}
          onChangeText={setPort}
          keyboardType="numeric"
        />
      </View>
      <View style={styles.field}>
        <Text style={styles.label}>Default Agent</Text>
        <TextInput
          style={styles.input}
          value={editedConfig?.gateway.defaultAgent || ''}
          onChangeText={(v) => updateField('gateway.defaultAgent', v)}
        />
      </View>

      <Text style={styles.section}>Channels</Text>
      <View style={styles.field}>
        <Text style={styles.label}>Telegram</Text>
        <Switch
          value={editedConfig?.channels.telegram?.enabled || false}
          onValueChange={(v) => updateField('channels.telegram.enabled', v)}
        />
      </View>
      <View style={styles.field}>
        <Text style={styles.label}>Discord</Text>
        <Switch
          value={editedConfig?.channels.discord?.enabled || false}
          onValueChange={(v) => updateField('channels.discord.enabled', v)}
        />
      </View>

      <Text style={styles.section}>API Keys</Text>
      <View style={styles.field}>
        <Text style={styles.label}>Anthropic</Text>
        <TextInput
          style={styles.input}
          value={editedConfig?.apiKeys.anthropic || ''}
          onChangeText={(v) => updateField('apiKeys.anthropic', v)}
          secureTextEntry
        />
      </View>
      <View style={styles.field}>
        <Text style={styles.label}>OpenAI</Text>
        <TextInput
          style={styles.input}
          value={editedConfig?.apiKeys.openai || ''}
          onChangeText={(v) => updateField('apiKeys.openai', v)}
          secureTextEntry
        />
      </View>

      <TouchableOpacity style={styles.saveButton} onPress={saveConfig} disabled={saving}>
        <Text style={styles.saveButtonText}>{saving ? 'Saving...' : 'Save'}</Text>
      </TouchableOpacity>
    </ScrollView>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16 },
  offline: { color: '#888', textAlign: 'center', marginTop: 40 },
  section: { color: '#fff', fontSize: 16, fontWeight: '600', marginTop: 20, marginBottom: 12 },
  field: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  label: { color: '#ccc' },
  input: { backgroundColor: '#2a2a2a', color: '#fff', padding: 8, borderRadius: 4, width: 200 },
  saveButton: { backgroundColor: '#007AFF', padding: 14, borderRadius: 8, alignItems: 'center', marginTop: 20 },
  saveButtonText: { color: '#fff', fontWeight: '600' },
});
```

- [ ] **Step 2: Commit**

```bash
git add codey-mac/src/components/SettingsTab.tsx
git commit -m "feat(mac): add SettingsTab component"
```

---

## Task 10: Implement WorkspacesTab Component

**Files:**
- Create: `codey-mac/src/components/WorkspacesTab.tsx`

- [ ] **Step 1: Write WorkspacesTab component**

```typescript
import React, { useState, useEffect } from 'react';
import { View, Text, TouchableOpacity, ScrollView, StyleSheet } from 'react-native';
import { Workspace } from '../types';
import { apiService } from '../services/api';

interface WorkspacesTabProps {
  isGatewayRunning: boolean;
}

export const WorkspacesTab: React.FC<WorkspacesTabProps> = ({ isGatewayRunning }) => {
  const [workspaces, setWorkspaces] = useState<string[]>([]);
  const [currentWorkspace, setCurrentWorkspace] = useState<string>('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (isGatewayRunning) {
      loadWorkspaces();
    }
  }, [isGatewayRunning]);

  const loadWorkspaces = async () => {
    try {
      const ws = await apiService.getWorkspaces();
      setWorkspaces(ws);
    } catch (error) {
      console.error('Failed to load workspaces:', error);
    }
  };

  const switchWorkspace = async (name: string) => {
    setLoading(true);
    try {
      await apiService.switchWorkspace(name);
      setCurrentWorkspace(name);
    } catch (error) {
      console.error('Failed to switch workspace:', error);
    } finally {
      setLoading(false);
    }
  };

  if (!isGatewayRunning) {
    return (
      <View style={styles.container}>
        <Text style={styles.offline}>Start the gateway to manage workspaces</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Text style={styles.section}>Workspaces</Text>
      {workspaces.length === 0 ? (
        <Text style={styles.empty}>No workspaces found</Text>
      ) : (
        <ScrollView>
          {workspaces.map(ws => (
            <TouchableOpacity
              key={ws}
              style={[styles.workspaceItem, currentWorkspace === ws && styles.activeWorkspace]}
              onPress={() => switchWorkspace(ws)}
              disabled={loading}
            >
              <Text style={styles.workspaceName}>{ws}</Text>
              {currentWorkspace === ws && <Text style={styles.activeBadge}>Active</Text>}
            </TouchableOpacity>
          ))}
        </ScrollView>
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16 },
  offline: { color: '#888', textAlign: 'center', marginTop: 40 },
  section: { color: '#fff', fontSize: 16, fontWeight: '600', marginBottom: 16 },
  empty: { color: '#888' },
  workspaceItem: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 16, backgroundColor: '#2a2a2a', borderRadius: 8, marginBottom: 8 },
  activeWorkspace: { borderColor: '#007AFF', borderWidth: 1 },
  workspaceName: { color: '#fff', fontSize: 14 },
  activeBadge: { color: '#007AFF', fontSize: 12 },
});
```

- [ ] **Step 2: Commit**

```bash
git add codey-mac/src/components/WorkspacesTab.tsx
git commit -m "feat(mac): add WorkspacesTab component"
```

---

## Task 11: Wire Up Main App Component

**Files:**
- Modify: `codey-mac/App.tsx`

- [ ] **Step 1: Update App.tsx**

```tsx
import React, { useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, SafeAreaView, Modal } from 'react-native';
import { useGateway } from './src/hooks/useGateway';
import { ChatTab } from './src/components/ChatTab';
import { StatusTab } from './src/components/StatusTab';
import { SettingsTab } from './src/components/SettingsTab';
import { WorkspacesTab } from './src/components/WorkspacesTab';

type TabType = 'chat' | 'status' | 'settings' | 'workspaces';

const GATEWAY_PATH = '/Users/jackou/Documents/projects/codey';

const App = () => {
  const [activeTab, setActiveTab] = useState<TabType>('chat');
  const [showWindow, setShowWindow] = useState(false);
  const { isRunning, status, logs, toggle } = useGateway(GATEWAY_PATH);

  const tabs: { key: TabType; label: string }[] = [
    { key: 'chat', label: 'Chat' },
    { key: 'status', label: 'Status' },
    { key: 'settings', label: 'Settings' },
    { key: 'workspaces', label: 'Workspaces' },
  ];

  const renderTab = () => {
    switch (activeTab) {
      case 'chat':
        return <ChatTab isGatewayRunning={isRunning} />;
      case 'status':
        return <StatusTab status={status} logs={logs} isRunning={isRunning} onToggle={toggle} />;
      case 'settings':
        return <SettingsTab isGatewayRunning={isRunning} />;
      case 'workspaces':
        return <WorkspacesTab isGatewayRunning={isRunning} />;
    }
  };

  if (!showWindow) {
    return (
      <View style={styles.menuBar}>
        <TouchableOpacity style={styles.menuItem} onPress={() => setShowWindow(true)}>
          <View style={[styles.statusDot, isRunning ? styles.running : styles.stopped]} />
          <Text style={styles.menuText}>Codey</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.menuItem} onPress={toggle}>
          <Text style={styles.menuText}>{isRunning ? 'Stop' : 'Start'}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.menuItem} onPress={() => setShowWindow(true)}>
          <Text style={styles.menuText}>Open</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.menuItem} onPress={() => {}}>
          <Text style={styles.menuText}>Quit</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.tabBar}>
        {tabs.map(tab => (
          <TouchableOpacity
            key={tab.key}
            style={[styles.tab, activeTab === tab.key && styles.activeTab]}
            onPress={() => setActiveTab(tab.key)}
          >
            <Text style={[styles.tabText, activeTab === tab.key && styles.activeTabText]}>
              {tab.label}
            </Text>
          </TouchableOpacity>
        ))}
      </View>
      <View style={styles.content}>{renderTab()}</View>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#1a1a1a' },
  menuBar: { backgroundColor: '#2d2d2d', padding: 8, borderRadius: 8 },
  menuItem: { flexDirection: 'row', alignItems: 'center', padding: 8 },
  statusDot: { width: 8, height: 8, borderRadius: 4, marginRight: 8 },
  running: { backgroundColor: '#4CAF50' },
  stopped: { backgroundColor: '#9E9E9E' },
  menuText: { color: '#fff' },
  tabBar: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: '#333' },
  tab: { flex: 1, padding: 14, alignItems: 'center' },
  activeTab: { borderBottomWidth: 2, borderBottomColor: '#007AFF' },
  tabText: { color: '#888' },
  activeTabText: { color: '#fff', fontWeight: '600' },
  content: { flex: 1 },
});

export default App;
```

- [ ] **Step 2: Commit**

```bash
git add codey-mac/App.tsx
git commit -m "feat(mac): wire up main App with tabs and menu bar"
```

---

## Task 12: Build and Test

**Files:**
- Test: `codey-mac/` build verification

- [ ] **Step 1: Install dependencies**

Run: `cd codey-mac && npm install`
Expected: Dependencies installed without errors

- [ ] **Step 2: Build macOS app**

Run: `cd codey-mac && npm run macos`
Expected: App builds successfully

- [ ] **Step 3: Verify app launches**

Expected: Menu bar icon appears, window opens on click

- [ ] **Step 4: Test gateway start/stop**

Expected: Gateway process starts and stops correctly

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(mac): complete Codey macOS app implementation"
```
