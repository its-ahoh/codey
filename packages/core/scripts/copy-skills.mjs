// `tsc` only emits JavaScript, so the managed skills' markdown would never
// reach `dist/`. Copy it next to the compiled code, where browser-skill.ts
// resolves it from `__dirname/../skills`.
import { cpSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkg = dirname(dirname(fileURLToPath(import.meta.url)));
const from = join(pkg, 'src', 'skills');
const to = join(pkg, 'dist', 'skills');

if (!existsSync(from)) {
  console.error(`copy-skills: ${from} is missing`);
  process.exit(1);
}
cpSync(from, to, { recursive: true });
