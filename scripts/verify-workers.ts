import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';

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
  section('1. Global library loads');
  const { WorkerManager } = await import(path.join(repoRoot, 'dist/workers.js'));
  const wm = new WorkerManager('./workers');
  await wm.loadWorkers();
  expect(wm.hasWorker('architect'), 'architect exists');
  expect(wm.hasWorker('executor'), 'executor exists');
  expect(wm.getWorker('ARCHITECT')?.config.codingAgent === 'claude-code', 'architect agent is claude-code');

  section('2. Unknown worker lookup returns undefined');
  expect(wm.getWorker('nosuch') === undefined, 'nosuch returns undefined');

  section('3. Missing config.json is skipped');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-workers-'));
  fs.mkdirSync(path.join(tmpDir, 'broken'));
  fs.writeFileSync(path.join(tmpDir, 'broken/personality.md'), '# Worker: broken\n');
  fs.mkdirSync(path.join(tmpDir, 'ok'));
  fs.writeFileSync(path.join(tmpDir, 'ok/personality.md'), '# Worker: ok\n');
  fs.writeFileSync(path.join(tmpDir, 'ok/config.json'), JSON.stringify({ codingAgent: 'claude-code', model: 'm', tools: [] }));
  const wm2 = new WorkerManager(tmpDir);
  await wm2.loadWorkers();
  expect(!wm2.hasWorker('broken'), 'broken worker skipped (no config.json)');
  expect(wm2.hasWorker('ok'), 'ok worker loaded');
  fs.rmSync(tmpDir, { recursive: true, force: true });

  section('4. Startup guard fires on legacy workers/ folder');
  const fakeWs = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-legacy-'));
  fs.mkdirSync(path.join(fakeWs, 'bad/workers'), { recursive: true });
  fs.writeFileSync(path.join(fakeWs, 'bad/workspace.json'), JSON.stringify({ workingDir: './' }));
  try {
    execSync(
      `node -e "require('${path.join(repoRoot, 'dist/startup-guard.js')}').assertNoLegacyLayout('${fakeWs}')"`,
      { stdio: 'pipe' }
    );
    expect(false, 'guard should exit non-zero for legacy workers/ folder');
  } catch (err: any) {
    const out = (err.stderr || err.stdout || '').toString();
    expect(out.includes('Legacy worker layout detected'), 'guard message printed');
  }
  fs.rmSync(fakeWs, { recursive: true, force: true });

  section('5. Startup guard fires on legacy workers field');
  const fakeWs2 = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-legacy2-'));
  fs.mkdirSync(path.join(fakeWs2, 'bad'), { recursive: true });
  fs.writeFileSync(path.join(fakeWs2, 'bad/workspace.json'), JSON.stringify({ workingDir: './', workers: {} }));
  try {
    execSync(
      `node -e "require('${path.join(repoRoot, 'dist/startup-guard.js')}').assertNoLegacyLayout('${fakeWs2}')"`,
      { stdio: 'pipe' }
    );
    expect(false, 'guard should exit non-zero for legacy workers field');
  } catch (err: any) {
    const out = (err.stderr || err.stdout || '').toString();
    expect(out.includes('Legacy worker layout detected'), 'guard message printed');
  }
  fs.rmSync(fakeWs2, { recursive: true, force: true });

  section('6. Current repo passes the guard');
  try {
    execSync(
      `node -e "require('${path.join(repoRoot, 'dist/startup-guard.js')}').assertNoLegacyLayout('./workspaces')"`,
      { stdio: 'pipe' }
    );
    expect(true, 'real ./workspaces passes the guard');
  } catch (err: any) {
    const out = (err.stderr || err.stdout || '').toString();
    expect(false, `real ./workspaces failed the guard:\n${out}`);
  }

  section('7. Default workspace teams validate');
  const { WorkspaceManager } = await import(path.join(repoRoot, 'dist/workspace.js'));
  const wsm = new WorkspaceManager(wm, './workspaces');
  await wsm.switchWorkspace('default');
  const review = wsm.getTeam('review');
  expect(Array.isArray(review) && review!.length === 2, 'default workspace has review team with 2 members');
  expect(wsm.getTeam('nosuch') === undefined, 'nonexistent team returns undefined');
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
