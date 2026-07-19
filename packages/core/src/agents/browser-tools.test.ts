import { describe, expect, it } from 'vitest';
import type { AgentRequest } from '../types';
import { addCodeyBrowserTools } from './index';

const base = (): AgentRequest => ({
  prompt: 'Check the page',
  agent: 'codex',
  context: { workingDir: '/workspace' },
  browserTools: true,
});

const env = {
  CODEY_BROWSER_SOCKET: '/tmp/codey-browser.sock',
  CODEY_BROWSER_TOKEN: 'secret',
  CODEY_BROWSER_CLI: '/Applications/Codey.app/browser-agent-cli.cjs',
  CODEY_BROWSER_RUNTIME: '/Applications/Codey.app/Electron',
};

describe('addCodeyBrowserTools', () => {
  it('adds browser instructions without putting credentials in the prompt', () => {
    const request = addCodeyBrowserTools({ ...base(), browserChatId: 'chat-123' }, env);
    expect(request.prompt).toContain('<codey_browser_tools>');
    expect(request.prompt).toContain('ELECTRON_RUN_AS_NODE=1 "$CODEY_BROWSER_RUNTIME" "$CODEY_BROWSER_CLI" open-view');
    expect(request.prompt).toContain('click-at <x> <y>');
    expect(request.prompt).toContain('wait-download');
    expect(request.prompt).toContain('wait-login');
    expect(request.prompt).toContain('Browsing is view-only by default');
    expect(request.prompt).toContain('otherwise change state');
    expect(request.prompt).toContain('switch-tab <id>');
    expect(request.prompt).not.toContain('secret');
    expect(request.extraEnv).toMatchObject(env);
    expect(request.extraEnv?.CODEY_BROWSER_CHAT_ID).toBe('chat-123');
  });

  it('keeps the private bridge variables authoritative', () => {
    const request = addCodeyBrowserTools({
      ...base(),
      extraEnv: { CODEY_BROWSER_TOKEN: 'overridden', CUSTOM: 'yes' },
    }, env);
    expect(request.extraEnv).toEqual({ CUSTOM: 'yes', ...env });
  });

  it('does not advertise shell tools to an allow-listed read-only turn', () => {
    const request = addCodeyBrowserTools({ ...base(), allowedTools: ['Read', 'Grep'] }, env);
    expect(request.prompt).toBe('Check the page');
    expect(request.extraEnv).toMatchObject(env);
  });

  it('does not advertise browser tools to coordination turns', () => {
    const request = addCodeyBrowserTools({ ...base(), browserTools: false }, env);
    expect(request.prompt).toBe('Check the page');
  });

  it('does nothing when the browser bridge is unavailable', () => {
    const request = base();
    expect(addCodeyBrowserTools(request, {})).toBe(request);
  });
});
