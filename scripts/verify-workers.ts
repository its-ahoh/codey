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

async function startServerForTest(): Promise<{ port: number; stop: () => Promise<void> }> {
  const port = 3100 + Math.floor(Math.random() * 500);
  const { ApiServer } = await import(path.join(repoRoot, 'dist/health.js'));
  const { ConfigManager } = await import(path.join(repoRoot, 'dist/config.js'));
  const { WorkerManager: WM } = await import(path.join(repoRoot, 'dist/workers.js'));
  const { WorkspaceManager: WSM } = await import(path.join(repoRoot, 'dist/workspace.js'));

  const cm = new ConfigManager();
  const wm = new WM('./workers');
  await wm.loadWorkers();
  const wsm = new WSM(wm, './workspaces');
  await wsm.switchWorkspace('default');

  const server = new ApiServer(port, () => ({
    status: 'healthy', uptime: 0, timestamp: new Date().toISOString(),
    channels: { telegram: false, discord: false, imessage: false },
    stats: { messagesProcessed: 0, activeConversations: 0, errors: 0 },
  }), cm);
  server.setWorkerRoutes({
    workerManager: wm,
    workspaceManager: wsm,
    workspacesDir: './workspaces',
    workersDir: './workers',
    agentFactory: null as any,
    getActiveAgent: () => 'claude-code' as any,
    getActiveModel: () => ({ provider: 'anthropic', model: 'test' } as any),
    getWorkingDir: () => process.cwd(),
  });
  await server.start();
  return { port, stop: () => server.stop() };
}

async function httpJson(port: number, method: string, pathUrl: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`http://localhost:${port}${pathUrl}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: any;
  try { json = JSON.parse(text); } catch { json = { _raw: text }; }
  return { status: res.status, json };
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

  section('8. API: GET /workers and /workspaces/:name/teams');
  const srv = await startServerForTest();
  try {
    const list = await httpJson(srv.port, 'GET', '/workers');
    expect(list.status === 200 && Array.isArray(list.json.workers), 'GET /workers returns worker array');
    expect(list.json.workers.some((w: any) => w.name === 'architect'), 'architect present in listing');

    const teams = await httpJson(srv.port, 'GET', '/workspaces/default/teams');
    expect(teams.status === 200 && teams.json.teams?.review?.length === 2, 'default team "review" has 2 members');

    section('9. API: PUT /workers/:name edits soul');
    const put = await httpJson(srv.port, 'PUT', '/workers/architect', { personality: { soul: 'Verifier-edited soul.' } });
    expect(put.status === 200 && put.json.worker.personality.soul.includes('Verifier-edited'), 'PUT updated the soul');

    // Restore soul so the test is idempotent (PUT-based restore)
    await httpJson(srv.port, 'PUT', '/workers/architect', { personality: { soul: 'Methodical, opinionated, allergic to premature abstraction. Always asks "what\'s the simplest thing that could possibly work?" before proposing a design.' } });

    section('10. API: PUT /workspaces/:name/teams with unknown worker');
    const bad = await httpJson(srv.port, 'PUT', '/workspaces/default/teams', { teams: { bad: ['nosuch'] } });
    expect(bad.status === 400 && Array.isArray(bad.json.unknown) && bad.json.unknown.includes('nosuch'), 'unknown worker rejected');

    section('11. API: PUT /workspaces/:name/teams accepts valid teams');
    const okTeams = await httpJson(srv.port, 'PUT', '/workspaces/default/teams', { teams: { review: ['architect', 'executor'] } });
    expect(okTeams.status === 200 && okTeams.json.teams.review.length === 2, 'valid teams accepted');
  } finally {
    // Belt-and-suspenders: git checkout guarantees on-disk files are clean after edits
    try { execSync('git checkout workers/architect/personality.md workers/architect/config.json workspaces/default/workspace.json', { cwd: repoRoot, stdio: 'pipe' }); } catch {}
    await srv.stop();
  }
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
