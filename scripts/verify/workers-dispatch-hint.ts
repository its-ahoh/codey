import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as assert from 'assert';
import { WorkerManager } from '../../packages/core/src/workers';

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codey-verify-'));
  try {
    const wDir = path.join(tmp, 'workers');
    for (const n of ['with-hint', 'no-hint', 'long-role', 'whitespace-hint', 'empty-hint']) {
      fs.mkdirSync(path.join(wDir, n), { recursive: true });
    }

    fs.writeFileSync(path.join(wDir, 'with-hint', 'personality.md'),
      '# with-hint\n\n## Role\nIgnored when hint present\n\n## Soul\nx\n\n## Instructions\ny\n');
    fs.writeFileSync(path.join(wDir, 'with-hint', 'config.json'),
      JSON.stringify({ codingAgent: 'claude-code', model: 'm', tools: [], dispatchHint: '  Reviews PRs  ' }));

    fs.writeFileSync(path.join(wDir, 'no-hint', 'personality.md'),
      '# no-hint\n\n## Role\nDesigns systems\nMore detail on next line\n\n## Soul\nx\n');
    fs.writeFileSync(path.join(wDir, 'no-hint', 'config.json'),
      JSON.stringify({ codingAgent: 'claude-code', model: 'm', tools: [] }));

    const longRole = 'A'.repeat(200);
    fs.writeFileSync(path.join(wDir, 'long-role', 'personality.md'),
      `# long-role\n\n## Role\n${longRole}\n`);
    fs.writeFileSync(path.join(wDir, 'long-role', 'config.json'),
      JSON.stringify({ codingAgent: 'claude-code', model: 'm', tools: [] }));

    fs.writeFileSync(path.join(wDir, 'whitespace-hint', 'personality.md'),
      '# whitespace-hint\n\n## Role\nFallback used\n');
    fs.writeFileSync(path.join(wDir, 'whitespace-hint', 'config.json'),
      JSON.stringify({ codingAgent: 'claude-code', model: 'm', tools: [], dispatchHint: '   ' }));

    fs.writeFileSync(path.join(wDir, 'empty-hint', 'personality.md'),
      '# empty-hint\n\n## Role\nFallback used\n');
    fs.writeFileSync(path.join(wDir, 'empty-hint', 'config.json'),
      JSON.stringify({ codingAgent: 'claude-code', model: 'm', tools: [], dispatchHint: '' }));

    const wm = new WorkerManager(wDir);
    await wm.loadWorkers();

    assert.strictEqual(wm.getDispatchHint('with-hint'), 'Reviews PRs', 'trims and uses dispatchHint');
    assert.strictEqual(wm.getDispatchHint('no-hint'), 'Designs systems', 'falls back to role first line');
    const long = wm.getDispatchHint('long-role');
    assert.strictEqual(long.length, 120, 'truncates long role to 120 chars');
    assert.ok(long.endsWith('...'), 'truncated value ends with ellipsis');
    assert.strictEqual(wm.getDispatchHint('missing'), '', 'unknown worker returns empty string');
    assert.strictEqual(wm.getDispatchHint('whitespace-hint'), 'Fallback used', 'whitespace-only hint falls through to role');
    assert.strictEqual(wm.getDispatchHint('empty-hint'), 'Fallback used', 'empty-string hint falls through to role');

    console.log('OK workers-dispatch-hint');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
main().catch(e => { console.error(e); process.exit(1); });
