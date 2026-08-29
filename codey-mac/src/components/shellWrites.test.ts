import { describe, it, expect } from 'vitest'
import { parseShellWriteTargets, shellCommandText } from './shellWrites'

describe('shellCommandText', () => {
  it('reads a string command', () => {
    expect(shellCommandText({ command: 'ls -la' })).toBe('ls -la')
  })

  it('joins codex argv arrays', () => {
    expect(shellCommandText({ command: ['bash', '-lc', 'echo hi'] })).toBe('bash -lc echo hi')
  })

  it('returns empty for a command-less input', () => {
    expect(shellCommandText(undefined)).toBe('')
    expect(shellCommandText({ file_path: '/tmp/a' })).toBe('')
  })
})

describe('parseShellWriteTargets', () => {
  it('finds truncating and appending redirects', () => {
    expect(parseShellWriteTargets('echo hi > src/a.ts')).toEqual(['src/a.ts'])
    expect(parseShellWriteTargets('echo hi >> src/a.ts')).toEqual(['src/a.ts'])
    expect(parseShellWriteTargets('echo hi>src/a.ts')).toEqual(['src/a.ts'])
  })

  it('ignores stderr plumbing and /dev sinks', () => {
    expect(parseShellWriteTargets('npm test 2>&1 | head')).toEqual([])
    expect(parseShellWriteTargets('grep x f.ts 2>/dev/null')).toEqual([])
  })

  it('does not treat an input redirect as a write', () => {
    expect(parseShellWriteTargets('wc -l < src/a.ts')).toEqual([])
  })

  it('ignores > inside a heredoc body', () => {
    const cmd = [
      "cat > src/a.ts <<'EOF'",
      'const gt = a > b',
      'echo nope > /tmp/decoy',
      'EOF',
      'echo done',
    ].join('\n')
    expect(parseShellWriteTargets(cmd)).toEqual(['src/a.ts'])
  })

  it('handles in-place sed on both BSD and GNU forms', () => {
    expect(parseShellWriteTargets("sed -i '' 's/a/b/' src/a.ts")).toEqual(['src/a.ts'])
    expect(parseShellWriteTargets("sed -i 's/a/b/' src/a.ts src/b.ts")).toEqual(['src/a.ts', 'src/b.ts'])
    expect(parseShellWriteTargets("sed -i.bak 's/a/b/' src/a.ts")).toEqual(['src/a.ts'])
  })

  it('leaves a non-in-place sed alone', () => {
    expect(parseShellWriteTargets("sed -n '1,5p' src/a.ts")).toEqual([])
  })

  it('reads perl -pi -e targets past the script', () => {
    expect(parseShellWriteTargets("perl -pi -e 's/a/b/' src/a.ts")).toEqual(['src/a.ts'])
  })

  it('takes every argument for rm/touch/tee', () => {
    expect(parseShellWriteTargets('rm -f a.ts b.ts')).toEqual(['a.ts', 'b.ts'])
    expect(parseShellWriteTargets('touch new.ts')).toEqual(['new.ts'])
    expect(parseShellWriteTargets('echo x | tee -a log.txt')).toEqual(['log.txt'])
  })

  it('takes only the destination for cp/mv', () => {
    expect(parseShellWriteTargets('cp src/a.ts src/b.ts')).toEqual(['src/b.ts'])
    expect(parseShellWriteTargets('mv old.ts new.ts')).toEqual(['new.ts'])
  })

  it('splits compound commands', () => {
    expect(parseShellWriteTargets('npm run build && echo ok > out.log; rm tmp.txt'))
      .toEqual(['out.log', 'tmp.txt'])
  })

  it('steps past sudo and env prefixes', () => {
    expect(parseShellWriteTargets('sudo rm /etc/thing.conf')).toEqual(['/etc/thing.conf'])
    expect(parseShellWriteTargets('FOO=1 touch a.ts')).toEqual(['a.ts'])
  })

  it('skips unexpanded variables and globs', () => {
    expect(parseShellWriteTargets('rm -rf $TMPDIR/x')).toEqual([])
    expect(parseShellWriteTargets('rm -f dist/*.js')).toEqual([])
  })

  it('unquotes paths with spaces', () => {
    expect(parseShellWriteTargets('touch "my file.ts"')).toEqual(['my file.ts'])
  })

  it('dedupes repeats', () => {
    expect(parseShellWriteTargets('echo a > f.ts; echo b >> f.ts')).toEqual(['f.ts'])
  })

  it('finds nothing in read-only commands', () => {
    expect(parseShellWriteTargets('git status')).toEqual([])
    expect(parseShellWriteTargets('grep -rn foo src/ | head -20')).toEqual([])
  })
})
