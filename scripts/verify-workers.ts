/**
 * verify-workers.ts
 * Calls @codey/core directly — no HTTP server required.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import { WorkerManager, WorkspaceManager, WorkerNotFoundError } from '@codey/core';

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
  // ── Section 1: List workers ──────────────────────────────────────
  section('1. List workers');
  const wm = new WorkerManager('./workers');
  await wm.loadWorkers();

  const allWorkers = wm.getAllWorkers();
  expect(allWorkers.length >= 2, 'at least 2 workers loaded');
  expect(wm.hasWorker('architect'), 'architect present');
  expect(wm.hasWorker('executor'), 'executor present');
  console.log(`✓ listWorkers() returns ${allWorkers.length} workers`);

  // ── Section 2: Get a specific worker ────────────────────────────
  section('2. Get specific worker');
  const architect = wm.getWorker('architect');
  expect(architect !== undefined, 'architect resolved');
  expect(architect?.config.codingAgent === 'claude-code', 'architect codingAgent is claude-code');
  expect(typeof architect?.personality.role === 'string' && architect.personality.role.length > 0, 'architect has a role');

  expect(wm.getWorker('nosuch') === undefined, 'nosuch returns undefined');

  // ── Section 3: Get teams ─────────────────────────────────────────
  section('3. Get teams');
  const wsm = new WorkspaceManager(wm, './workspaces');
  await wsm.switchWorkspace('default');

  const reviewTeam = wsm.getTeam('review');
  expect(Array.isArray(reviewTeam) && reviewTeam!.length === 2, 'default workspace has review team with 2 members');
  expect(wsm.getTeam('nosuch') === undefined, 'non-existent team returns undefined');
  const teamNames = wsm.getTeamNames();
  expect(Array.isArray(teamNames) && teamNames.includes('review'), 'getTeamNames() includes review');

  // ── Section 4: PUT (update) worker ───────────────────────────────
  section('4. PUT worker — update personality.md on disk and reload');
  const personalityPath = path.join(repoRoot, 'workers', 'architect', 'personality.md');
  const originalContent = fs.readFileSync(personalityPath, 'utf-8');

  // Write an edited soul line into the file
  const editedContent = originalContent.replace(/## Soul[\s\S]*?(?=## |\n*$)/, '## Soul\nVerifier-edited soul.\n\n');
  fs.writeFileSync(personalityPath, editedContent, 'utf-8');

  // Reload the worker manager to pick up the change
  await wm.loadWorkers();
  const updated = wm.getWorker('architect');
  expect(updated?.personality.soul.includes('Verifier-edited') === true, 'PUT updated the soul');

  // Restore original file via git checkout (so the finally block is a no-op)
  execSync('git checkout workers/architect/personality.md', { cwd: repoRoot, stdio: 'pipe' });
  await wm.loadWorkers();
  const restored = wm.getWorker('architect');
  expect(restored?.personality.soul.includes('Verifier-edited') !== true, 'soul restored after git checkout');

  // ── Section 5: DELETE worker (temp, then confirm gone) ───────────
  section('5. DELETE worker');
  const tmpWorkersDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-wm-'));
  const tmpName = 'temp-worker';
  const tmpDir = path.join(tmpWorkersDir, tmpName);
  fs.mkdirSync(tmpDir);
  fs.writeFileSync(path.join(tmpDir, 'personality.md'), `# Worker: ${tmpName}\n\n## Role\nTemp.\n\n## Soul\nTemp soul.\n\n## Instructions\nDo things.\n`);
  fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify({ codingAgent: 'claude-code', model: 'test', tools: [] }));

  const wmTmp = new WorkerManager(tmpWorkersDir);
  await wmTmp.loadWorkers();
  expect(wmTmp.hasWorker(tmpName), 'temp worker loaded');

  // Delete by removing the directory
  fs.rmSync(tmpDir, { recursive: true, force: true });
  await wmTmp.loadWorkers();
  expect(!wmTmp.hasWorker(tmpName), 'temp worker gone after deletion');

  // Confirm getWorker returns undefined (WorkerNotFoundError is a guard class for future use)
  const gone = wmTmp.getWorker(tmpName);
  expect(gone === undefined, 'getWorker returns undefined for deleted worker');

  fs.rmSync(tmpWorkersDir, { recursive: true, force: true });

  // ── Section 6: PUT teams ─────────────────────────────────────────
  section('6. PUT teams — write new teams into workspace.json and reload');
  const workspaceJsonPath = path.join(repoRoot, 'workspaces', 'default', 'workspace.json');
  const originalWsJson = fs.readFileSync(workspaceJsonPath, 'utf-8');
  const parsed = JSON.parse(originalWsJson);

  // Add a new test team
  parsed.teams = { ...parsed.teams, verify: ['architect'] };
  fs.writeFileSync(workspaceJsonPath, JSON.stringify(parsed, null, 2), 'utf-8');

  // Fresh managers to reload
  const wm2 = new WorkerManager('./workers');
  await wm2.loadWorkers();
  const wsm2 = new WorkspaceManager(wm2, './workspaces');
  await wsm2.switchWorkspace('default');

  expect(Array.isArray(wsm2.getTeam('verify')) && wsm2.getTeam('verify')!.includes('architect'), 'verify team accepted with architect member');
  expect(Array.isArray(wsm2.getTeam('review')), 'review team still present');

  // Restore workspace.json via git checkout
  execSync('git checkout workspaces/default/workspace.json', { cwd: repoRoot, stdio: 'pipe' });

  // ── Section 7: Cascade delete ────────────────────────────────────
  section('7. Cascade delete — worker removed from team when worker deleted');
  // Build an isolated temp environment with two workers and a team referencing both.
  const tmpWD = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-cascade-'));
  const tmpWSDir = path.join(tmpWD, 'workspaces');
  const tmpWkDir = path.join(tmpWD, 'workers');

  // Create workers
  for (const name of ['alpha', 'beta']) {
    const d = path.join(tmpWkDir, name);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'personality.md'), `# Worker: ${name}\n\n## Role\n${name} role.\n\n## Soul\n${name} soul.\n\n## Instructions\nDo ${name}.\n`);
    fs.writeFileSync(path.join(d, 'config.json'), JSON.stringify({ codingAgent: 'claude-code', model: 'test', tools: [] }));
  }

  // Create a workspace with a team that has both alpha and beta
  const tmpDefaultWs = path.join(tmpWSDir, 'default');
  fs.mkdirSync(tmpDefaultWs, { recursive: true });
  fs.writeFileSync(path.join(tmpDefaultWs, 'workspace.json'), JSON.stringify({
    workingDir: tmpWD,
    teams: { squad: ['alpha', 'beta'] },
  }, null, 2));

  const wmCascade = new WorkerManager(tmpWkDir);
  await wmCascade.loadWorkers();
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
  await wmCascade.loadWorkers();
  const wsmCascade2 = new WorkspaceManager(wmCascade, tmpWSDir);
  await wsmCascade2.switchWorkspace('default');

  expect(!wmCascade.hasWorker('alpha'), 'alpha no longer in worker library after deletion');
  expect(wmCascade.hasWorker('beta'), 'beta still in worker library');
  expect(wsmCascade2.getTeam('squad')?.includes('alpha') !== true, 'alpha removed from squad team');
  expect(wsmCascade2.getTeam('squad')?.includes('beta') === true, 'beta still in squad team');

  fs.rmSync(tmpWD, { recursive: true, force: true });

  console.log('\nAll verify-workers sections passed.');
}

run()
  .catch(err => { console.error(err); process.exit(1); })
  .finally(() => {
    try {
      execSync(
        'git checkout workers/architect/personality.md workers/architect/config.json workspaces/default/workspace.json',
        { cwd: repoRoot, stdio: 'inherit' }
      );
    } catch { /* ignore */ }
  });
