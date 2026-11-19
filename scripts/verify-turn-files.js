// Live check of the turnFiles undo ledger: an in-process gateway (no app),
// the real `claude` CLI, a throwaway git repo and CODEY_HOME. Spends a few
// small model calls. Build core + gateway first, then:
//   node scripts/verify-turn-files.js
const path = require('path'), fs = require('fs'), os = require('os'), cp = require('child_process');
const ROOT = path.resolve(__dirname, '..');
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'tf-cwd-')));
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-home-'));
const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tf-repo-')));
process.env.CODEY_HOME = home;
process.env.PATH = `${os.homedir()}/.local/bin:${process.env.PATH}`;
const git = (...a) => cp.execFileSync('git', a, { cwd: repo, encoding: 'utf8' }).trim();
const blob = (f) => fs.existsSync(path.join(repo, f)) ? git('hash-object', '-w', f) : 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391';
git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
fs.writeFileSync(path.join(repo, 'b.txt'), 'b committed\n');
fs.writeFileSync(path.join(repo, 'c.txt'), 'c committed\n');
fs.writeFileSync(path.join(repo, 'd.txt'), 'd committed\n');
git('add', '.'); git('commit', '-qm', 'init');

(async () => {
  const { Codey } = require(path.join(ROOT, 'packages/gateway/dist/gateway.js'));
  const gw = new Codey({
    port: 3199, channels: {}, defaultAgent: 'claude-code',
    agents: { 'claude-code': { enabled: true, provider: 'anthropic' } },
    rateLimitMs: 0, planner: { enabled: false }, memory: { enabled: false, autoExtract: false },
    context: { ttlMinutes: 60 },
  });
  const wsDir = path.join(gw.workspaceManager.getWorkspacesRoot(), 'tf');
  fs.mkdirSync(wsDir, { recursive: true });
  fs.writeFileSync(path.join(wsDir, 'workspace.json'), JSON.stringify({ workingDir: repo }));
  const chat = await gw.createChat({ workspaceName: 'tf', title: 'tf', agent: 'claude-code' });
  gw.chatManager.setWorkingDirOverride(chat.id, repo);
  const sink = () => {};
  const run = async (label, prompt) => {
    const t0 = Date.now();
    const r = await gw.sendToChat(chat.id, prompt, sink);
    console.log(`\n### ${label} (${Math.round((Date.now() - t0) / 1000)}s) error=${r.error ?? 'none'}`);
    const c = gw.chatManager.get(chat.id);
    const u = [...c.messages].reverse().find(m => m.role === 'user');
    return u?.turnFiles ?? [];
  };
  const show = (tf) => ' ' + JSON.stringify(tf.map(e => ({ f: path.basename(e.path), before: e.before?.slice(0, 8) ?? '(none)', after: e.after.slice(0, 8) })));
  const results = [];
  const check = (name, ok) => { results.push([name, ok]); console.log(ok ? 'PASS' : 'FAIL', name); };
  const pre = { b: blob('b.txt'), c: null, d: blob('d.txt'), empty: blob('nope') };

  // 1. Write a new file, then Edit it, in one turn.
  let tf = await run('Write + Edit new file', 'Use the Write tool to create a.txt containing exactly "one". Then use the Edit tool to change "one" to "two". Do not use the shell. Reply "done".');
  console.log(show(tf));
  let a = tf.find(e => e.path.endsWith('/a.txt'));
  check('a.txt recorded once', tf.filter(e => e.path.endsWith('/a.txt')).length === 1);
  check('a.txt before = empty (new file)', a?.before === pre.empty);
  check('a.txt after = disk', a?.after === blob('a.txt'));

  // 2. Edit a clean committed file.
  tf = await run('Edit committed file', 'Use the Edit tool to change "b committed" to "b edited" in b.txt. Do not use the shell. Reply "done".');
  console.log(show(tf));
  let b = tf.find(e => e.path.endsWith('/b.txt'));
  check('b.txt before = HEAD', b?.before === pre.b);
  check('b.txt after = disk', b?.after === blob('b.txt'));
  check('turn 2 does not list a.txt', !tf.some(e => e.path.endsWith('/a.txt')));

  // 3. Dirty file (uncommitted edit made outside the agent), then a shell append.
  fs.writeFileSync(path.join(repo, 'c.txt'), 'c dirty by user\n');
  pre.c = blob('c.txt');
  tf = await run('Shell append to dirty file', 'Run this exact shell command with the Bash tool: echo appended >> c.txt   Then reply "done".');
  console.log(show(tf));
  let c = tf.find(e => e.path.endsWith('/c.txt'));
  check('c.txt before = dirty content (not HEAD)', c?.before === pre.c);
  check('c.txt after = disk', c?.after === blob('c.txt'));

  // 4. Shell heredoc interpreter write to a clean file.
  tf = await run('Python heredoc write', "Run this exact command with the Bash tool:\npython3 - <<'PY'\nopen('d.txt','w').write('d by python\\n')\nPY\nThen reply \"done\".");
  console.log(show(tf));
  let d = tf.find(e => e.path.endsWith('/d.txt'));
  check('d.txt before = HEAD', d?.before === pre.d);
  check('d.txt after = disk', d?.after === blob('d.txt'));

  // 5. Stopped turn: ledger parks on the chat and folds into the next turn.
  const preE = pre.empty;
  const p = gw.sendToChat(chat.id, 'Use the Write tool to create e.txt containing "e1". Then run `sleep 120` with the Bash tool. Then reply "done".', sink);
  const deadline = Date.now() + 120000;
  while (!fs.existsSync(path.join(repo, 'e.txt')) && Date.now() < deadline) await new Promise(r => setTimeout(r, 500));
  await new Promise(r => setTimeout(r, 3000));
  console.log('\n### stop', gw.stopChat(chat.id));
  await p.catch(() => {});
  const stray = gw.chatManager.get(chat.id).strayTurnFiles ?? [];
  console.log('stray', show(stray));
  check('stopped turn parked e.txt', stray.some(e => e.path.endsWith('/e.txt') && e.before === preE));
  tf = await run('Turn after stop', 'Use the Edit tool to change "e1" to "e2" in e.txt. Do not use the shell. Reply "done".');
  console.log(show(tf));
  let e = tf.find(x => x.path.endsWith('/e.txt'));
  check('e.txt before = before the stopped turn (empty)', e?.before === preE);
  check('e.txt after = disk', e?.after === blob('e.txt'));
  check('stray cleared', !(gw.chatManager.get(chat.id).strayTurnFiles?.length));

  // Every recorded blob must exist in git.
  const all = gw.chatManager.get(chat.id).messages.flatMap(m => m.turnFiles ?? []);
  const missing = all.flatMap(x => [x.before, x.after]).filter(Boolean).filter(id => { try { git('cat-file', '-e', id); return false; } catch { return true; } });
  check('all ledger blobs exist in git', missing.length === 0);

  const failed = results.filter(r => !r[1]).length;
  console.log(`\n${results.length - failed}/${results.length} passed. repo=${repo} home=${home}`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
