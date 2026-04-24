import * as fs from 'fs';
import * as path from 'path';

const MIGRATION_MSG = [
  '❌ Legacy worker layout detected.',
  '',
  'Codey now uses a global workers/ library at the repo root.',
  'Offending paths:',
  '{PATHS}',
  '',
  'To fix:',
  '  1. Move each worker to ./workers/<name>/personality.md + config.json',
  '  2. Remove the "workers" field from every workspace.json',
  '  3. (Optional) Declare teams in workspace.json under "teams": { "<name>": [...] }',
  '',
  'See docs/superpowers/specs/2026-04-19-global-worker-library-design.md',
].join('\n');

export function assertNoLegacyLayout(workspacesDir: string = './workspaces'): void {
  const problems: string[] = [];

  if (fs.existsSync(workspacesDir)) {
    for (const entry of fs.readdirSync(workspacesDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const wsPath = path.join(workspacesDir, entry.name);

      const legacyWorkersDir = path.join(wsPath, 'workers');
      if (fs.existsSync(legacyWorkersDir)) {
        problems.push(`  - ${legacyWorkersDir} (remove this folder)`);
      }

      const cfgPath = path.join(wsPath, 'workspace.json');
      if (fs.existsSync(cfgPath)) {
        try {
          const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
          if (cfg.workers !== undefined) {
            problems.push(`  - ${cfgPath} (remove the "workers" field)`);
          }
        } catch {
          // Malformed JSON is a different problem; let the normal loader surface it.
        }
      }
    }
  }

  if (problems.length > 0) {
    console.error(MIGRATION_MSG.replace('{PATHS}', problems.join('\n')));
    process.exit(1);
  }
}
