import * as assert from 'assert';

const RE = /\/team\s+(\w+)(?:\s+(--all))?\s+(?!--all\s*$)(.+)/i;

function parse(text: string) {
  const m = text.match(RE);
  if (!m) return null;
  return { name: m[1], forceAll: m[2] === '--all', task: m[3] };
}

assert.deepStrictEqual(parse('/team review do thing'),
  { name: 'review', forceAll: false, task: 'do thing' });
assert.deepStrictEqual(parse('/team review --all do thing'),
  { name: 'review', forceAll: true, task: 'do thing' });
assert.deepStrictEqual(parse('/team review --all   multi word task'),
  { name: 'review', forceAll: true, task: 'multi word task' });
assert.strictEqual(parse('/team'), null);
assert.deepStrictEqual(parse('/team review --all'), null,
  'cannot match without task');

console.log('OK gateway-team-regex');
