import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import * as path from 'node:path';
import * as os from 'node:os';

export type CoMemoScope = 'user' | 'project';
export interface CoMemoNote {
  id: string; version: number; scope: CoMemoScope; projectId: string | null;
  content: string; deleted: boolean; createdAt: number; updatedAt: number; origin: string;
  metadata?: { kind?: string; source?: { excerpt?: string } | null };
}
export interface CoMemoSettings { paused: boolean; saveMode: 'auto' | 'explicit'; defaultScope: CoMemoScope }
export interface CoMemoContext { context: string; settings: CoMemoSettings; sync?: CoMemoSync }
interface CoMemoSync { errors?: unknown[]; conflicts?: unknown[] }
interface CoMemoWrite { memory: CoMemoNote; sync?: CoMemoSync }
export interface CoMemoOptions { home?: string; node?: string; cli?: string; personalRoot?: string; timeoutMs?: number }

/** Public MCP protocol only: Codey never opens Co-memo's database or imports its internals. */
export class CoMemoClient {
  private options: CoMemoOptions;
  constructor(options: CoMemoOptions = {}) { this.options = options; }

  private launch() {
    return {
      node: this.options.node ?? process.env.CO_MEMO_NODE ?? process.execPath,
      cli: this.options.cli ?? process.env.CO_MEMO_CLI ?? path.join(path.dirname(require.resolve('@ahoh.tech/co-memo/package.json')), 'dist', 'cli.js'),
      launcher: path.join(__dirname, '..', 'co-memo-launcher.cjs'),
      home: this.options.home ?? process.env.CO_MEMO_HOME,
      // A home directory may itself be registered by an older Co-memo setup.
      // Start personal-only calls outside it, without supplying projectPath.
      cwd: this.options.personalRoot ?? os.tmpdir(),
    };
  }

