import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  agentSpawnOptions,
  terminateProcessTree,
  withForegroundPolicy,
} from './process-tree';
import { isBackgroundOpenCodeTool } from './opencode';

const active: ChildProcess[] = [];
const tempDirs: string[] = [];

afterEach(() => {
  for (const child of active.splice(0)) terminateProcessTree(child, 'SIGKILL');
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

async function waitForFile(file: string, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(file) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  if (!fs.existsSync(file)) throw new Error(`Timed out waiting for ${file}`);
}

describe('agent process lifecycle', () => {
  it.skipIf(process.platform === 'win32')('terminates a CLI and its spawned tool process', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-process-tree-'));
    tempDirs.push(dir);
    const ready = path.join(dir, 'ready');
    const orphanMarker = path.join(dir, 'orphan-ran');

    const toolScript = `setTimeout(() => require('fs').writeFileSync(${JSON.stringify(orphanMarker)}, 'orphan'), 800)`;
    const cliScript = [
      `require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(toolScript)}], { stdio: 'ignore' })`,
      `require('fs').writeFileSync(${JSON.stringify(ready)}, 'ready')`,
      'setInterval(() => {}, 1000)',
    ].join(';');

    const cli = spawn(process.execPath, ['-e', cliScript], {
      stdio: 'ignore',
      ...agentSpawnOptions(),
    });
    active.push(cli);
    await waitForFile(ready);

    terminateProcessTree(cli);
    await new Promise<void>(resolve => cli.once('close', () => resolve()));
    await new Promise(resolve => setTimeout(resolve, 1_000));

    expect(fs.existsSync(orphanMarker)).toBe(false);
  });

  it('adds a foreground-only instruction that covers detach mechanisms', () => {
    const prompt = withForegroundPolicy('do the work');
    expect(prompt).toContain('do the work');
    expect(prompt).toContain('run_in_background');
    expect(prompt).toContain('nohup');
    expect(prompt).toContain('tmux');
  });

  it('detects background flags in OpenCode tool input', () => {
    expect(isBackgroundOpenCodeTool({
      type: 'tool',
      tool: 'task',
      state: { input: { run_in_background: true } },
    })).toBe(true);
    expect(isBackgroundOpenCodeTool({
      type: 'tool',
      tool: 'task',
      state: { input: { run_in_background: false } },
    })).toBe(false);
  });

  it('wires every adapter to grouped spawning and tree termination', () => {
    for (const file of ['claude-code.ts', 'codex.ts', 'opencode.ts', 'pi.ts']) {
      const source = fs.readFileSync(path.join(__dirname, file), 'utf8');
      expect(source, file).toContain('...agentSpawnOptions()');
      expect(source, file).toContain('terminateProcessTree(');
      expect(source, file).toContain('cleanupProcessTreeAfterClose(');
      expect(source, file).toContain('withForegroundPolicy(request.prompt)');
    }
  });

  it('runs OpenCode without external plugins', () => {
    const source = fs.readFileSync(path.join(__dirname, 'opencode.ts'), 'utf8');
    expect(source).toContain("['run', '--format', 'json', '--pure']");
    expect(source).toContain("OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS = 'false'");
  });
});
