import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as assert from 'assert';
import { WorkerManager } from '../../packages/core/src/workers';
import { WorkspaceManager } from '../../packages/core/src/workspace';

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-verify-'));
  try {
    const workersDir = path.join(tmp, 'workers');
    const workspacesDir = path.join(tmp, 'workspaces');
    fs.mkdirSync(path.join(workersDir, 'a'), { recursive: true });
    fs.mkdirSync(path.join(workersDir, 'b'), { recursive: true });
    for (const n of ['a', 'b']) {
      fs.writeFileSync(path.join(workersDir, n, 'personality.md'), `# ${n}\n\n## Role\nrole-${n}\n`);
      fs.writeFileSync(path.join(workersDir, n, 'config.json'),
        JSON.stringify({ codingAgent: 'claude-code', model: 'm', tools: [] }));
    }

    fs.mkdirSync(path.join(workspacesDir, 'ws'), { recursive: true });
    fs.writeFileSync(path.join(workspacesDir, 'ws', 'workspace.json'), JSON.stringify({
      workingDir: '/tmp',
      teams: {
        legacy: ['a', 'b'],
        modern: { members: ['a'], dispatch: 'auto' },
        explicit_all: { members: ['a', 'b'], dispatch: 'all' },
        bad_dispatch: { members: ['a'], dispatch: 'parallel' },
      },
    }));

    const wm = new WorkerManager(workersDir);
    await wm.loadWorkers();
    const ws = new WorkspaceManager(wm, workspacesDir);
    await ws.switchWorkspace('ws');

    assert.deepStrictEqual(ws.getTeam('legacy'), { members: ['a', 'b'], dispatch: 'all' }, 'legacy → all');
    assert.deepStrictEqual(ws.getTeam('modern'), { members: ['a'], dispatch: 'auto' }, 'modern preserved');
    assert.deepStrictEqual(ws.getTeam('explicit_all'), { members: ['a', 'b'], dispatch: 'all' }, 'explicit all');
    assert.deepStrictEqual(ws.getTeam('bad_dispatch'), { members: ['a'], dispatch: 'all' }, 'invalid dispatch falls back to all');

    const list = ws.listTeams();
    assert.ok(list.includes('**modern** [auto]'), 'list shows [auto] tag');
    assert.ok(list.includes('**legacy** →'), 'list omits tag for default mode');

    console.log('OK workspace-team-normalize');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
main().catch(e => { console.error(e); process.exit(1); });
