import { describe, expect, it } from 'vitest';
import { addCodeyTerminalTools } from './index';
import { AgentRequest } from '../types';

const base = (): AgentRequest => ({
  prompt: 'start the dev server',
  context: { workingDir: '/tmp/work' },
  browserTools: true,
  browserChatId: 'chat-1',
} as AgentRequest);

const env = {
  CODEY_TERMINAL_SOCKET: '/tmp/codey-terminal.sock',
  CODEY_TERMINAL_TOKEN: 'terminal-token',
  CODEY_TERMINAL_RUNTIME: '/Applications/Codey.app/Contents/MacOS/Codey',
  CODEY_TERMINAL_CLI: '/Applications/Codey.app/terminal-agent-cli.cjs',
} as NodeJS.ProcessEnv;

describe('addCodeyTerminalTools', () => {
  it('hands the bridge, the chat and its working directory to the turn', () => {
    expect(addCodeyTerminalTools(base(), true, env).extraEnv).toEqual({
      ...env,
      CODEY_TERMINAL_CHAT_ID: 'chat-1',
      CODEY_TERMINAL_CWD: '/tmp/work',
    });
  });

  it('keeps env the caller already set', () => {
    const request = addCodeyTerminalTools({ ...base(), extraEnv: { FOO: 'bar' } }, true, env);
    expect(request.extraEnv?.FOO).toBe('bar');
  });

  it('gives nothing when the plugin is off or the bridge is missing', () => {
    expect(addCodeyTerminalTools(base(), false, env).extraEnv).toBeUndefined();
    expect(addCodeyTerminalTools(base(), true, { ...env, CODEY_TERMINAL_TOKEN: '' }).extraEnv).toBeUndefined();
  });

  it('gives nothing to a turn without a desktop chat (channels, automations)', () => {
    expect(addCodeyTerminalTools({ ...base(), browserChatId: undefined }, true, env).extraEnv).toBeUndefined();
  });

  it('gives nothing to advisor or tool-restricted turns', () => {
    expect(addCodeyTerminalTools({ ...base(), browserTools: false }, true, env).extraEnv).toBeUndefined();
    expect(addCodeyTerminalTools({ ...base(), allowedTools: [] } as AgentRequest, true, env).extraEnv).toBeUndefined();
  });
});
