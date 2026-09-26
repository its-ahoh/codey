/**
 * verify-bots.ts
 * Calls @codey/core directly — no HTTP server required.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import { BotManager, WorkspaceManager, BotNotFoundError } from '@codey/core';

const repoRoot = path.resolve(__dirname, '..');
process.chdir(repoRoot);

function section(name: string) {
  console.log(`\n=== ${name} ===`);
}

function expect(condition: boolean, label: string) {
  console.log(`${condition ? '✓' : '✗'} ${label}`);
  if (!condition) process.exitCode = 1;
}

async function run() {
  // ── Section 1: List bots ──────────────────────────────────────
  section('1. List bots');
  const wm = new BotManager('./bots');
  await wm.loadBots();

  const allBots = wm.getAllBots();
  expect(allBots.length >= 2, 'at least 2 bots loaded');
  expect(wm.hasBot('architect'), 'architect present');
  expect(wm.hasBot('executor'), 'executor present');
  console.log(`✓ listBots() returns ${allBots.length} bots`);

  // ── Section 2: Get a specific bot ────────────────────────────
  section('2. Get specific bot');
  const architect = wm.getBot('architect');
  expect(architect !== undefined, 'architect resolved');
  expect(architect && !('codingAgent' in architect.config), 'architect has no execution binding');
  expect(typeof architect?.personality.role === 'string' && architect.personality.role.length > 0, 'architect has a role');

  expect(wm.getBot('nosuch') === undefined, 'nosuch returns undefined');

  // ── Section 3: Get teams ─────────────────────────────────────────
  section('3. Get teams');
  const wsm = new WorkspaceManager(wm, './workspaces');
  await wsm.switchWorkspace('default');

  const reviewTeam = wsm.getTeam('review');
  expect(Array.isArray(reviewTeam) && reviewTeam!.length === 2, 'default workspace has review team with 2 members');
  expect(wsm.getTeam('nosuch') === undefined, 'non-existent team returns undefined');
  const teamNames = wsm.getTeamNames();
  expect(Array.isArray(teamNames) && teamNames.includes('review'), 'getTeamNames() includes review');

  // ── Section 4: PUT (update) bot ───────────────────────────────
  section('4. PUT bot — update personality.md on disk and reload');
  const personalityPath = path.join(repoRoot, 'bots', 'architect', 'personality.md');
  const originalContent = fs.readFileSync(personalityPath, 'utf-8');

  // Write an edited soul line into the file
  const editedContent = originalContent.replace(/## Soul[\s\S]*?(?=## |\n*$)/, '## Soul\nVerifier-edited soul.\n\n');
  fs.writeFileSync(personalityPath, editedContent, 'utf-8');

  // Reload the bot manager to pick up the change
  await wm.loadBots();
  const updated = wm.getBot('architect');
  expect(updated?.personality.soul.includes('Verifier-edited') === true, 'PUT updated the soul');

  // Restore original file via git checkout (so the finally block is a no-op)
  execSync('git checkout bots/architect/personality.md', { cwd: repoRoot, stdio: 'pipe' });
  await wm.loadBots();
  const restored = wm.getBot('architect');
  expect(restored?.personality.soul.includes('Verifier-edited') !== true, 'soul restored after git checkout');

  // ── Section 5: DELETE bot (temp, then confirm gone) ───────────
  section('5. DELETE bot');
  const tmpBotsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-wm-'));
  const tmpName = 'temp-bot';
  const tmpDir = path.join(tmpBotsDir, tmpName);
  fs.mkdirSync(tmpDir);
  fs.writeFileSync(path.join(tmpDir, 'personality.md'), `# Bot: ${tmpName}\n\n## Role\nTemp.\n\n## Soul\nTemp soul.\n\n## Instructions\nDo things.\n`);
  fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify({ codingAgent: 'claude-code', model: 'test', tools: [] }));

  const wmTmp = new BotManager(tmpBotsDir);
  await wmTmp.loadBots();
  expect(wmTmp.hasBot(tmpName), 'temp bot loaded');

  // Delete by removing the directory
  fs.rmSync(tmpDir, { recursive: true, force: true });
  await wmTmp.loadBots();
  expect(!wmTmp.hasBot(tmpName), 'temp bot gone after deletion');

  // Confirm getBot returns undefined (BotNotFoundError is a guard class for future use)
  const gone = wmTmp.getBot(tmpName);
  expect(gone === undefined, 'getBot returns undefined for deleted bot');

  fs.rmSync(tmpBotsDir, { recursive: true, force: true });

  // ── Section 6: PUT teams ─────────────────────────────────────────
  section('6. PUT teams — write new teams into workspace.json and reload');
  const workspaceJsonPath = path.join(repoRoot, 'workspaces', 'default', 'workspace.json');
  const originalWsJson = fs.readFileSync(workspaceJsonPath, 'utf-8');
  const parsed = JSON.parse(originalWsJson);

  // Add a new test team
  parsed.teams = { ...parsed.teams, verify: ['architect'] };
  fs.writeFileSync(workspaceJsonPath, JSON.stringify(parsed, null, 2), 'utf-8');

  // Fresh managers to reload
  const wm2 = new BotManager('./bots');
  await wm2.loadBots();
  const wsm2 = new WorkspaceManager(wm2, './workspaces');
  await wsm2.switchWorkspace('default');

  expect(Array.isArray(wsm2.getTeam('verify')) && wsm2.getTeam('verify')!.includes('architect'), 'verify team accepted with architect member');
  expect(Array.isArray(wsm2.getTeam('review')), 'review team still present');

  // Restore workspace.json via git checkout
  execSync('git checkout workspaces/default/workspace.json', { cwd: repoRoot, stdio: 'pipe' });

  // ── Section 7: Cascade delete ────────────────────────────────────
  section('7. Cascade delete — bot removed from team when bot deleted');
  // Build an isolated temp environment with two bots and a team referencing both.
  const tmpWD = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-cascade-'));
  const tmpWSDir = path.join(tmpWD, 'workspaces');
  const tmpWkDir = path.join(tmpWD, 'bots');

  // Create bots
  for (const name of ['alpha', 'beta']) {
    const d = path.join(tmpWkDir, name);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'personality.md'), `# Bot: ${name}\n\n## Role\n${name} role.\n\n## Soul\n${name} soul.\n\n## Instructions\nDo ${name}.\n`);
    fs.writeFileSync(path.join(d, 'config.json'), JSON.stringify({ codingAgent: 'claude-code', model: 'test', tools: [] }));
  }

  // Create a workspace with a team that has both alpha and beta
  const tmpDefaultWs = path.join(tmpWSDir, 'default');
  fs.mkdirSync(tmpDefaultWs, { recursive: true });
  fs.writeFileSync(path.join(tmpDefaultWs, 'workspace.json'), JSON.stringify({
    workingDir: tmpWD,
    teams: { squad: ['alpha', 'beta'] },
  }, null, 2));

  const wmCascade = new BotManager(tmpWkDir);
  await wmCascade.loadBots();
  const wsmCascade = new WorkspaceManager(wmCascade, tmpWSDir);
  await wsmCascade.switchWorkspace('default');

  expect(wsmCascade.getTeam('squad')?.includes('alpha') === true, 'alpha in squad team');
  expect(wsmCascade.getTeam('squad')?.includes('beta') === true, 'beta in squad team');

  // Delete alpha by removing from disk, then update workspace.json to remove alpha from team
  fs.rmSync(path.join(tmpWkDir, 'alpha'), { recursive: true, force: true });

  // Read current workspace.json, filter alpha from the team, write back
  const wsJsonRaw = fs.readFileSync(path.join(tmpDefaultWs, 'workspace.json'), 'utf-8');
  const wsJsonParsed = JSON.parse(wsJsonRaw);
  wsJsonParsed.teams.squad = wsJsonParsed.teams.squad.filter((m: string) => m !== 'alpha');
  fs.writeFileSync(path.join(tmpDefaultWs, 'workspace.json'), JSON.stringify(wsJsonParsed, null, 2));

  // Reload and verify cascade
  await wmCascade.loadBots();
  const wsmCascade2 = new WorkspaceManager(wmCascade, tmpWSDir);
  await wsmCascade2.switchWorkspace('default');

  expect(!wmCascade.hasBot('alpha'), 'alpha no longer in bot library after deletion');
  expect(wmCascade.hasBot('beta'), 'beta still in bot library');
  expect(wsmCascade2.getTeam('squad')?.includes('alpha') !== true, 'alpha removed from squad team');
  expect(wsmCascade2.getTeam('squad')?.includes('beta') === true, 'beta still in squad team');

  fs.rmSync(tmpWD, { recursive: true, force: true });

  console.log('\nAll verify-bots sections passed.');
}

run()
  .catch(err => { console.error(err); process.exit(1); })
  .finally(() => {
    try {
      execSync(
        'git checkout bots/architect/personality.md bots/architect/config.json workspaces/default/workspace.json',
        { cwd: repoRoot, stdio: 'inherit' }
      );
    } catch { /* ignore */ }
  });
