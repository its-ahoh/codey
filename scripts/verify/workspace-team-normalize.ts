import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as assert from 'assert';
import { BotManager } from '../../packages/core/src/bots';
import { WorkspaceManager } from '../../packages/core/src/workspace';

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-verify-'));
  try {
    const botsDir = path.join(tmp, 'bots');
    const workspacesDir = path.join(tmp, 'workspaces');
    fs.mkdirSync(path.join(botsDir, 'a'), { recursive: true });
    fs.mkdirSync(path.join(botsDir, 'b'), { recursive: true });
    for (const n of ['a', 'b']) {
      fs.writeFileSync(path.join(botsDir, n, 'personality.md'), `# ${n}\n\n## Role\nrole-${n}\n`);
      fs.writeFileSync(path.join(botsDir, n, 'config.json'),
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
        unknown_team: ['a', 'ghost'],
      },
    }));

    const wm = new BotManager(botsDir);
    await wm.loadBots();
    const ws = new WorkspaceManager(wm, workspacesDir);
    await ws.switchWorkspace('ws');

    assert.deepStrictEqual(ws.getTeam('legacy'), { members: ['a', 'b'], dispatch: 'all' }, 'legacy → all');
    assert.deepStrictEqual(ws.getTeam('modern'), { members: ['a'], dispatch: 'auto' }, 'modern preserved');
    assert.deepStrictEqual(ws.getTeam('explicit_all'), { members: ['a', 'b'], dispatch: 'all' }, 'explicit all');
    assert.deepStrictEqual(ws.getTeam('bad_dispatch'), { members: ['a'], dispatch: 'all' }, 'invalid dispatch falls back to all');
    assert.strictEqual(ws.getTeam('unknown_team'), undefined, 'team with unknown bot is dropped');

    const list = ws.listTeams();
    assert.ok(list.includes('**modern** [auto]'), 'list shows [auto] tag');
    assert.ok(list.includes('**legacy** →'), 'list omits tag for default mode');

    console.log('OK workspace-team-normalize');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
main().catch(e => { console.error(e); process.exit(1); });