  async call<T>(name: string, args: Record<string, unknown> = {}, projectPath?: string): Promise<T> {
    if (projectPath !== undefined && !path.isAbsolute(projectPath)) throw new Error('Memory project must be an absolute path');
    const launch = this.launch();
    const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
    const transport = new StdioClientTransport({
      command: launch.node,
      args: [launch.launcher, launch.cli, ...(launch.home ? ['--home', launch.home] : []), 'serve'],
      cwd: launch.cwd, env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, stderr: 'pipe',
    });
    // Drain warnings without logging memory content or subprocess input.
    transport.stderr?.on('data', () => {});
    const client = new Client({ name: 'codey', version: '0.13.0' });
    const timeout = this.options.timeoutMs ?? 15000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        (async () => {
          await client.connect(transport);
          const version = client.getServerVersion()?.version ?? '';
          const [major, minor] = version.split('.').map(Number);
          if (!Number.isFinite(major) || (major === 0 && !(minor >= 7))) throw new Error('Codey requires Co-memo 0.7.0 or newer');
          const result = await client.callTool({ name, arguments: { ...args, ...(projectPath ? { projectPath } : {}) } }, undefined, { timeout });
          const text = (result.content as Array<{ type: string; text?: string }>).filter(c => c.type === 'text').map(c => c.text).join('\n');
          if (result.isError) throw new Error(text || 'Co-memo operation failed');
          const data = JSON.parse(text) as T & { sync?: CoMemoSync };
          if (data.sync?.errors?.length) throw new Error('Co-memo synchronization failed; the central write may have succeeded. Refresh before retrying.');
          return data;
        })(),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Co-memo timed out')), timeout); }),
      ]);
    } finally {
      clearTimeout(timer);
      await client.close().catch(() => {});
      await transport.close().catch(() => {});
    }
  }

  context(query: string, projectPath?: string): Promise<CoMemoContext> {
    return this.call('memory_context', { query: query.slice(0, 16000) }, projectPath);
  }
  async list(scope: CoMemoScope, projectPath?: string, query?: string): Promise<CoMemoNote[]> {
    this.requireProject(scope, projectPath);
    const result = await this.call<{ memories: CoMemoNote[] }>('memory_recall', { ...(query ? { query } : {}) }, projectPath);
    return result.memories.filter(note => note.scope === scope && !note.deleted);
  }
  settings(projectPath?: string): Promise<{ effective: CoMemoSettings }> {
    return this.call('memory_settings_get', {}, projectPath);
  }
  setSaveMode(saveMode: 'auto' | 'explicit'): Promise<{ effective: CoMemoSettings }> {
    return this.call('memory_settings_set', { scope: 'user', patch: { saveMode }, userRequested: true });
  }
  async remember(content: string, scope: CoMemoScope, projectPath?: string): Promise<CoMemoNote> {
    this.requireProject(scope, projectPath);
    const result = await this.call<CoMemoWrite>('memory_remember', { content, scope, intent: 'explicit' }, projectPath);
    if (result.memory.deleted) throw new Error('An identical note is archived; restore it in Co-memo instead of saving a duplicate.');
    await this.verify(result.memory, projectPath);
    return result.memory;
  }
  async change(id: string, version: number, scope: CoMemoScope, projectPath: string | undefined, content?: string): Promise<CoMemoNote> {
    this.requireProject(scope, projectPath);
    if (!Number.isSafeInteger(version) || version < 1) throw new Error('Refresh this memory before editing it');
    const current = await this.call<{ memory: CoMemoNote }>('memory_get', { id }, projectPath);
    if (current.memory.scope !== scope) throw new Error('Memory scope does not match this panel');
    // Keep the version read by the UI. Never replace it with the version just fetched.
    const result = await this.call<CoMemoWrite>(content === undefined ? 'memory_archive' : 'memory_update',
      { id, version, intent: 'explicit', ...(content === undefined ? {} : { content }) }, projectPath);
    await this.verify(result.memory, projectPath);
    return result.memory;
  }
  private async verify(memory: CoMemoNote, projectPath?: string) {
    const result = await this.call<{ verified: boolean }>('memory_checkpoint', {
      reason: 'user_correction', outcome: 'saved', receipts: [{ id: memory.id, version: memory.version, deleted: memory.deleted }],
    }, projectPath);
    if (!result.verified) throw new Error('Co-memo could not verify the saved version; refresh before retrying');
  }
  private requireProject(scope: CoMemoScope, projectPath?: string) {
    if (scope === 'project' && !projectPath) throw new Error('Project memory requires an identifiable workspace');
  }

  /** CLI access works across all Codey execution backends without installing duplicate prompt hooks. */
  instructions(projectPath: string | undefined, automatic: boolean): string {
    const { node, cli, launcher, home, cwd } = this.launch();
    const quote = (text: string) => "'" + text.replace(/'/g, "'\\''") + "'";
    const prefix = ['env', 'ELECTRON_RUN_AS_NODE=1', node, launcher, cli, ...(home ? ['--home', home] : []), ...(projectPath ? ['--project', projectPath] : [])].map(quote).join(' ');
    return [
      '## Shared memory access',
      'Use this Co-memo CLI for durable user/project memory. Do not write Codey memory files or create Bot-private memory.',
      `Run from ${quote(projectPath ?? cwd)}. Command prefix: ${prefix}`,
      'Read: list --query TEXT; show ID. Save: add --scope user|project --intent explicit|automatic --content TEXT. Edit: edit ID --version N --intent explicit|automatic --content TEXT. Archive: archive ID --version N --intent explicit|automatic.',
      'Recall related notes first. Scope by meaning: personal preferences are user; workspace facts are project. Use explicit only when the user requests saving. Preserve versions and inspect sync/errors; never silently resolve conflicts. Verify legacy writes with checkpoint --reason task_completed --outcome saved --receipts JSON using the returned id, version and deleted flag.',
      automatic ? 'Consider saving durable, verified information after the task, subject to Co-memo settings. No transcript dumps or speculative facts.' : 'Automatic capture is disabled in Codey. Save only when the user explicitly requests it.',
      projectPath ? '' : 'No project is bound to this conversation. Only user-scope memory is available; do not save project-specific facts here.',
    ].filter(Boolean).join('\n');
  }
}
