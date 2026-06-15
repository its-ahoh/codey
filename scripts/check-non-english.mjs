#!/usr/bin/env node
// Lint: flag non-English characters in source code. Emoji are allowed.
//
// "Non-English" = any letter outside the Latin script (CJK, Hangul, Kana,
// Cyrillic, Greek, Arabic, ...) plus CJK/fullwidth punctuation. Emoji and
// pictographs are symbols (not letters), so they pass; so do ordinary
// typographic marks like — “ ” → … and accented Latin (é, ü).
//
// Opt out on a single line with a trailing `lint-allow-non-english` comment.
// Run: npm run lint

import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative, extname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..');

// Directories to scan (relative to repo root).
const SCAN_DIRS = [
  'packages/core/src',
  'packages/gateway/src',
  'codey-mac/src',
  'codey-mac/electron',
  'scripts',
];

const EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'out', '.git']);
const ALLOW_MARKER = 'lint-allow-non-english';

// A letter (\p{L}) that is not in the Latin script, excluding emoji/pictographs
// (e.g. the emoji base "i" in info). Needs the RegExp `v` flag for set
// subtraction (Node 20+).
const NON_LATIN_LETTER = /[\p{L}--\p{Script=Latin}--\p{Extended_Pictographic}]/v;
// CJK symbols & punctuation (U+3000-U+303F) and fullwidth/halfwidth forms
// (U+FF00-U+FFEF). Written with \u escapes so this file stays pure ASCII.
const CJK_PUNCTUATION = new RegExp('[\\u3000-\\u303F\\uFF00-\\uFFEF]');

function isOffending(codePoint) {
  const ch = String.fromCodePoint(codePoint);
  return NON_LATIN_LETTER.test(ch) || CJK_PUNCTUATION.test(ch);
}

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return; // directory missing — skip silently
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      yield* walk(full);
    } else if (EXTENSIONS.has(extname(name))) {
      yield full;
    }
  }
}

const violations = [];

for (const dir of SCAN_DIRS) {
  for (const file of walk(join(ROOT, dir))) {
    const text = readFileSync(file, 'utf8');
    const lines = text.split(/\r?\n/);
    lines.forEach((line, i) => {
      if (line.includes(ALLOW_MARKER)) return;
      let col = 0;
      for (const ch of line) {
        col += 1;
        if (isOffending(ch.codePointAt(0))) {
          violations.push({
            file: relative(ROOT, file),
            line: i + 1,
            col,
            ch,
            snippet: line.trim().slice(0, 100),
          });
        }
      }
    });
  }
}

if (violations.length === 0) {
  console.log('✓ No non-English characters found (emoji are allowed).');
  process.exit(0);
}

console.error(`✗ Found ${violations.length} non-English character(s):\n`);
for (const v of violations) {
  console.error(`  ${v.file}:${v.line}:${v.col}  "${v.ch}"  ${v.snippet}`);
}
console.error(
  '\nUse English only. Emoji are fine. To allow a specific line on purpose, ' +
    `add a "${ALLOW_MARKER}" comment to it.`,
);
process.exit(1);
